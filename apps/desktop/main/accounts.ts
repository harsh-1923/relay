import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Several signed-in accounts, one at a time active.
 *
 * WorkOS keys identity on email, so one email is one account: `you@gmail.com` and
 * `you@work.com` are different users holding different memberships and roles. They are never
 * linked server-side — that would be a path around an enterprise's SSO enforcement — so
 * holding both at once is the client's job, and only the desktop can do it. A browser has one
 * cookie and therefore one session.
 *
 * The whole file is encrypted by `safeStorage`: the OS keychain on macOS, DPAPI on Windows.
 * The renderer never reads it; it asks over the bridge.
 */

export interface Account {
  userId: string;
  email: string;
  sealed: string;
}

export interface Store {
  active: string | null;
  accounts: Record<string, Account>;
}

export const EMPTY: Store = { active: null, accounts: {} };

/**
 * The state transitions, kept free of `safeStorage` and the filesystem so they can be tested
 * — the branching that matters lives here, and the I/O around it is a keychain call.
 */
export const transitions = {
  /** Adds or replaces, and makes active: signing in should land you where you signed in. */
  upsert: (s: Store, account: Account): Store => ({
    active: account.userId,
    accounts: { ...s.accounts, [account.userId]: account },
  }),

  /** A rotated seal belongs to whichever account is active; no active account, nothing to do. */
  updateActiveSeal: (s: Store, sealed: string): Store => {
    const current = s.active ? s.accounts[s.active] : undefined;
    if (!current) return s;
    return { ...s, accounts: { ...s.accounts, [current.userId]: { ...current, sealed } } };
  },

  setActive: (s: Store, userId: string): Store =>
    s.accounts[userId] ? { ...s, active: userId } : s,

  /**
   * Signing out of one account promotes another rather than leaving nothing active — landing
   * on a sign-in screen while still holding a valid session would be a lie.
   */
  remove: (s: Store, userId: string): Store => {
    const accounts = { ...s.accounts };
    delete accounts[userId];
    const active = s.active === userId ? (Object.keys(accounts)[0] ?? null) : s.active;
    return { active, accounts };
  },
};

const file = () => join(app.getPath('userData'), 'accounts');
/** What a single-account shell wrote before this existed. */
const legacyFile = () => join(app.getPath('userData'), 'session');

function read(): Store {
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file()))) as Store;
    return parsed.accounts ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

const write = (s: Store) => writeFileSync(file(), safeStorage.encryptString(JSON.stringify(s)));

/** The seal for the active account, or null when signed out of everything. */
export function activeSeal(): string | null {
  const s = read();
  return s.active ? (s.accounts[s.active]?.sealed ?? null) : null;
}

export const list = (): Array<{ userId: string; email: string; active: boolean }> => {
  const s = read();
  return Object.values(s.accounts).map((a) => ({
    userId: a.userId,
    email: a.email,
    active: a.userId === s.active,
  }));
};

export function upsert(account: Account): void {
  write(transitions.upsert(read(), account));
}

export function updateActiveSeal(sealed: string): void {
  write(transitions.updateActiveSeal(read(), sealed));
}

/** The seal for a specific account — used to revoke it upstream when signing it out. */
export function sealFor(userId: string): string | null {
  return read().accounts[userId]?.sealed ?? null;
}

export function setActive(userId: string): boolean {
  const s = read();
  if (!s.accounts[userId]) return false;
  write(transitions.setActive(s, userId));
  return true;
}

export function remove(userId: string): void {
  write(transitions.remove(read(), userId));
}

export function clear(): void {
  rmSync(file(), { force: true });
}

/**
 * Carries a pre-existing single-account file forward.
 *
 * The seal is opaque here, so the user it belongs to has to be asked for — `/auth/session`
 * answers with the bearer. Runs once; on any failure the old file is simply dropped and the
 * user signs in again, which is a worse morning but not a broken one.
 */
export async function migrateLegacy(uiUrl: string): Promise<void> {
  if (existsSync(file()) || !existsSync(legacyFile())) return;

  let sealed: string;
  try {
    sealed = safeStorage.decryptString(readFileSync(legacyFile()));
  } catch {
    rmSync(legacyFile(), { force: true });
    return;
  }

  try {
    const r = await fetch(`${uiUrl}/auth/session`, {
      headers: { Authorization: `Bearer ${sealed}` },
    });
    if (r.ok) {
      const s = (await r.json()) as { userId: string; email: string };
      upsert({ userId: s.userId, email: s.email, sealed });
      rmSync(legacyFile(), { force: true });
      return;
    }
  } catch {
    // fall through
  }
  // Unusable — keep it out of the way rather than retrying every launch.
  renameSync(legacyFile(), `${legacyFile()}.stale`);
}
