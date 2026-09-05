import { WorkOS } from '@workos-inc/node';

export interface Env {
  WORKOS_API_KEY: string;
  WORKOS_CLIENT_ID: string;
  WORKOS_COOKIE_PASSWORD: string;
}

export type { Env as AuthEnv };

/**
 * Invariant 3: the session is `{user_id, organization_id}`. Workspace is NOT in it.
 *
 * Slack put the workspace in the session token, it became their shard key, and they spent
 * years unwinding it. Workspace is navigation state, validated per request against
 * workspace_memberships.
 */
export interface Session {
  userId: string;
  organizationId: string | null;
  sessionId: string;
  email: string;
}

export const COOKIE = 'relay_session';

export const workos = (env: Env) =>
  new WorkOS(env.WORKOS_API_KEY, { clientId: env.WORKOS_CLIENT_ID });

/**
 * Derived from the incoming request rather than configured, so it cannot drift from where
 * the app is actually being used. In development that is the Vite origin, because the dev
 * server proxies here without rewriting Host — the same origin the browser sees, which is
 * also true in production.
 */
export const redirectUri = (request: Request) => new URL('/auth/callback', request.url).toString();

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/**
 * The sealed session, from wherever this surface carries it. The browser is same-origin
 * with the API and sends a cookie. The desktop renderer runs on a local origin, so it is
 * cross-origin to the API and sends the same sealed value as a bearer instead of fighting
 * SameSite=None across a custom protocol.
 */
function sealedFrom(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim() || null;
  return cookieValue(request, COOKIE);
}

/**
 * The ONLY place a session is parsed — cookie or bearer. The shape proxy and the write
 * endpoint both call this; two implementations would drift, and the drift would be an
 * authorization bug.
 */
export async function unsealSession(request: Request, env: Env): Promise<Session | null> {
  const sealed = sealedFrom(request);
  if (!sealed) return null;

  try {
    const r = await workos(env).userManagement.authenticateWithSessionCookie({
      sessionData: sealed,
      cookiePassword: env.WORKOS_COOKIE_PASSWORD,
    });
    if (!r.authenticated) return null;
    return {
      userId: r.user.id,
      organizationId: r.organizationId ?? null,
      sessionId: r.sessionId,
      email: r.user.email,
    };
  } catch {
    return null;
  }
}

export function setSessionCookie(sealed: string, secure: boolean): string {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=604800'];
  if (secure) flags.push('Secure');
  return `${COOKIE}=${sealed}; ${flags.join('; ')}`;
}

export const clearSessionCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
