import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

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
  bridgeVersion: 5,
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
});
