import { useCallback, useEffect, useState } from 'react';

import { bridge, detectPlatform } from '@relay/sync/platform';

export interface Session {
  userId: string;
  organizationId: string | null;
  sessionId: string;
  email: string;
}

export type SessionState =
  { status: 'loading' } | { status: 'in'; session: Session } | { status: 'out'; error?: string };

const platform = detectPlatform();

/**
 * The client never parses the session itself — it asks the server, which is the only place
 * `unsealSession()` runs. A 401 is a normal answer here, not an error.
 *
 * On the browser the session is a cookie and travels on its own; a refreshed one comes back
 * as Set-Cookie and the browser keeps it. On desktop the shell holds it (OS keychain), the
 * renderer sends it as a bearer, and a refreshed one comes back in the body for the renderer
 * to hand to the shell — otherwise the next request would repeat the refresh against a
 * refresh token WorkOS has already rotated away.
 */
async function fetchSession(signal: AbortSignal): Promise<SessionState> {
  const headers: Record<string, string> = {};
  const b = bridge();
  if (platform.session === 'bearer') {
    const token = await b?.auth.token();
    if (!token) return { status: 'out' };
    headers.Authorization = `Bearer ${token}`;
  }

  const r = await fetch('/auth/session', { headers, credentials: 'include', signal });
  if (!r.ok) return { status: 'out' };

  const { refreshedSession, ...session } = (await r.json()) as Session & {
    refreshedSession?: string;
  };
  if (refreshedSession && b) await b.auth.store(refreshedSession);
  return { status: 'in', session };
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const refresh = useCallback((signal: AbortSignal, error?: string) => {
    fetchSession(signal)
      .then((next) => setState(next.status === 'out' && error ? { status: 'out', error } : next))
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setState({ status: 'out', error });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    // Desktop sign-in completes in another application; the shell tells us how it went.
    const off = bridge()?.auth.onChange(({ error }) => refresh(controller.signal, error));
    return () => {
      controller.abort();
      off?.();
    };
  }, [refresh]);

  return state;
}

/** Starts sign-in the way this surface needs it. */
export function signIn() {
  const b = bridge();
  if (b) void b.auth.signIn();
  else window.location.href = '/auth/login';
}

export function signOut() {
  const b = bridge();
  if (b) void b.auth.signOut();
  else window.location.href = '/auth/logout';
}

/** The server's callback reports failures as `?error=` on the sign-in page. */
export function describeError(code: string | null | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 'state_mismatch':
      return "That sign-in didn't start from this browser, so it was rejected. Try again.";
    case 'no_code':
      return 'The identity provider returned without completing sign-in.';
    case 'no_session':
    case 'exchange_failed':
      return 'Sign-in could not be completed. Try again.';
    default:
      return code;
  }
}
