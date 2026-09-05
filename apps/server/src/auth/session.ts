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

export interface Unsealed {
  session: Session;
  /**
   * Present when the access token had expired and the refresh token inside the seal was used
   * to mint a new one. The caller MUST hand this back to the surface — Set-Cookie for the
   * browser, in the JSON body for the desktop bearer — or the next request repeats the
   * refresh, and the one after that finds a refresh token WorkOS has already rotated away.
   */
  refreshed?: string;
}

export const COOKIE = 'relay_session';
const OAUTH_COOKIE = 'relay_oauth';

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

const toSession = (r: {
  user: { id: string; email: string };
  organizationId?: string;
  sessionId: string;
}): Session => ({
  userId: r.user.id,
  organizationId: r.organizationId ?? null,
  sessionId: r.sessionId,
  email: r.user.email,
});

/**
 * The ONLY place a session is parsed — cookie or bearer. The shape proxy and the write
 * endpoint both call this; two implementations would drift, and the drift would be an
 * authorization bug.
 *
 * Access tokens are short-lived. An expired one is not a sign-out: the seal also carries a
 * refresh token, and this rotates both and returns the new seal for the caller to persist.
 */
export async function unsealSession(request: Request, env: Env): Promise<Unsealed | null> {
  const sealed = sealedFrom(request);
  if (!sealed) return null;

  const um = workos(env).userManagement;
  const cookiePassword = env.WORKOS_COOKIE_PASSWORD;

  try {
    const loaded = um.loadSealedSession({ sessionData: sealed, cookiePassword });
    const first = await loaded.authenticate();
    if (first.authenticated) return { session: toSession(first) };
    if (first.reason !== 'invalid_jwt') return null;

    const r = await loaded.refresh({ cookiePassword });
    if (!r.authenticated || !r.sealedSession) return null;

    // Re-read the new seal rather than trusting the refresh response's shape, so a
    // refreshed session is described by exactly the same code path as a fresh one.
    const again = await um
      .loadSealedSession({ sessionData: r.sealedSession, cookiePassword })
      .authenticate();
    if (!again.authenticated) return null;
    return { session: toSession(again), refreshed: r.sealedSession };
  } catch {
    return null;
  }
}

// ── cookies ───────────────────────────────────────────────────────────────────

export function setSessionCookie(sealed: string, secure: boolean): string {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=604800'];
  if (secure) flags.push('Secure');
  return `${COOKIE}=${sealed}; ${flags.join('; ')}`;
}

export const clearSessionCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// ── the OAuth round trip ──────────────────────────────────────────────────────

export type Surface = 'browser' | 'desktop';

export interface OAuthState {
  state: string;
  surface: Surface;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** CSRF nonce. Random per attempt, held in a short-lived cookie, checked on the way back. */
export const randomState = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Lives only for the round trip and only under /auth. The desktop flow runs in the system
 * browser, and both legs happen there too, so the same cookie protects both surfaces.
 */
export function setOAuthCookie(payload: OAuthState, secure: boolean): string {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/auth', 'Max-Age=600'];
  if (secure) flags.push('Secure');
  return `${OAUTH_COOKIE}=${encodeURIComponent(JSON.stringify(payload))}; ${flags.join('; ')}`;
}

export function readOAuthCookie(request: Request): OAuthState | null {
  const raw = cookieValue(request, OAUTH_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<OAuthState>;
    if (typeof parsed.state !== 'string') return null;
    if (parsed.surface !== 'browser' && parsed.surface !== 'desktop') return null;
    return { state: parsed.state, surface: parsed.surface };
  } catch {
    return null;
  }
}

export const clearOAuthCookie = () =>
  `${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0`;
