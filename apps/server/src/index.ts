import {
  clearSessionCookie,
  redirectUri,
  setSessionCookie,
  unsealSession,
  workos,
  type Env,
} from './auth/session';
import { failed, signedIn, signedOut } from './page';

const html = (body: string, headers: HeadersInit = {}) =>
  new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

const seeOther = (location: string, headers: HeadersInit = {}) =>
  new Response(null, { status: 303, headers: { Location: location, ...headers } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';

    switch (url.pathname) {
      case '/': {
        const session = await unsealSession(request, env);
        return html(session ? signedIn(session) : signedOut());
      }

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
          const reason =
            url.searchParams.get('error_description') ?? 'No authorization code was returned.';
          return html(failed(reason), { 'Cache-Control': 'no-store' });
        }
        try {
          const { sealedSession } = await workos(env).userManagement.authenticateWithCode({
            code,
            clientId: env.WORKOS_CLIENT_ID,
            session: { sealSession: true, cookiePassword: env.WORKOS_COOKIE_PASSWORD },
          });
          if (!sealedSession) return html(failed('WorkOS returned no sealed session.'));
          return seeOther('/', { 'Set-Cookie': setSessionCookie(sealedSession, secure) });
        } catch (e) {
          return html(failed(e instanceof Error ? e.message : 'Unknown error.'));
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

      // Shows exactly what every authorisation decision downstream will key off.
      case '/auth/session': {
        const session = await unsealSession(request, env);
        return new Response(JSON.stringify(session, null, 2), {
          status: session ? 200 : 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      default:
        return new Response('Not found', { status: 404 });
    }
  },
};
