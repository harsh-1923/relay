/**
 * Which account's local database to open, remembered across launches.
 *
 * **This is not a credential.** It is `{userId, organizationId}` — the same two ids that
 * appear in every URL-adjacent piece of state — and holding it grants nothing. The secret is
 * the sealed session, which stays in the OS keychain on desktop and in an HttpOnly cookie in
 * the browser, and neither is reachable from here.
 *
 * It exists because asking the server who you are is a *network* round trip, and gating the
 * display of already-synced local data on a network round trip is the thing that made the app
 * useless offline: the messages were sitting in SQLite while the shell rendered an empty
 * frame, because `/auth/session` had not answered and so no database was ever opened.
 *
 * The live session still runs and still wins. This only decides which database to open first;
 * if the session resolves to a different account the key changes, and the provider rebuilds
 * against the right one.
 *
 * Cleared on sign-out and on account switch, so a signed-out device does not reopen the
 * previous account's rows. The rows themselves stay in OPFS until that account signs in
 * again — worth revisiting when there is a "sign out and forget this device" affordance.
 */

const KEY = 'relay.identity';

/**
 * Structurally the fields of `Session` that are not secret, declared here rather than imported
 * so this module does not depend on `session.ts` — which depends on it.
 */
export interface Identity {
  userId: string;
  organizationId: string;
  sessionId: string;
  email: string;
}

/** Guarded the way the layout store is: `localStorage` throws outright in a private window,
 *  and not remembering an account is never worth taking the app down for. */
export function lastIdentity(): Identity | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Identity>;
    return p.userId && p.organizationId && p.email
      ? {
          userId: p.userId,
          organizationId: p.organizationId,
          sessionId: p.sessionId ?? '',
          email: p.email,
        }
      : null;
  } catch {
    return null;
  }
}

export function rememberIdentity(identity: Identity): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(identity));
  } catch {
    // Storage refused. The session still works; only the offline head start is lost.
  }
}

export function forgetIdentity(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // As above.
  }
}

/** The database file name, and the identity the provider keys on. */
export const identityKey = (i: { userId: string; organizationId: string }): string =>
  `${i.userId}-${i.organizationId}`;
