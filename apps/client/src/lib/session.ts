import { useCallback, useEffect, useState } from 'react';

import { bridge, detectPlatform } from '@relay/sync/platform';

export interface Session {
  userId: string;
  organizationId: string | null;
  sessionId: string;
  email: string;
}

type State = { status: 'loading' } | { status: 'in'; session: Session } | { status: 'out' };

const platform = detectPlatform();

/**
 * The client never parses the session itself — it asks the server, which is the only place
 * `unsealSession()` runs. A 401 is a normal answer here, not an error.
 *
 * On the browser the session is a cookie and travels on its own. On desktop the shell
 * holds it (OS keychain) and the renderer sends it as a bearer, because the renderer's local
 * origin is cross-origin to the API.
 */
async function fetchSession(signal: AbortSignal): Promise<State> {
  const headers: Record<string, string> = {};
  if (platform.session === 'bearer') {
    const token = await bridge()?.auth.token();
    if (!token) return { status: 'out' };
    headers.Authorization = `Bearer ${token}`;
  }
  const r = await fetch('/auth/session', { headers, credentials: 'include', signal });
  if (!r.ok) return { status: 'out' };
  return { status: 'in', session: (await r.json()) as Session };
}

export function useSession(): State {
  const [state, setState] = useState<State>({ status: 'loading' });

  const refresh = useCallback((signal: AbortSignal) => {
    fetchSession(signal)
      .then(setState)
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setState({ status: 'out' });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    // Desktop sign-in completes in another application; the shell tells us when.
    const off = bridge()?.auth.onChange(() => refresh(controller.signal));
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
