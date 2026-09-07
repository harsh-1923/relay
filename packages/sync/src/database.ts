import {
  PowerSyncDatabase,
  WASQLiteVFS,
  type AbstractPowerSyncDatabase,
  type PowerSyncBackendConnector,
} from '@powersync/web';

import { AppSchema } from './schema';

/**
 * The local database and the two calls that connect it to our server.
 *
 * **Renderer, not main process** (D9). `@powersync/node` would be faster — native SQLite
 * against WebAssembly — but `powerSyncCollectionOptions` needs a live `PowerSyncDatabase`
 * instance, so putting it in Electron's main process would leave the renderer talking to it
 * over an IPC bridge and unable to use TanStack DB at all. The query layer is worth more than
 * the milliseconds, and it means the desktop app and a browser tab run identical code.
 *
 * The connector is deliberately thin. PowerSync owns sync, persistence and the upload queue;
 * these two methods are the only places relay's own server appears, and both are ordinary
 * authenticated requests to it.
 */

export interface ConnectorOptions {
  /**
   * An authenticated `fetch` for our API. Injected rather than built here, because the two
   * surfaces carry a session differently — the browser is same-origin and its cookie travels
   * on its own, while the desktop renderer is cross-origin to the API and sends the sealed
   * session as a bearer. `packages/sync` should not have to know which it is.
   */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

interface Credentials {
  endpoint: string;
  token: string;
}

/**
 * `fetchCredentials` is called on connect and again whenever the token expires, so it is also
 * the revocation path: a signed-out session no longer unseals, the mint fails, and the device
 * stops syncing without anything else having to notice.
 *
 * `uploadData` is the *only* way local writes reach Postgres. It sends the CRUD queue to
 * `/api/mutations`, which authorises every operation — the client's own database is not a
 * trust boundary (P2).
 */
export function createConnector({ fetch }: ConnectorOptions): PowerSyncBackendConnector {
  return {
    async fetchCredentials(): Promise<Credentials | null> {
      const res = await fetch('/api/powersync/token');
      if (!res.ok) return null;
      return (await res.json()) as Credentials;
    },

    async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
      const batch = await database.getCrudBatch();
      if (!batch) return;

      const res = await fetch('/api/mutations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch: batch.crud.map((e) => ({
            op: e.op,
            table: e.table,
            id: e.id,
            data: e.opData ?? undefined,
          })),
        }),
      });

      /**
       * Throwing leaves the batch un-completed, so PowerSync retries it — which is right for a
       * server that is down or a token that expired mid-flight, and wrong for a write the
       * server refuses. The endpoint answers 200 with a rejection list rather than an error
       * precisely so a forbidden write cannot wedge this queue forever; the local row is
       * corrected when authoritative state syncs back down.
       */
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);

      await batch.complete();
    },
  };
}

export interface DatabaseOptions extends ConnectorOptions {
  /** Distinct per account so switching users never reads the previous one's rows. */
  filename?: string;
}

/**
 * `OPFSCoopSyncVFS` rather than the IndexedDB default: it is faster, and it is the variant
 * PowerSync recommends when multiple tabs are in play — including Safari, where shared workers
 * are disabled and the others deadlock. It needs a real HTTP origin, which holds in the
 * browser and in the Electron renderer as long as the bundle is served over http (Phase 11).
 */
/**
 * Fill in the logger methods `@tanstack/powersync-db-collection` expects.
 *
 * The alpha calls `database.logger.error` and `.info`; `@powersync/web` 2.3 exposes a logger
 * with only `{ prefix, minLevel, log }`. The mismatch is silent until a collection mounts,
 * where it throws `database.logger.error is not a function` — after which every collection
 * sits at `status: 'loading'` forever with a full SQLite database underneath it.
 *
 * Delegating to `console` rather than to `log` because `log`'s signature is not part of any
 * published contract and guessing it would trade one version assumption for another. Remove
 * this when the two packages agree on a logger again (P1).
 */
function fillLoggerMethods(db: PowerSyncDatabase): void {
  const logger = db.logger as unknown as Record<string, unknown> | undefined;
  if (!logger) return;
  const levels = {
    error: console.error,
    warn: console.warn,
    info: console.warn,
    debug: console.warn,
    trace: console.warn,
  } as const;
  for (const [level, fn] of Object.entries(levels)) {
    if (typeof logger[level] !== 'function') {
      logger[level] = (...args: unknown[]) => fn('[powersync]', ...args);
    }
  }
}

export function createDatabase({ filename = 'relay.db', ...connector }: DatabaseOptions) {
  const db = new PowerSyncDatabase({
    schema: AppSchema,
    database: { dbFilename: filename, vfs: WASQLiteVFS.OPFSCoopSyncVFS },
  });
  fillLoggerMethods(db);
  return { db, connect: () => db.connect(createConnector(connector)) };
}

export type Database = PowerSyncDatabase;
