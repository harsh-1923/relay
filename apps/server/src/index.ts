import { handoff } from './auth/handoff';
import {
  clearOAuthCookie,
  clearSessionCookie,
  randomState,
  readOAuthCookie,
  redirectUri,
  setOAuthCookie,
  setSessionCookie,
  unsealSession,
  workos,
} from './auth/session';
import { handleWorkosWebhook, type Env } from './webhooks/workos';

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

    switch (url.pathname) {
      case '/auth/login': {
        const desktop = url.searchParams.get('surface') === 'desktop';
        // Desktop is PKCE: the shell mints the verifier and only ever sends its challenge,
        // so the code that comes back can be redeemed by nothing but that shell.
        const challenge = url.searchParams.get('challenge');
        if (desktop && !challenge) return json({ error: 'missing_challenge' }, 400);

        const state = randomState();
        // Two concrete calls rather than a conditional spread: the SDK types PKCE as a union
        // arm where challenge and method must be present together, not individually optional.
        const base = {
          provider: 'authkit',
          clientId: env.WORKOS_CLIENT_ID,
          redirectUri: redirectUri(request),
          state,
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
          const { sealedSession } = await um.authenticateWithCode({
            code: body.code,
            codeVerifier: body.verifier,
            clientId: env.WORKOS_CLIENT_ID,
            session: { sealSession: true, cookiePassword: env.WORKOS_COOKIE_PASSWORD },
          });
          return sealedSession ? json({ sealedSession }) : json({ error: 'no_session' }, 502);
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
        if (!u.refreshed) return json(u.session);
        if (request.headers.get('Authorization'))
          return json({ ...u.session, refreshedSession: u.refreshed });
        return json(u.session, 200, [setSessionCookie(u.refreshed, secure)]);
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
