import {
  clearSessionCookie,
  redirectUri,
  setSessionCookie,
  unsealSession,
  workos,
} from './auth/session';
import { handleWorkosWebhook, type Env } from './webhooks/workos';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const seeOther = (location: string, headers: HeadersInit = {}) =>
  new Response(null, { status: 303, headers: { Location: location, ...headers } });

/**
 * API only. The UI is apps/client — this server serves no HTML.
 *
 * In development the Vite dev server proxies /auth and /api here, so the browser is
 * same-origin with the API exactly as it is in production. That keeps the sealed cookie
 * behaving identically in both, rather than needing CORS and SameSite=None in dev only.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';

    switch (url.pathname) {
      case '/auth/login':
        return seeOther(
          workos(env).userManagement.getAuthorizationUrl({
            provider: 'authkit',
            clientId: env.WORKOS_CLIENT_ID,
            redirectUri: redirectUri(request),
          }),
        );

      case '/auth/callback': {
        const code = url.searchParams.get('code');
        if (!code) {
          const reason = url.searchParams.get('error_description') ?? 'no_code';
          return seeOther(`/sign-in?error=${encodeURIComponent(reason)}`);
        }
        try {
          const { sealedSession } = await workos(env).userManagement.authenticateWithCode({
            code,
            clientId: env.WORKOS_CLIENT_ID,
            session: { sealSession: true, cookiePassword: env.WORKOS_COOKIE_PASSWORD },
          });
          if (!sealedSession) return seeOther('/sign-in?error=no_session');
          return seeOther('/', { 'Set-Cookie': setSessionCookie(sealedSession, secure) });
        } catch (e) {
          const reason = e instanceof Error ? e.message : 'unknown';
          return seeOther(`/sign-in?error=${encodeURIComponent(reason)}`);
        }
      }

      case '/auth/logout': {
        const session = await unsealSession(request, env);
        const location = session
          ? workos(env).userManagement.getLogoutUrl({
              sessionId: session.sessionId,
              returnTo: url.origin,
            })
          : '/';
        return seeOther(location, { 'Set-Cookie': clearSessionCookie() });
      }

      // What every authorisation decision downstream keys off. A 401 is a normal answer.
      case '/auth/session': {
        const session = await unsealSession(request, env);
        return session ? json(session) : json({ error: 'unauthenticated' }, 401);
      }

      case '/webhooks/workos':
        if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
        return handleWorkosWebhook(request, env);

      default:
        return json({ error: 'not_found' }, 404);
    }
  },
};
