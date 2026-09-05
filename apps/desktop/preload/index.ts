import { contextBridge } from 'electron';

/**
 * The capability bridge. `packages/sync/platform` reads this to decide whether panels exist
 * and which persister to use — nothing above the persister asks what platform it is on.
 *
 * `bridgeVersion` is the compatibility contract with a downloaded UI bundle (Phase 11): a
 * bundle declares the minimum it needs, and the updater refuses one this shell cannot run.
 * Bump it only on a breaking change to what is exposed here.
 */
contextBridge.exposeInMainWorld('relay', {
  bridgeVersion: 1,
  platform: process.platform,
});
