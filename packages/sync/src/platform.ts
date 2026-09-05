/**
 * The capability interface (invariant 10).
 *
 * `apps/client` builds once and ships twice — deployed as the browser surface, and zipped
 * into the desktop UI bundle. What differs between them is answered here at runtime, never
 * by an `if (isElectron)` at a call site.
 */
export interface Platform {
  /** Electron only. The browser resolves this to a clear, explained state. */
  panels: boolean;
  /** SQLite via the preload bridge, or IndexedDB. Decides which persister is used. */
  persistence: 'sqlite' | 'indexeddb';
  /** Desktop is cross-origin to the API and carries a bearer token; the browser has a cookie. */
  session: 'cookie' | 'bearer';
}

/** What the Electron preload exposes. Absent in the browser. */
export interface RelayBridge {
  bridgeVersion: number;
  platform: string;
  auth: {
    /** Opens the system browser; the result arrives later through `onChange`. */
    signIn(): Promise<void>;
    /** Forget an in-flight sign-in, so its code can no longer be redeemed. */
    cancelSignIn(): Promise<void>;
    token(): Promise<string | null>;
    /** Persist a seal the server rotated on an expired access token. */
    store(sealed: string): Promise<void>;
    signOut(): Promise<void>;
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
