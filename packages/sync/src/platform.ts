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
 * `tabs`: whether the app draws its own tab strip. The browser already has the browser's, and
 *   reimplementing them there would compete with the real ones.
 * `titleBarInset`: pixels to leave clear at the top-left for the OS window controls. A number
 *   rather than a platform flag because Windows and Linux have window controls but no
 *   traffic lights, and an `isMac` boolean gets that wrong. This is the value at first paint;
 *   it is reactive, because macOS hides the lights in fullscreen — subscribe with
 *   `bridge()?.chrome.onInsetChange` rather than trusting it forever.
 */
export interface Platform {
  panels: boolean;
  persistence: 'sqlite' | 'indexeddb';
  session: 'cookie' | 'bearer';
  tabs: boolean;
  titleBarInset: number;
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
  /**
   * `inset`: synchronous, so the first paint already leaves room for the window controls — an
   *   async read would put the app under them for a frame. A getter rather than a number
   *   because the preload keeps it current: a window restored straight into fullscreen emits
   *   no transition for a subscriber to catch, and by the time React subscribes the shell's
   *   first push may already have gone.
   * `onInsetChange`: fires on fullscreen transitions, where the controls disappear entirely.
   */
  /**
   * `invoke`: one request/response call carrying the SQLite persistence protocol. The database
   *   lives in the main process; the renderer holds only this function and rebuilds an adapter
   *   from it. Absent on the browser surface, where persistence is OPFS or nothing.
   */
  persistence: {
    invoke(channel: string, request: unknown): Promise<unknown>;
  };
  chrome: {
    inset(): number;
    onInsetChange(cb: (inset: number) => void): () => void;
  };
  /**
   * `onNavigate`: a `relay://open/…` deep link arrived and the shell is asking the renderer to
   *   go there. A path only — the shell validated its shape, and everything about whether it
   *   is reachable is decided by the session and the shape proxy, as it is for any other
   *   navigation.
   */
  links: {
    onNavigate(cb: (path: string) => void): () => void;
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
  const b = bridge();
  // `chrome` arrived in bridgeVersion 6. A newer UI bundle can meet an older shell before the
  // updater refuses it, and rendering under the traffic lights is a worse failure than a
  // flush-left title bar — so fall back rather than throw.
  return b
    ? {
        panels: true,
        persistence: 'sqlite',
        session: 'bearer',
        tabs: true,
        titleBarInset: b.chrome?.inset() ?? 0,
      }
    : {
        panels: false,
        persistence: 'indexeddb',
        session: 'cookie',
        tabs: false,
        titleBarInset: 0,
      };
}
