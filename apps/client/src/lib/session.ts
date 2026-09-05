import { useEffect, useState } from 'react';

export interface Session {
  userId: string;
  organizationId: string | null;
  sessionId: string;
  email: string;
}

type State = { status: 'loading' } | { status: 'in'; session: Session } | { status: 'out' };

/**
 * The client never parses the session itself — it asks the server, which is the only place
 * `unsealSession()` runs. A 401 is a normal answer here, not an error.
 */
export function useSession(): State {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/auth/session', { credentials: 'include', signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) return setState({ status: 'out' });
        setState({ status: 'in', session: (await r.json()) as Session });
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== 'AbortError') setState({ status: 'out' });
      });
    return () => controller.abort();
  }, []);

  return state;
}
