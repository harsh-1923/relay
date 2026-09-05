import { contextBridge, ipcRenderer } from 'electron';

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
  bridgeVersion: 2,
  platform: process.platform,
  auth: {
    /** Opens the system browser. The result arrives later, via `onChange`. */
    signIn: (): Promise<void> => ipcRenderer.invoke('auth:sign-in'),
    /** The sealed session to send as a bearer, or null when signed out. */
    token: (): Promise<string | null> => ipcRenderer.invoke('auth:token'),
    signOut: (): Promise<void> => ipcRenderer.invoke('auth:sign-out'),
    onChange: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('auth:changed', handler);
      return () => ipcRenderer.off('auth:changed', handler);
    },
  },
});
