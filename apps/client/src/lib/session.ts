import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { bridge, detectPlatform } from '@relay/sync/platform';

import { keys } from './query';

/** `canInvite`: whether this user runs the org — owner or admin. Decides if inviting is offered. */
export interface Session {
  userId: string;
  organizationId: string | null;
  sessionId: string;
  email: string;
  canInvite?: boolean;
}

/** An organization the user can switch into, labelled by its default workspace. */
export interface SwitchTarget {
  organizationId: string;
  name: string;
  workspaceId: string | null;
  roles: string[];
}

/** `pending`: desktop only, the browser is open and we are waiting for it to come back. */
export type SessionState =
  | { status: 'loading' }
  | { status: 'in'; session: Session }
  | { status: 'pending' }
  | { status: 'out'; error?: string };

/** A signed-in account. One email is one account. Desktop only. */
export interface Account {
  userId: string;
  email: string;
  active: boolean;
}

/**
 * `createWorkspace`: creates the org and its default workspace. Resolves to an error message, or null.
 * `workspaces`: everything this user can switch into. Empty until loaded.
 * `switchTo`: moves the session into another org. Resolves to an error message, or null.
 * `accounts`: signed-in accounts. Empty on the browser, which holds one session by construction.
 * `switchAccount`: becomes another signed-in account. Desktop only.
 * `addAccount`: signs in an additional account without signing out of this one. Desktop only.
 */
export interface SessionApi {
  state: SessionState;
  signIn: () => void;
  cancelSignIn: () => void;
  signOut: () => void;
  createWorkspace: (name: string) => Promise<string | null>;
  workspaces: SwitchTarget[];
  switchTo: (organizationId: string) => Promise<string | null>;
  accounts: Account[];
  switchAccount: (userId: string) => void;
  addAccount: () => void;
}

const platform = detectPlatform();

/**
 * Any authenticated request. On the browser the cookie travels on its own and a rotated seal
 * comes back as Set-Cookie; on desktop the seal is a bearer, and a rotated one comes back in
 * the body for the renderer to hand to the shell — otherwise the next request would repeat
 * the refresh against a token WorkOS has already rotated away.
 */
export async function authed(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const b = bridge();
  if (platform.session === 'bearer') {
    const token = await b?.auth.token();
    if (!token) return null;
    headers.set('Authorization', `Bearer ${token}`);
  }

  const r = await fetch(path, { ...init, headers, credentials: 'include' });
  const body: unknown = await r.json().catch(() => null);

  const refreshed = (body as { refreshedSession?: string } | null)?.refreshedSession;
  if (refreshed && b) await b.auth.store(refreshed);

  return { ok: r.ok, status: r.status, body };
}

/**
 * The client never parses the session itself — it asks the server, which is the only place
 * `unsealSession()` runs. A 401 is a normal answer, so it resolves to null rather than
 * throwing; a thrown error here would trigger retries against an endpoint behaving correctly.
 */
async function fetchSession(): Promise<Session | null> {
  const r = await authed('/auth/session');
  if (!r?.ok) return null;
  const { refreshedSession: _drop, ...session } = r.body as Session & {
    refreshedSession?: string;
  };
  return session;
}

export function useSession(): SessionApi {
  const qc = useQueryClient();
  /** Desktop sign-in happens in another application; this is the only genuinely local state. */
  const [pending, setPending] = useState(false);
  const [signInError, setSignInError] = useState<string | undefined>();

  const session = useQuery({
    queryKey: keys.session,
    queryFn: fetchSession,
    // The session is the one thing worth re-checking when the window regains focus: it may
    // have been signed out elsewhere, or its access token may have expired while away.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const accounts = useQuery({
    queryKey: keys.accounts,
    queryFn: async () => (await bridge()?.auth.accounts()) ?? [],
    // Nothing to hold on the browser: one cookie, one session.
    enabled: !!bridge(),
  });

  const workspaces = useQuery({
    queryKey: keys.workspaces,
    queryFn: async () => {
      const r = await authed('/auth/workspaces');
      if (!r?.ok) return [] as SwitchTarget[];
      return (r.body as { workspaces: SwitchTarget[] }).workspaces;
    },
    enabled: !!session.data,
  });

  // Sign-in completes in the system browser, so the shell is what tells us it finished.
  useEffect(() => {
    return bridge()?.auth.onChange(({ error }) => {
      setPending(false);
      setSignInError(error);
      // Every account-shaped thing may have moved: a new account added, the active one
      // changed, or one signed out.
      void qc.invalidateQueries();
    });
  }, [qc]);

  const signIn = useCallback(() => {
    const b = bridge();
    if (!b) return void (window.location.href = '/auth/login');
    // The window stays open while the browser does the work, so it has to say so — an
    // unchanged screen invites a second click, which would mint a new verifier and quietly
    // invalidate the tab already open.
    setSignInError(undefined);
    setPending(true);
    void b.auth.signIn();
  }, []);

  const cancelSignIn = useCallback(() => {
    void bridge()?.auth.cancelSignIn();
    setPending(false);
  }, []);

  const signOut = useCallback(() => {
    const b = bridge();
    if (b) void b.auth.signOut();
    else window.location.href = '/auth/logout';
  }, []);

  /** Switching account swaps the seal; the session and its orgs are then a different user's. */
  const switchAccount = useCallback((userId: string) => {
    void bridge()?.auth.switchAccount(userId);
  }, []);

  /** Same hosted flow as signing in — the shell adds rather than replaces. */
  const addAccount = useCallback(() => {
    setSignInError(undefined);
    void bridge()?.auth.signIn();
  }, []);

  const createWorkspace = useMutation({
    mutationFn: async (name: string) => {
      const r = await authed('/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r) return 'Not signed in.';
      if (r.ok) return null;

      const code = (r.body as { error?: string } | null)?.error;
      if (code === 'created_but_session_stale')
        return 'Workspace created. Sign in again to open it.';
      if (code === 'name_required') return 'Give the workspace a name.';
      return 'Could not create the workspace. Try again.';
    },
    // The session now carries an organization, and there is a workspace to list.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.session });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });

  /**
   * Switching re-issues the session rather than editing a claim — the target org may demand
   * a stronger authentication than this session has. A 409 means exactly that, and carries
   * where to go instead.
   */
  const switchTo = useMutation({
    mutationFn: async (organizationId: string) => {
      const r = await authed('/auth/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      if (!r) return 'Not signed in.';
      if (r.ok) return null;

      const body = r.body as { error?: string; reauth?: string } | null;
      if (r.status === 409 && body?.reauth) {
        // That organization enforces SSO. A full round trip through its IdP is the only way in.
        window.location.href = body.reauth;
        return null;
      }
      if (body?.error === 'not_a_member') return 'You are not a member of that workspace.';
      return 'Could not switch. Try again.';
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.session });
      void qc.invalidateQueries({ queryKey: keys.workspaces });
    },
  });

  const state: SessionState = session.isPending
    ? { status: 'loading' }
    : session.data
      ? { status: 'in', session: session.data }
      : pending
        ? { status: 'pending' }
        : { status: 'out', error: signInError };

  return {
    state,
    signIn,
    cancelSignIn,
    signOut,
    createWorkspace: createWorkspace.mutateAsync,
    workspaces: workspaces.data ?? [],
    switchTo: switchTo.mutateAsync,
    accounts: accounts.data ?? [],
    switchAccount,
    addAccount,
  };
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
