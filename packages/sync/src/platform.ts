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

declare global {
  interface Window {
    relay?: { bridgeVersion: number };
  }
}

export function detectPlatform(): Platform {
  const bridged = typeof window !== 'undefined' && !!window.relay;
  return bridged
    ? { panels: true, persistence: 'sqlite', session: 'bearer' }
    : { panels: false, persistence: 'indexeddb', session: 'cookie' };
}
