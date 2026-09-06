import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { initialInset } from '../main/chrome';

/**
 * Latest window inset, tracked here rather than in the renderer.
 *
 * The preload is listening from before the page runs, so whatever the shell pushes is caught
 * — including the push on `did-finish-load`, which can land before React has mounted an
 * effect to hear it.
 */
let inset = initialInset();
ipcRenderer.on('chrome:inset-changed', (_e: IpcRendererEvent, next: number) => {
  inset = next;
});

/**
 * The capability bridge. `packages/sync/platform` reads this to decide whether panels exist,
 * which persister to use, and how the session travels — nothing above the persister asks
 * what platform it is on.
 *
 * `bridgeVersion` is the compatibility contract with a downloaded UI bundle (Phase 11). A
 * bundle declares the *minimum* it needs, so bump this on any change to what is exposed —
 * additions included — or a bundle cannot express that it requires them.
 */
contextBridge.exposeInMainWorld('relay', {
  bridgeVersion: 6,
  platform: process.platform,
  auth: {
    /** Opens the system browser. Adds an account rather than replacing the active one. */
    signIn: (): Promise<void> => ipcRenderer.invoke('auth:sign-in'),
    /** Forget an in-flight sign-in, so its code can no longer be redeemed. */
    cancelSignIn: (): Promise<void> => ipcRenderer.invoke('auth:cancel'),
    /** The sealed session of the active account, or null when signed out of everything. */
    token: (): Promise<string | null> => ipcRenderer.invoke('auth:token'),
    /** Persist a seal the server rotated, against the active account. */
    store: (sealed: string): Promise<void> => ipcRenderer.invoke('auth:store', sealed),
    /** Every signed-in account. One email is one account — WorkOS keys identity on email. */
    accounts: (): Promise<Array<{ userId: string; email: string; active: boolean }>> =>
      ipcRenderer.invoke('auth:accounts'),
    switchAccount: (userId: string): Promise<void> =>
      ipcRenderer.invoke('auth:switch-account', userId),
    /** Signs out one account, or the active one. The others stay signed in. */
    signOut: (userId?: string): Promise<void> => ipcRenderer.invoke('auth:sign-out', userId),
    onChange: (cb: (change: { error?: string }) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, change: { error?: string }) => cb(change ?? {});
      ipcRenderer.on('auth:changed', handler);
      return () => ipcRenderer.off('auth:changed', handler);
    },
  },
  chrome: {
    // Synchronous, so the first paint already clears the window controls. Deriving it here
    // rather than in the renderer keeps the pixel count on the side of the bridge that knows
    // the platform — invariant 10.
    inset: (): number => inset,
    onInsetChange: (cb: (inset: number) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, next: number) => cb(next);
      ipcRenderer.on('chrome:inset-changed', handler);
      return () => ipcRenderer.off('chrome:inset-changed', handler);
    },
  },
  links: {
    onNavigate: (cb: (path: string) => void): (() => void) => {
      const handler = (_e: IpcRendererEvent, path: string) => cb(path);
      ipcRenderer.on('link:navigate', handler);
      return () => ipcRenderer.off('link:navigate', handler);
    },
  },
});
