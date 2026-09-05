import { defineConfig } from 'drizzle-kit';

/**
 * Generate-only. There is deliberately no `db:push` script.
 *
 * `generate` diffs the TypeScript schema against Drizzle's own snapshot and needs no
 * database connection. `push` introspects the live database — which would see the
 * hand-written `PARTITION BY RANGE` on run_events, fail to express it in TypeScript, and
 * try to "fix" it by rewriting the table. That is the one way this setup can lose data.
 *
 * DDL Drizzle cannot express (partitioning, the partition-management cron) goes in an
 * empty migration from `pnpm db:custom`. Custom SQL never enters the snapshot, so it does
 * not produce spurious diffs on the next generate.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/tables/index.ts',
  out: '../../supabase/migrations',
  // Supabase-compatible timestamps, so the Supabase CLI stays the only migration runner.
  migrations: { prefix: 'supabase' },
});
