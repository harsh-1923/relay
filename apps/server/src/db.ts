import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@relay/schema';

export interface DbEnv {
  HYPERDRIVE: { connectionString: string };
}

/**
 * One connection per request, not a module-level singleton: a Worker isolate may be reused
 * across requests but has no reliable teardown, so a long-lived pool leaks. Hyperdrive is
 * the pool.
 */
export const db = (env: DbEnv) =>
  drizzle(postgres(env.HYPERDRIVE.connectionString, { max: 1, prepare: false }), { schema });
