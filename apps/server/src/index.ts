import { handoff } from './auth/handoff';
import {
  canInvite,
  pendingInvitations,
  revokeInvitation,
  sendInvitation,
  INVITABLE_ROLES,
  type InvitableRole,
} from './auth/invitations';
import { createOrganizationForUser } from './auth/signup';
import { handleShape } from './shapes/index';
import {
  clearOAuthCookie,
  clearSessionCookie,
  randomState,
  readOAuthCookie,
  redirectUri,
  reissueForOrganization,
  setOAuthCookie,
  setSessionCookie,
  unsealSession,
  workos,
} from './auth/session';
import type { Env as InvitationEnv } from './auth/invitations';
import type { Env as SignupEnv } from './auth/signup';
import { db } from './db';
import { createWorkspace, isMemberOf, switchTargets } from './tenancy';
import { handleWorkosWebhook, type Env as WebhookEnv } from './webhooks/workos';
import type { Env as ShapeEnv } from './shapes/index';

type Env = WebhookEnv & SignupEnv & InvitationEnv & ShapeEnv;

const withCookies = (headers: Record<string, string>, cookies: string[]) => {
  const h = new Headers(headers);
  for (const c of cookies) h.append('Set-Cookie', c);
  return h;
};

const json = (body: unknown, status = 200, cookies: string[] = []) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: withCookies(
      { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      cookies,
    ),
  });

const seeOther = (location: string, cookies: string[] = []) =>
  new Response(null, { status: 303, headers: withCookies({ Location: location }, cookies) });

const failSignIn = (reason: string) =>
  seeOther(`/sign-in?error=${encodeURIComponent(reason)}`, [clearOAuthCookie()]);

