import { app, ipcMain } from 'electron';
import { join } from 'node:path';

// `resolution-mode` because this CommonJS file is importing a type from an ESM package. The
// value import below is dynamic for the same reason.
import type { PersistenceHandle } from '@relay/persist-sqlite' with { 'resolution-mode': 'import' };

/**
 * The local database, opened once per app run.
 *
 * Lives in `userData` rather than beside the bundle: an installed app's directory is
 * read-only on macOS, and this file must survive an update — losing it costs a full re-sync
 * of every room the user is in.
 *
 * One file for all accounts. Rows carry `organization_id` and the shape proxy decides what a
 * session may ever see, so nothing here crosses a tenant boundary that was not already
 * crossed upstream. Per-account files would be the stronger position and are what to reach for
 * if a machine is ever shared by two people who must not read each other's cache.
 */
let handle: PersistenceHandle | null = null;

/**
 * Async because the main process is CommonJS and the persistence package is ESM — it pulls in
 * `@tanstack/node-db-sqlite-persistence`, which ships ESM only. A dynamic import is the seam
 * between the two, and it is awaited before the first window opens so the IPC channel is
 * registered before any renderer can ask for it.
 */
export async function installPersistence(): Promise<PersistenceHandle> {
  if (handle) return handle;
  const { openPersistence } = await import('@relay/persist-sqlite');
  handle = openPersistence({
    path: join(app.getPath('userData'), 'relay.sqlite'),
    ipcMain,
  });
  // The schema has to exist before a renderer reads: its first call is a metadata *read*, and
  // the adapter only creates tables on the write path.
  await handle.ready;
  app.on('will-quit', () => {
    handle?.dispose();
    handle = null;
  });
  return handle;
}

export const persistencePath = (): string | null => handle?.path ?? null;
