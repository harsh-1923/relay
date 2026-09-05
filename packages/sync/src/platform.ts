/**
 * The capability interface (invariant 10).
 *
 * `apps/client` builds once and ships twice — deployed as the browser surface, and zipped
 * into the desktop UI bundle. What differs between them is answered here at runtime, never
 * by an `if (isElectron)` at a call site.
 *
 * `panels`: Electron only. The browser resolves this to a clear, explained state.
 * `persistence`: SQLite via the preload bridge, or IndexedDB. Decides which persister is used.
 * `session`: Desktop is cross-origin to the API and carries a bearer token; the browser has a cookie.
 */
export interface Platform {
  panels: boolean;
  persistence: 'sqlite' | 'indexeddb';
  session: 'cookie' | 'bearer';
}

/** What the Electron preload exposes. Absent in the browser. */
export interface RelayBridge {
  bridgeVersion: number;
  platform: string;
  /**
   * `signIn`: opens the system browser; the result arrives later through `onChange`.
   * `cancelSignIn`: forget an in-flight sign-in, so its code can no longer be redeemed.
   * `store`: persist a seal the server rotated on an expired access token.
   * `accounts`: every signed-in account. One email is one account: WorkOS keys identity on
   *   email, and the two are never linked server-side — linking would be a path around an
   *   enterprise's SSO enforcement. Desktop only; a browser has one cookie and therefore one
   *   session.
   * `signOut`: signs out one account, or the active one. The others stay signed in.
   */
  auth: {
    signIn(): Promise<void>;
    cancelSignIn(): Promise<void>;
    token(): Promise<string | null>;
    store(sealed: string): Promise<void>;
    accounts(): Promise<Array<{ userId: string; email: string; active: boolean }>>;
    switchAccount(userId: string): Promise<void>;
    signOut(userId?: string): Promise<void>;
    onChange(cb: (change: { error?: string }) => void): () => void;
  };
}

declare global {
  interface Window {
    relay?: RelayBridge;
  }
}

export const bridge = (): RelayBridge | undefined =>
  typeof window !== 'undefined' ? window.relay : undefined;

export function detectPlatform(): Platform {
  return bridge()
    ? { panels: true, persistence: 'sqlite', session: 'bearer' }
    : { panels: false, persistence: 'indexeddb', session: 'cookie' };
}
