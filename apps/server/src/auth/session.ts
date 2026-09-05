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
 * The ONLY place the session cookie is parsed. The shape proxy and the write endpoint both
 * call this — two implementations would drift, and the drift would be an authorization bug.
 */
export async function unsealSession(request: Request, env: Env): Promise<Session | null> {
  const sealed = cookieValue(request, COOKIE);
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
