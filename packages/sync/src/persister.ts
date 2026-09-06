import { persistedCollectionOptions } from '@tanstack/db-sqlite-persistence-core';
import { createElectronSQLitePersistence } from '@tanstack/electron-db-sqlite-persistence/renderer';

/**
 * Local persistence, resolved per platform (invariant 10).
 *
 * Nothing above this knows which surface it is on. `collections.ts` asks for a persistence and
 * either gets one or does not; a collection with no persistence is in-memory and correct, just
 * not local-first.
 *
 * **Only the renderer half is imported here.** `@tanstack/electron-db-sqlite-persistence`
 * splits into `/main` and `/renderer` subpaths, and the renderer one depends on nothing but
 * the protocol core — so nothing native can reach a browser bundle through this file. The main
 * half lives in `@relay/persist-sqlite`, which `apps/client` does not and must not depend on.
 */

/** What `persistedCollectionOptions` needs. Structural, so this file owns no vendor type. */
export type Persistence = Parameters<typeof persistedCollectionOptions>[0]['persistence'];

export interface PersistenceBridge {
  invoke(channel: string, request: unknown): Promise<unknown>;
}

/**
 * Build a persistence from the desktop bridge's single `invoke`.
 *
 * The database is in the main process; this reconstructs an adapter that talks to it over IPC.
 * Returns `undefined` when there is no bridge — the browser surface, and any renderer whose
 * shell predates bridgeVersion 7.
 */
export function electronPersistence(
  bridge: PersistenceBridge | undefined,
): Persistence | undefined {
  if (!bridge) return undefined;
  return createElectronSQLitePersistence({
    invoke: bridge.invoke as Parameters<typeof createElectronSQLitePersistence>[0]['invoke'],
  });
}

export { persistedCollectionOptions };
