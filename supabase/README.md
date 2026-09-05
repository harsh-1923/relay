# supabase

Local Postgres and the migration runner. Lives at the repo root because the Supabase CLI
expects it there — convention beats taxonomy.

```
pnpm db:start    # Postgres :54322, Studio :54323
pnpm db:reset    # drop, reapply every migration, rerun seed.sql
pnpm db:stop
```

**Only Postgres and Studio run.** `config.toml` disables Supabase Auth, Storage, Realtime,
Edge Functions and Analytics: auth is WorkOS, object storage is R2, change propagation is
Electric. They are not merely unused — leaving Supabase Auth running invites someone to
reach for RLS, and `auth.uid()` needs a Supabase JWT we never issue. It also cuts the stack
from a dozen containers to five.

**Use `db:reset`, not `db:start`, after adding a migration.** `start` can restore a cached
snapshot and silently skip pending migrations — it did exactly that on first run here.

## Migrations are generated, not written

`migrations/` is **output**. The source is `packages/schema/src/tables/`; `pnpm db:generate`
emits the SQL here with Supabase-compatible timestamps. Edit the TypeScript, regenerate, and
let the Supabase CLI apply it.

The exception is DDL Drizzle cannot express — the `run_events` partitioning and its
partition-management cron. Those come from `pnpm db:custom`, are hand-written, and never
enter Drizzle's snapshot, so they don't produce spurious diffs afterwards.

`migrations/meta/` is Drizzle's journal and snapshots. It is checked in — the snapshots are
what `generate` diffs against, so losing them means losing migration history. The Supabase
CLI skips the directory (verified: `db reset` applies only the `.sql`), and Prettier ignores
it since drizzle-kit rewrites it on every generate.

## Two things that must be true in the first migration

- **`run_events` partitioned by month at creation time**, with the cron that creates next
  month's partition and drops those past retention written _now_, not when the first
  partition fills.
- **Retention is 30 days**, matched by the R2 lifecycle rules (H12).

## No RLS

Authorization lives in the shape proxy and the write endpoint. Supabase RLS would be a
second, unusable authz system — `auth.uid()` requires a Supabase JWT we never issue, and
leaving RLS half-on is worse than off.

Mirrored tables (`users`, `organizations`, `organization_memberships`) are **read-only in
application code**. They arrive by WorkOS webhook; a direct write is silently overwritten.

## No seed

There is no `seed.sql`, and `db.seed` is off in `config.toml`. Tables exist and are empty;
rows arrive because the real signup and webhook flow created them. Seeding a mirror of
WorkOS means inventing ids that do not exist upstream — dangling foreign keys that look fine
until a real login hits one.
