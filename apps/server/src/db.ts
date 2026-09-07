import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@relay/schema';

export interface DbEnv {
  HYPERDRIVE: { connectionString: string };
  /**
   * Overrides Hyperdrive when set, which is how development points at whichever Postgres
   * PowerSync is replicating.
   *
   * **Reads and writes must be the same database.** PowerSync replicates one Postgres and
   * syncs it to devices; if the write endpoint targets a different one, a message written in
   * the app lands somewhere the sync engine never looks and silently never comes back. The
   * binding cannot carry it because `wrangler.jsonc` is committed and this URL has a
   * password in it, so it lives in `.env` alongside the other secrets.
   */
  DATABASE_URL?: string;
}

/**
 * One connection per request, not a module-level singleton: a Worker isolate may be reused
 * across requests but has no reliable teardown, so a long-lived pool leaks. Hyperdrive is
 * the pool.
 */
export const db = (env: DbEnv) =>
  drizzle(
    postgres(env.DATABASE_URL ?? env.HYPERDRIVE.connectionString, { max: 1, prepare: false }),
    {
      schema,
    },
  );
