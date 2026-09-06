# @relay/schema

**The single source of truth (invariant 14).** Tables are defined here in Drizzle; the SQL
migrations are generated from them. Consumed by the client, the API server and the broker —
the runtime imports types only, since it holds no database credential.

- `src/tables/` — Drizzle definitions. `index.ts` is the barrel `drizzle.config.ts` reads
  and the H7 guard audits, so a table missing from it exists in neither.
- `src/shapes/` — shape definitions, **server-side only**. A shape that reaches the client
  bundle is a shape someone can rewrite.
- `src/events/` — `run_event` kinds and label types
- `src/validators/` — `drizzle-zod` schemas, used by the write endpoint _and_ the client
- `src/tenancy.ts` + `test/` — the H7 guard

## Why Drizzle

The alternative was hand-writing DDL and types separately and asserting parity in CI. With
Drizzle the drift cannot happen: TypeScript is the source, SQL is generated, and validators
derive from the same definitions. It also makes the H7 guard a fast unit test over real
source rather than an introspection job against a live database.

## Commands

|                           |                                                        |
| ------------------------- | ------------------------------------------------------ |
| `pnpm db:generate`        | diff the schema against the snapshot, emit a migration |
| `pnpm db:custom --name=x` | empty migration for DDL Drizzle cannot express         |
| `pnpm test`               | the H7 guard                                           |

Migrations land in `supabase/migrations/` with Supabase-compatible timestamps, so the
Supabase CLI stays the only thing that _runs_ them. Drizzle only writes them.

**There is no `db:push`, deliberately.** `generate` diffs TypeScript against Drizzle's own
snapshot and needs no database. `push` introspects the live one — it would find the
hand-written `PARTITION BY RANGE` on `run_events`, fail to express it in TypeScript, and
try to "fix" it by rewriting the table.

## The tenancy guard (H7)

`organization_id` sits on every tenant table, and `workspace_id` on everything below the
workspace — **including where either is derivable by join** (invariant 2). The shape proxy
authorises on every request and must never join to do it, so a denormalised column that
looks redundant is load-bearing. A missing one is a cross-tenant leak, and a convention
won't hold it.

Exemptions are two explicit sets in `src/tenancy.ts`. Adding a table to one is an edit
someone has to justify in review — that is the point, so don't widen them to make a test
pass.

The schema is empty today, so the fixtures in `test/tenancy.test.ts` are what prove the
guard actually bites. Keep them.

## Retention

`run_events` is partitioned by month **from creation time** — retrofitting partitioning
means rebuilding the Supabase instance. Declare the table normally in Drizzle so types,
validators and the guard all work; add `PARTITION BY RANGE` and the partition-management
cron in a `db:custom` migration. Partitioning is transparent to `SELECT`/`INSERT`, so the
types are identical either way.

Retention is **30 days**, and the R2 lifecycle rules must expire on the same clock (H12).
Otherwise `blob_key` references outlive their rows and storage only grows.