/**
 * API only. The UI is apps/client — this server serves no HTML except the desktop handoff.
 *
 * In development the Vite dev server proxies /auth and /api here, so the browser is
 * same-origin with the API exactly as it is in production. That keeps the sealed cookie
 * behaving identically in both, rather than needing CORS and SameSite=None in dev only.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';
    const um = workos(env).userManagement;

    /**
     * `/shapes/:name` — the read path. A prefix rather than a case because the shape name is a
     * path segment, and it is matched against the registry in `packages/schema` rather than
     * against anything the client can invent.
     */
    if (url.pathname.startsWith('/shapes/')) {
      return handleShape(request, env, url.pathname.slice('/shapes/'.length));
    }

    switch (url.pathname) {
      case '/auth/login': {
        const desktop = url.searchParams.get('surface') === 'desktop';
        // Desktop is PKCE: the shell mints the verifier and only ever sends its challenge,
        // so the code that comes back can be redeemed by nothing but that shell.
        const challenge = url.searchParams.get('challenge');
        if (desktop && !challenge) return json({ error: 'missing_challenge' }, 400);

        // Set when the org switcher's refresh was rejected: the target enforces SSO, so the
        // user must be sent through that org's IdP rather than refreshed into it.
        const organizationId = url.searchParams.get('organization_id') ?? undefined;
        // Carried from the emailed accept link. AuthKit accepts the invitation as part of
        // sign-in, which is what makes the invitee an org member without a second step.
        const invitationToken = url.searchParams.get('invitation_token') ?? undefined;

        const state = randomState();
        // Two concrete calls rather than a conditional spread: the SDK types PKCE as a union
        // arm where challenge and method must be present together, not individually optional.
        const base = {
          provider: 'authkit',
          clientId: env.WORKOS_CLIENT_ID,
          redirectUri: redirectUri(request),
          state,
          ...(organizationId ? { organizationId } : {}),
          ...(invitationToken ? { invitationToken } : {}),
        };
        const location =
          desktop && challenge
            ? um.getAuthorizationUrl({
                ...base,
                codeChallenge: challenge,
                codeChallengeMethod: 'S256',
              })
            : um.getAuthorizationUrl(base);
        return seeOther(location, [
          setOAuthCookie({ state, surface: desktop ? 'desktop' : 'browser' }, secure),
        ]);
      }

      case '/auth/callback': {
        // The state must match what this browser was handed at /auth/login, or the code
        // was minted for someone else's attempt — a login CSRF. Nothing proceeds without it.
        const expected = readOAuthCookie(request);
        const state = url.searchParams.get('state');
        if (!expected || !state || state !== expected.state) return failSignIn('state_mismatch');

        const code = url.searchParams.get('code');
        if (!code) return failSignIn(url.searchParams.get('error_description') ?? 'no_code');

        // Desktop: do not exchange here. The shell holds the PKCE verifier, so only it can.
        if (expected.surface === 'desktop') {
          return new Response(handoff(code), {
            headers: withCookies(
              { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
              [clearOAuthCookie()],
            ),
          });
        }

        try {
          const { sealedSession } = await um.authenticateWithCode({
            code,
            clientId: env.WORKOS_CLIENT_ID,
            session: { sealSession: true, cookiePassword: env.WORKOS_COOKIE_PASSWORD },
          });
          if (!sealedSession) return failSignIn('no_session');
          return seeOther('/', [setSessionCookie(sealedSession, secure), clearOAuthCookie()]);
        } catch (e) {
          return failSignIn(e instanceof Error ? e.message : 'exchange_failed');
        }
      }

      // The desktop shell redeems the code the handoff page gave it, proving it holds the
      // verifier whose challenge went out with the authorize request.
      case '/auth/exchange': {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
        const body = (await request.json().catch(() => ({}))) as {
          code?: string;
          verifier?: string;
        };
        if (!body.code || !body.verifier) return json({ error: 'missing_code_or_verifier' }, 400);
        try {
          const { sealedSession, user } = await um.authenticateWithCode({
            code: body.code,
            codeVerifier: body.verifier,
            clientId: env.WORKOS_CLIENT_ID,
            session: { sealSession: true, cookiePassword: env.WORKOS_COOKIE_PASSWORD },
          });
          // The shell files seals by user, and a seal is opaque to it — only the server can
          // say who this one belongs to.
          return sealedSession
            ? json({ sealedSession, user: { id: user.id, email: user.email } })
            : json({ error: 'no_session' }, 502);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : 'exchange_failed' }, 401);
        }
      }

      // What every authorisation decision downstream keys off. A 401 is a normal answer.
      // If the access token was refreshed on the way, the new seal goes back to whichever
      // surface holds it: the cookie for the browser, the body for the desktop bearer.
      case '/auth/session': {
        const u = await unsealSession(request, env);
        if (!u) return json({ error: 'unauthenticated' }, 401);
        // Roles come from the mirror rather than the seal: WorkOS puts them in the access
        // token too, but a role change would then only appear on the next refresh.
        const session = {
          ...u.session,
          canInvite: u.session.organizationId
            ? await canInvite(env, u.session.userId, u.session.organizationId)
            : false,
        };
        if (!u.refreshed) return json(session);
        if (request.headers.get('Authorization'))
          return json({ ...u.session, refreshedSession: u.refreshed });
        return json(u.session, 200, [setSessionCookie(u.refreshed, secure)]);
      }

      /**
       * Creates the org and its default workspace, then re-issues the session into it — the
       * caller's current session has `organization_id: null` and nothing else would change
       * that. The new seal goes back the way `/auth/session` returns a refreshed one.
       */
      case '/auth/signup': {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

        const current = await unsealSession(request, env);
        if (!current) return json({ error: 'unauthenticated' }, 401);

        const { name } = (await request.json().catch(() => ({}))) as { name?: string };
        if (!name?.trim()) return json({ error: 'name_required' }, 400);

        try {
          const { organization, workspace } = await createOrganizationForUser(env, {
            userId: current.session.userId,
            name: name.trim(),
          });

          const reissued = await reissueForOrganization(request, env, organization.id);
          if (!reissued) {
            // The org exists and is usable; only the session did not move. Signing in again
            // picks it up, so say so rather than implying the workspace was not created.
            return json(
              { error: 'created_but_session_stale', organizationId: organization.id },
              202,
            );
          }

          const body = {
            ...reissued.session,
            workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
          };
          if (request.headers.get('Authorization')) {
            return json({ ...body, refreshedSession: reissued.sealed });
          }
          return json(body, 200, [setSessionCookie(reissued.sealed, secure)]);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : 'signup_failed' }, 502);
        }
      }

      /**
       * Every org this user can switch into, labelled by its default workspace. One row per
       * org membership; the UI never says "organization".
       */
      case '/auth/workspaces': {
        const u = await unsealSession(request, env);
        if (!u) return json({ error: 'unauthenticated' }, 401);

        /**
         * An additional workspace in the organization the session is already in.
         *
         * No WorkOS call: a workspace is ours, not theirs, and nothing upstream knows about
         * it. So no re-issued session either — the session already names this organization,
         * and workspace is navigation state rather than a claim (invariant 3).
         */
        if (request.method === 'POST') {
          const organizationId = u.session.organizationId;
          if (!organizationId) return json({ error: 'no_organization' }, 400);
          if (!(await canInvite(env, u.session.userId, organizationId))) {
            return json({ error: 'forbidden' }, 403);
          }
          const { name } = (await request.json().catch(() => ({}))) as { name?: string };
          if (!name?.trim()) return json({ error: 'name_required' }, 400);

          const workspace = await createWorkspace(db(env), {
            organizationId,
            userId: u.session.userId,
            name: name.trim(),
          });
          const created = { workspaceId: workspace.id, name: workspace.name };
          if (!u.refreshed) return json(created, 201);
          if (request.headers.get('Authorization'))
            return json({ ...created, refreshedSession: u.refreshed }, 201);
          return json(created, 201, [setSessionCookie(u.refreshed, secure)]);
        }

        const targets = await switchTargets(db(env), u.session.userId);
        const body = { current: u.session.organizationId, workspaces: targets };
        if (!u.refreshed) return json(body);
        if (request.headers.get('Authorization'))
          return json({ ...body, refreshedSession: u.refreshed });
        return json(body, 200, [setSessionCookie(u.refreshed, secure)]);
      }

      /**
       * Moves the session into another org. Switching re-issues rather than editing a claim,
       * because the target org's authentication requirements may differ from the current
       * session's — an org enforcing SSO will reject a session established by password, and
       * the only way in is a fresh round trip through its IdP.
       */
      case '/auth/switch': {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

        const u = await unsealSession(request, env);
        if (!u) return json({ error: 'unauthenticated' }, 401);

        const { organizationId } = (await request.json().catch(() => ({}))) as {
          organizationId?: string;
        };
        if (!organizationId) return json({ error: 'organization_required' }, 400);

        // Checked against our mirror, not WorkOS: same data, already local, and this must
        // not become a network round trip on a menu click.
        if (!(await isMemberOf(db(env), u.session.userId, organizationId))) {
          return json({ error: 'not_a_member' }, 403);
        }

        const reissued = await reissueForOrganization(request, env, organizationId);
        if (!reissued) {
          // Not an error: the org wants a stronger authentication than this session has.
          return json(
            { reauth: `/auth/login?organization_id=${encodeURIComponent(organizationId)}` },
            409,
          );
        }

        if (request.headers.get('Authorization')) {
          return json({ ...reissued.session, refreshedSession: reissued.sealed });
        }
        return json(reissued.session, 200, [setSessionCookie(reissued.sealed, secure)]);
      }

      /**
       * Invitations to this session's organization.
       *
       * WorkOS owns the invitation and sends the mail. What lands where is decided on
       * acceptance, by the role on the invitation, in the webhook handler.
       */
      case '/auth/invitations': {
        const u = await unsealSession(request, env);
        if (!u) return json({ error: 'unauthenticated' }, 401);

        const organizationId = u.session.organizationId;
        if (!organizationId) return json({ error: 'no_organization' }, 400);

        if (request.method === 'GET') {
          return json({ invitations: await pendingInvitations(env, organizationId) });
        }

        if (request.method === 'POST') {
          // Only someone who runs the org may add to it.
          if (!(await canInvite(env, u.session.userId, organizationId))) {
            return json({ error: 'forbidden' }, 403);
          }

          const body = (await request.json().catch(() => ({}))) as {
            email?: string;
            role?: string;
          };
          const email = body.email?.trim();
          if (!email) return json({ error: 'email_required' }, 400);

          const role = (body.role ?? 'member') as InvitableRole;
          if (!INVITABLE_ROLES.includes(role)) return json({ error: 'invalid_role' }, 400);

          try {
            return json(
              await sendInvitation(env, {
                email,
                organizationId,
                inviterUserId: u.session.userId,
                role,
              }),
              201,
            );
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : 'invite_failed' }, 502);
          }
        }

        if (request.method === 'DELETE') {
          if (!(await canInvite(env, u.session.userId, organizationId))) {
            return json({ error: 'forbidden' }, 403);
          }
          const { id } = (await request.json().catch(() => ({}))) as { id?: string };
          if (!id) return json({ error: 'id_required' }, 400);
          await revokeInvitation(env, id);
          return new Response(null, { status: 204 });
        }

        return json({ error: 'method_not_allowed' }, 405);
      }

      case '/auth/logout': {
        const u = await unsealSession(request, env);
        // Bearer callers hold the session themselves and just need it revoked upstream.
        if (request.headers.get('Authorization')) {
          if (u) await um.revokeSession({ sessionId: u.session.sessionId }).catch(() => undefined);
          return new Response(null, { status: 204 });
        }
        const location = u
          ? um.getLogoutUrl({ sessionId: u.session.sessionId, returnTo: url.origin })
          : '/';
        return seeOther(location, [clearSessionCookie()]);
      }

      case '/webhooks/workos':
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        return handleWorkosWebhook(request, env);

      default:
        return json({ error: 'not_found' }, 404);
    }
  },
};
