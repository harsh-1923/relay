import { DatabaseSync } from 'node:sqlite';

import {
  createSQLiteCorePersistenceAdapter,
  type SQLiteDriver,
} from '@tanstack/db-sqlite-persistence-core';
import { exposeElectronSQLitePersistence } from '@tanstack/electron-db-sqlite-persistence/main';

/**
 * One file, deliberately — the driver below is not split out.
 *
 * This package ships as uncompiled TypeScript, and the desktop shell loads it at runtime with
 * a dynamic `import()`, so Node type-strips it directly. That leaves no valid spelling for a
 * relative import: Node resolves `./driver.ts` and rejects `./driver.js`, while TypeScript
 * under the shell's Node16 resolution demands `./driver.js` and rejects `./driver.ts` unless
 * `allowImportingTsExtensions` is set — which the shell cannot set, because it emits. Having
 * no relative import is the only spelling that satisfies both.
 */

/**
 * Local persistence for the desktop shell — **main process only**.
 *
 * A separate package so the native module can never end up in a browser bundle. That is
 * enforced by construction rather than discipline: `apps/client` does not depend on this, and
 * cannot, because importing it would pull `better-sqlite3` into a Vite build that has no way
 * to load a `.node` binary.
 *
 * The renderer never touches SQLite. It holds one `invoke` function across the context bridge
 * and speaks the persistence protocol over it, which is what keeps `contextIsolation` intact —
 * the alternative, hanging a database handle off `window`, is the thing that isolation exists
 * to prevent.
 */

export interface PersistenceHandle {
  /** Close the database and remove the IPC handler. Called on shutdown. */
  dispose: () => void;
  /** Where the file lives, for logging and for `pnpm health`. */
  path: string;
  /**
   * Resolves once the schema exists. Await it before the first window loads.
   *
   * The adapter creates its tables lazily, but only on the write path —
   * `applyCommittedTx` calls `ensureCollectionReady`, `loadCollectionMetadata` does not. A
   * renderer starting against a fresh database reads *first* (startup metadata), so without
   * this it fails with "no such table: collection_metadata" and every collection gives up on
   * persistence before writing anything.
   */
  ready: Promise<void>;
}

export interface OpenOptions {
  /** Absolute path to the database file. The caller decides; this package has no opinion
   *  about app directories. */
  path: string;
  /**
   * Electron's `ipcMain`. Typed structurally — with `unknown` rather than the protocol's own
   * envelope types — so this package does not depend on `electron` and the desktop shell can
   * pass its real one without a cast at the call site.
   */
  ipcMain: {
    // `unknown` rather than a narrower type: parameters are contravariant, so a listener that
    // accepts anything satisfies one that accepts an `IpcMainInvokeEvent`. That is what lets
    // Electron's real `ipcMain` be passed to a signature that never imports electron.
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
    removeHandler?(channel: string): void;
  };
}

/**
 * Open the local database and expose it to the renderer.
 *
 * The file is **derived data with one precious exception**: rows that arrived over a shape can
 * be rebuilt by re-syncing, but anything queued and not yet sent cannot. Deleting this file is
 * therefore safe when offline writes are drained, and lossy when they are not — which is why
 * the outbox is not in here yet (see `docs/plans/local-first.md` L6).
 *
 * WAL mode because two processes touch this: the main process owns the writer, and a second
 * window's reads must not block behind a checkpoint.
 */
export function openPersistence({ path, ipcMain }: OpenOptions): PersistenceHandle {
  const driver = new NodeSqliteDriver(path, [
    // Two processes touch this file: the main process writes, and a second window's reads
    // must not block behind a checkpoint.
    'journal_mode = WAL',
    // Durability over raw speed, but not fsync-per-write. NORMAL loses at most the last
    // transaction on a power cut, and every row in here can be re-synced from Postgres.
    'synchronous = NORMAL',
    'foreign_keys = ON',
  ]);

  const adapter = createSQLiteCorePersistenceAdapter({ driver });
  const remove = exposeElectronSQLitePersistence({
    ipcMain: ipcMain as never,
    persistence: { adapter },
  });

  /**
   * `ensureInitialized` exists on the concrete adapter but not on the `PersistenceAdapter`
   * interface it is typed as, so reaching it needs a cast. Narrowed to just this method rather
   * than `as never`, so the day upstream publishes it — or removes it — this stops compiling
   * instead of silently doing nothing.
   */
  const initialize = (adapter as unknown as { ensureInitialized(): Promise<void> })
    .ensureInitialized;

  return {
    path,
    ready: initialize.call(adapter),
    dispose: () => {
      remove();
      driver.close();
    },
  };
}

/**
 * A `SQLiteDriver` over Node's built-in `node:sqlite`.
 *
 * Deliberately not `better-sqlite3`. That is a native module, which means compiling against
 * Electron's ABI with `@electron/rebuild`, a pnpm build allowlist, and a rebuild step on every
 * Electron upgrade — all to reach a SQLite that Electron 44 already ships. `node:sqlite` is in
 * Node 24, which Electron 44 embeds, so there is nothing to build and nothing to keep in sync.
 *
 * The interface is four methods, and the only subtle one is nesting: the core adapter opens
 * transactions inside transactions, and SQLite has no nested `BEGIN`. Savepoints are what make
 * the inner ones work.
 */
export class NodeSqliteDriver implements SQLiteDriver {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(filename: string, pragmas: readonly string[] = []) {
    this.db = new DatabaseSync(filename);
    for (const pragma of pragmas) this.db.exec(`PRAGMA ${pragma};`);
  }

  exec = async (sql: string): Promise<void> => {
    this.db.exec(sql);
  };

  // The core adapter names the row type at each call site; `node:sqlite` returns untyped
  // records, so this is the one place the two meet and the cast has to go through `unknown`.
  query = async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> =>
    this.db.prepare(sql).all(...(params as never[])) as unknown as ReadonlyArray<T>;

  run = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<void> => {
    this.db.prepare(sql).run(...(params as never[]));
  };

  transaction = <T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> =>
    this.transactionWithDriver(fn);

  transactionWithDriver = async <T>(fn: (driver: SQLiteDriver) => Promise<T>): Promise<T> => {
    const outermost = this.depth === 0;
    const savepoint = `relay_sp_${this.depth}`;
    this.db.exec(outermost ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = await fn(this);
      this.db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
      throw error;
    } finally {
      this.depth--;
    }
  };

  close(): void {
    this.db.close();
  }
}
