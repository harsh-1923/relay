# Local-first — Supabase, TanStack DB, and a sync source we own

> Working plan, and the sibling of [`rooms.md`](./rooms.md). That document decides the tables;
> this one decides **what syncs, what persists, and what a user can still see with the network
> off.** They are deliberately separate so each can be picked up alone: nothing here changes
> the schema, and the schema can be built without settling any of this.
>
> **This document reverses `ARCHITECTURE.md`'s Phase 2 decision.** Electric was chosen there;
> this plan does not use it. The reasoning is in D1 and in _Rejected_, and the amendment
> `ARCHITECTURE.md` needs is listed at the bottom — that file is edited in its own turn, and
> reversing a load-bearing decision is exactly the kind of edit that should be.
>
> Every technical claim here was verified on 2026-09-06 against vendor documentation, published
> packages, or a running spike — several by reading package source, because the behaviour was
> undocumented. Where something is inferred rather than verified, it says so.

**Done when:** the app launches with the network off and renders every room the user is in, with
its messages, from disk; a message written offline sends once on reconnect; an update to a room
the user is _not_ looking at reaches their device and is there when they open that room later,
offline; and adding a new synced table is a mechanical four-step change with no new decisions.

**Scope:** the sync endpoints, the two sync strategies and the rule for choosing between them,
the client collections, the doorbell, the write path, and persistence on desktop and browser.
Not the room and chat schema (`rooms.md`), not the run lifecycle (Phase 5), not search.

## Where things stand

> **Superseded in part.** The engine decision in D1 was reversed again after a bet was taken on
> self-hosting Electric — see the top of this file. The snapshot/cursor design below is retained
> as the record of what a self-written sync source would have required, and as the fallback if
> Electric is abandoned. What was actually built is in _Where things stand_.

| #   | Step                                                        | State                                |
| --- | ----------------------------------------------------------- | ------------------------------------ |
| 0   | Persistence stack and `SyncConfig` verified by spike        | ✅                                   |
| 1   | Electric self-hosted in the local stack, with slot alerting | ✅ `:54330`, `pnpm health` checks it |
| 2   | Shape registry, server-side only                            | ✅ 7 shapes                          |
| 3   | Shape proxy — unseal → authorise → forward                  | ✅ 13 tests vs real Electric         |
| 4   | Collections + the subscription registry                     | ✅                                   |
| 5   | **Render a room from synced data**                          | ✅ live insert and rename observed   |
| 6   | HTTPS in dev, for HTTP/2                                    | ✅ see L10                           |
| 7   | Persistence — `persistedCollectionOptions` on Electron      | ☐ Phase 4                            |
| 8   | `POST /writes` with idempotency; outbox                     | ☐ Phase 3                            |
| 9   | Room list, so a room is reachable without a URL             | ☐                                    |

## The requirements

Written down in the product's words, because the architecture is derived from them and the
fifth one decided the engine.

1. Good user experience.
2. The app opens and **instantly renders everything it had** when it was closed.
3. All of that is readable **with no network**.
4. New data needs the network — that is fine.
5. **Updates sync regardless of which view is live.** A user in room 1 receives room 2's
   updates, they land locally, and room 2 renders them later — offline, without ever having
   been opened in between.
6. Writes are **optimistic and feel instant**.

Requirements 2, 3 and 6 are properties of the local store and the write queue. Requirement 5 is
a property of the read path, and it is the one that separates the engines.

## The architecture

```
 ┌──────────────────────────── device ─────────────────────────────┐
 │  React ── useLiveQuery ── TanStack DB collections (one/table)    │
 │                                  │                              │
 │                     persistedCollectionOptions                  │
 │                                  │                              │
 │                     SQLite  (desktop: better-sqlite3 via IPC)   │
 │                             (browser: wa-sqlite over OPFS)      │
 │                                                                 │
 │   SnapshotSource      MessagesSource      offline-transactions  │
 └────────│──────────────────│──────────────────────│──────────────┘
          │ GET /sync/snapshot│ GET /sync/messages   │ POST /writes
          │   (ETag / 304)    │   ?after=<cursor>    │  (idempotent)
          ▼                   ▼                      ▼
 ┌─────────────────── Cloudflare Worker ───────────────────────────┐
 │        unsealSession → actorFor → access.ts → Drizzle           │
 └────────────────────────────┬────────────────────────────────────┘
                              ▼
                      Supabase Postgres
                 triggers → realtime.send() ──► Realtime (doorbell)
                                                    │
                        device ◄────────────────────┘  "room X changed"
```

Three layers. Only the middle one is ours.

| Layer         | Provides                                          | Comes from                                        |
| ------------- | ------------------------------------------------- | ------------------------------------------------- |
| Local store   | SQLite on device, cold start, cursor persistence  | `@tanstack/db-sqlite-persistence-core` + adapters |
| **Read path** | **what reaches the device, and when**             | **a `SyncConfig` we write, two of them**          |
| Write queue   | optimistic apply, durable retry, idempotency keys | `@tanstack/offline-transactions`                  |

## Decisions

### D1 — The sync engine is a `SyncConfig` we write, over Supabase

`SyncConfig` is TanStack DB's public interface for a sync source — the one
`electric-db-collection` itself implements. It hands the source `begin / write / commit /
markReady / markError / truncate`, plus `exportSyncMeta` / `importSyncMeta`, which the persister
stores beside the rows and replays on launch. Verified by spike: a source written by hand in a
few lines persisted, accumulated writes across batches, treated a re-applied key as a no-op, and
survived a sibling collection's truncate untouched.

So the local-first layer does not come from an engine. It comes from TanStack, and it is the same
whichever source feeds it. What an engine would provide is the _read path_ — and for these
requirements, no engine on the market provides it better than a source we write. The reasons,
briefly here and fully in _Rejected_:

- **Electric** fights requirement 5. Shapes are per (table, filter), so background-syncing 40
  rooms is ~200 subscriptions, and the architecture's own answer was a tiering policy that
  explicitly drops rooms from live sync. Its managed offering is also winding down after the
  Databricks acquisition, leaving a stateful Elixir service to run ourselves.
- **PowerSync** fits requirement 5 natively but holds a persistent stream per client with
  per-user buckets — a second vendor whose cost scales with concurrent clients.
- **Zero** is the heaviest infrastructure of any option, self-host only, and query-driven.
- **Convex** has no durable local store; a cold start offline shows nothing.

**And the decision is reversible in a way adopting an engine is not.** The swap point is one
`SyncConfig` per collection. Schema, persistence, outbox and `access.ts` are unchanged whichever
source sits there. If per-user catch-up ever becomes the top entry in `pg_stat_statements`, the
engine gets chosen then, with telemetry, instead of now, with estimates.

### D2 — Two sync strategies, chosen by table shape

The single most important design rule in this document. Every synced table is one of two shapes,
and each shape gets the mechanism that is correct for it by construction.

|                     | **Snapshot**                                                                                   | **Cursor**                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| For tables that are | small and mutable                                                                              | large and append-only                                      |
| Mechanism           | fetch the entire entitled set; diff; **absence = deleted**                                     | `id > cursor` across all the user's conversations          |
| Handles inserts     | yes                                                                                            | yes                                                        |
| Handles updates     | yes                                                                                            | rare, via a second bounded query on `edited_at/deleted_at` |
| Handles deletes     | yes — by absence                                                                               | soft only                                                  |
| Handles lost access | yes — the row is simply not in the next snapshot                                               | via the snapshot removing the conversation                 |
| Ordering trap       | none — no cursor                                                                               | yes, see D5                                                |
| Tables today        | `actors`, `agents`, `rooms`, `room_members`, `conversations`, `conversation_members`, `panels` | `messages`                                                 |

Why not one mechanism? Because a cursor cannot see updates — `id > cursor` only ever finds _new_
rows, and a room rename, a promotion's visibility flip, an archive or a departure are all updates
to rows whose ids sit below the cursor. And because a full-set fetch cannot scale to a table of
messages. The two shapes need the two mechanisms, and the tables split cleanly between them.

There is a third shape — **large and mutable** — which neither handles alone. It is addressed in
_Adding a table_ below, because `runs` will be the first example of it.

### D3 — Scope is joined rooms, not visible rooms

Requirement 5 is about rooms the user is _in_. A public room they have never opened does not need
its members and messages on their disk. Without that distinction the snapshot is unbounded:
`room_members` alone could be 200 browsable rooms × 50 members. With it, the whole mutable set is
roughly **1–2k rows** for an active user.

So the snapshot covers rooms with a `room_members` row for this actor. Browsing an unjoined public
room fetches its slice on demand — `GET /sync/room/:id` — into the same collections, so joining
it afterwards costs nothing more.

### D4 — The snapshot: one fetch, an ETag, and absence means deleted

`GET /sync/snapshot` returns every group-1 row the user is entitled to, in one response. The
client diffs against local — insert new, update changed, delete anything absent — and that one
diff handles inserts, updates, deletes and revoked access. No `updated_at` triggers, no tombstone
table, no cursor semantics. It is correct because absence is meaningful.

An ETag over the response makes the common case free: `If-None-Match` → `304` and nothing is
transferred. The ETag persists through `exportSyncMeta` so a relaunch starts with it.

One fetch feeds **seven collections**. A `SnapshotSource` singleton owns the request and the
ETag; each collection gets a `SyncConfig` from `configFor(slice)` that shares them. The fetch runs
on connect, on reconnect, on the per-user doorbell, and on any per-room doorbell naming a group-1
table.

### D5 — The cursor: UUIDv7, an overlap window, idempotent apply

Because ids are UUIDv7 and therefore globally time-ordered, "everything new in every room I am
in" is one indexed query on `messages_conversation_idx`:

```sql
select * from messages
where conversation_id = any($my_conversations) and id > $cursor
order by id limit 1000
```

**The trap.** Ids are assigned at insert; rows become visible at commit. Transaction A takes an
id, B takes a later id and commits first; the client syncs, sees B, advances the cursor; A
commits with a _lower_ id. `id > cursor` never returns it. That row is gone from that device,
silently, forever. It is the most common bug in hand-rolled sync.

**The fix** is an overlap window: request from `rewind(cursor, 5s)` — a v7 id with its timestamp
moved back — and apply idempotently. Re-applying a key the collection already holds is a no-op
(verified), so the window costs bandwidth measured in a handful of rows and nothing else. This is
not an optimisation and is not optional; it is in the first version or the bug is in production.

Edits and soft-deletes are updates to existing rows, so they ride a second bounded query,
`greatest(edited_at, deleted_at) > $since`, over the same conversation set. It needs an index
`messages` does not have yet.

The cursor persists through `exportSyncMeta`. We do not write that code.

### D6 — One collection per table, including one `messages` collection

Not one per conversation. Electric's shape-per-conversation forced that split; without shapes
there is nothing to split on. One `messages` collection holds everything synced, queried locally
by `conversation_id`, and `LoadSubsetOptions` — `where`, `orderBy`, `limit`, `cursor`, with a
matching unload — windows it into memory as the user scrolls rather than holding a year whole.

Nothing in our sources ever calls `truncate()`. There is no shape to leave, so local history only
accumulates. The window-and-archive split an Electric design needed does not exist here.

### D7 — The doorbell is a poke, not a log

Supabase Realtime, _Broadcast from Database_: a trigger calls `realtime.send()` and the client
hears "room X changed, table T". The payload is a poke. Postgres stays the source of truth, so
Broadcast's three-day retention and its timestamp-only replay never matter — a missed poke costs
one extra catch-up, never a gap.

Two kinds of channel over one WebSocket:

- **Per-room private channels**, one per joined room — content changed.
- **One per-user channel** — membership changed. Necessary because a room the user was _just
  added to_ is one they are not yet subscribed to.

Coalesced server-side to at most one poke per room per second. That is also what keeps Realtime
message volume, and therefore cost, flat as rooms get busy.

Private channels need an authorization policy on `realtime.messages`; it is the same rule as
`mayReadRoom`, expressed as RLS on that one table and nowhere else. RLS stays off everywhere else
(Phase 0's decision stands); this is the single table where Supabase requires it.

### D8 — Writes: optimistic, queued, idempotent, one endpoint

`collection.insert()` applies locally and the UI updates. `@tanstack/offline-transactions`
persists the mutation before dispatch, retries with backoff, and hands `POST /writes` an
`idempotencyKey`. The endpoint honours it from the first write — so H6 (duplicate PRs, duplicate
comments on retry) is closed before it can open — and returns the canonical row, which the
collection upserts by key.

One write endpoint, not per-resource routes, sharing `unsealSession()` and `access.ts` with the
read path. The transactions it calls — `createRoom`, `addRoomMember`, `archiveRoom`,
`promoteConversation` — already exist in `apps/server/src/rooms.ts` and are already tested.

Simpler than the Electric design in one specific way: no `awaitTxId`. The response carries the
row, and the next catch-up would carry it anyway.

### D9 — Persistence is the TanStack stack, verified

| Package                                    | Version    | Role                                        |
| ------------------------------------------ | ---------- | ------------------------------------------- |
| `@tanstack/db`                             | 0.8.7      | collections, live queries, `SyncConfig`     |
| `@tanstack/db-sqlite-persistence-core`     | 0.2.20     | `persistedCollectionOptions`, SQLite schema |
| `@tanstack/electron-db-sqlite-persistence` | **0.1.32** | `better-sqlite3` in main, IPC to renderer   |
| `@tanstack/browser-db-sqlite-persistence`  | 0.2.20     | wa-sqlite over OPFS                         |
| `@tanstack/offline-transactions`           | 1.0.53     | the outbox                                  |

All published 2026-08-31; none of it in TanStack's docs index, so it was read from the packages.

What the spike established, at runtime:

- `persistedCollectionOptions` wraps _any_ `SyncConfig` and declares `sync-present` /
  `sync-absent` — offline cold start is a first-class mode.
- Writes across batches accumulate; a re-applied key is a no-op upsert.
- The adapter owns its schema — a hashed table per collection registered in
  `collection_registry`, plus tombstones, `applied_tx`, `collection_metadata`, `leader_term`.
- `truncate()` is `DELETE FROM` that collection's own table and nothing else, and must be called
  inside `begin()`/`commit()` or it throws.
- The whole thing runs over Node's built-in `node:sqlite` through a ~20-line driver — no native
  build, which is how the sync sources get tested in CI.

**Invariant 10 holds by construction:** the Electron bridge and the browser adapter re-export the
same `persistedCollectionOptions`. Nothing above the persister knows which it is on.

**The caution is age, not capability.** `@tanstack/db` is pre-1.0 and the Electron bridge is
0.1.x. Pin exact versions; keep the persister behind `packages/sync/src/local/`.

### D10 — The browser is best-effort

The browser adapter needs only `navigator.storage.getDirectory` and `Worker` — **no
cross-origin isolation**, which would have broken every embed. But: OPFS is evictable, Safari caps
script-writable storage at seven days without interaction, multi-tab coordination is opt-in via
`BrowserCollectionCoordinator` and effectively mandatory, and a missing prerequisite throws
`PersistenceUnavailableError` rather than degrading. So on browser, local-first means "fast and
offline-capable while the data is there". The degraded mode — in-memory collections, no offline,
a UI that says so — is ours. `packages/sync/src/platform.ts` types `persistence` as
`'sqlite' | 'indexeddb'` today and wants `'sqlite' | 'opfs' | 'memory'`.

## Table by table

| Table                                 | Syncs | Strategy | Scope                                                | Doorbell        |
| ------------------------------------- | ----- | -------- | ---------------------------------------------------- | --------------- |
| `users`, `organization_memberships`   | no    | —        | `actors` carries the projection; `users` never syncs | —               |
| `workspaces`, `workspace_memberships` | no    | —        | `/auth/workspaces`; server-side auth only            | —               |
| `actors`                              | yes   | snapshot | members of joined rooms, plus authors seen           | per-user        |
| `agents`                              | yes   | snapshot | the workspace's                                      | per-user        |
| `rooms`                               | yes   | snapshot | joined                                               | per-room        |
| `room_members`                        | yes   | snapshot | of joined rooms                                      | per-room + user |
| `conversations`                       | yes   | snapshot | of joined rooms, plus private ones I am in           | per-room        |
| `conversation_members`                | yes   | snapshot | of those conversations                               | per-room        |
| `panels`                              | yes   | snapshot | of joined rooms, shared + mine                       | per-room        |
| `messages`                            | yes   | cursor   | conversations I may read                             | per-room        |
| `runs` _(Phase 5)_                    | yes   | **both** | see below                                            | per-room        |
| `run_events` _(Phase 5)_              | yes   | cursor   | runs in joined rooms; labels only (invariant 13)     | per-room        |
| `claims` _(Phase 10)_                 | yes   | snapshot | of joined rooms                                      | per-room        |

`conversations.sync_floor` narrows in meaning on this path: it is no longer a shape bound, it is
the **bootstrap floor** — how far back a brand-new device fetches on first sync. It stays a
column because the answer legitimately differs per conversation.

## Adding a table — how this scales

The point of D2 is that adding a table is a **classification, not a design**. Four steps, each
mechanical:

1. **Classify.** Small and mutable → snapshot. Large and append-only → cursor. Decide from the
   table's write pattern, not its current size.
2. **Server.** Snapshot: add the slice to `buildSnapshot()`, scoped by the entitlement query from
   `access.ts`. Cursor: add `GET /sync/<table>?after=`, same scoping, same overlap.
3. **Client.** One collection. Snapshot: `snapshot.configFor('<slice>')`. Cursor: a copy of
   `messagesSync` with the endpoint swapped.
4. **Doorbell.** One `after insert or update or delete` trigger calling the shared
   `notify_room_change()`.

No new endpoints for snapshot tables. No new mechanisms for either. The entitlement query is the
only piece of thought per table, and it is the same question the point check in `access.ts`
already answers.

**The third shape: large and mutable.** `runs` is one row per agent invocation — hundreds of
thousands a month at scale — whose `status` column changes while it is live and then never
again. Neither strategy fits alone; the split does:

- **History** — terminal runs — syncs by cursor. Append-only in practice, because a finished
  run never changes.
- **The live set** — runs not yet terminal — rides the snapshot. There are never many, and their
  updates are exactly what the snapshot handles.

The client sees one `runs` collection fed by both sources. This is the pattern for any table that
is "an append-only log with a small mutable head", which describes most things an agent produces.

### Where it stops, and what comes next

Both mechanisms have a ceiling, and each ceiling has a named escalation. Neither is near.

**The snapshot grows past what a connect can carry** — say ~10k rows per user, because
`room_members` or `actors` stopped being small. Escalation: a **change-log table**. A trigger on
each snapshot table writes `{seq, table, row_id, op, row_data}`; the client reads `seq > cursor`.
One cursor for everything, deletes captured. It is what Electric's shape log and PowerSync's
bucket ops are, built in-house — 2× write amplification, a partitioned log with a pruning cron
(the pattern `run_events` already uses), and the D5 trap on the sequence. Real work; well
understood; not needed until the snapshot is measurably too big.

**Per-user catch-up dominates Postgres** — it is the top entry in `pg_stat_statements` and read
replicas are not enough. That is the cost curve this design accepted knowingly: N clients in a
room are N queries, where a shared log would serve one cached response. Escalation: **adopt
Electric self-hosted** for the append streams, at the one swap point D1 names. By then the
decision is made with telemetry.

**Realtime message volume.** Supabase Pro includes 2.5M messages/month and 500 peak concurrent;
beyond that ~$10/M and ~$10 per 1,000 concurrent. The per-room-per-second coalescing is what keeps
this flat; without it a busy room fans out one message per change per member.

### Cost, for the record

Estimated at ₹88/USD, ~10 rooms per user, 30 messages/day per DAU, ~1 KB per row, peak
concurrent ≈ 25% of DAU. Only the layer that differs between engines is counted; Supabase,
Workers, WorkOS and R2 are common to all.

| Monthly, ₹           | 100 DAU | 1,000 DAU | 10,000 DAU |
| -------------------- | ------- | --------- | ---------- |
| **This design**      | 2,640   | 3,520     | ~16,300    |
| Electric self-hosted | 3,344   | 4,224     | ~10,600    |
| PowerSync Cloud      | 2,640   | 7,832     | ~17,500    |
| Zero self-hosted     | 4,048   | 4,928     | ~13,200    |

The spread at 1,000 DAU is under an hour of engineering time. At 10,000 DAU this design's number
is mostly Realtime overage, which coalescing softens. Infrastructure cost does not decide this;
engineering time, operational surface and vendor risk do.

## Developer experience

**Reading.** A component asks a question, not for data:

```tsx
const { data: thread } = useLiveQuery((q) =>
  q
    .from({ m: messages })
    .where(({ m }) => eq(m.conversationId, id))
    .join({ a: actors }, ({ m, a }) => eq(m.authorId, a.id))
    .orderBy(({ m }) => m.id),
);
```

Joins across collections happen on the device, reactively. No loading state to manage for synced
data — it is either there or it is arriving, and the query re-runs when it lands. The
`message → actor` join is why `actors` carries `display_name`: one hop, no `users`.

**Writing.** `messages.insert({...})`. The developer never touches the network. Optimistic apply,
queue, retry, idempotency and reconciliation are the outbox's job.

**Adding a table** is the four steps above. **Adding a field** is a migration and a type; the
snapshot and cursor carry whole rows, so nothing in the sync layer changes.

**Testing.** A sync source is a plain function over `SyncConfig`. The spike's `node:sqlite`
driver is the test harness: a real persisted collection, a fake `api`, no Electron, no native
build, milliseconds per test. Server endpoints test the way `rooms.test.ts` already does —
against local Postgres, with the guest / member / admin cast.

**Debugging.** The local SQLite file is a file — open it. The cursor and ETag are rows in
`collection_metadata`. Every sync endpoint is `curl`-able with a bearer, so "what would this
device receive" is a request, not a debugging session. There is no shape log or replication slot
to reason about.

**Local development.** Nothing new to run. `pnpm run up` already brings up Supabase, and Realtime
is part of it. The Worker is `pnpm dev`. That is the whole stack.

## Rejected

| Option                                            | Why it lost                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electric** (self-hosted; Cloud is winding down) | Shapes per (table, filter): requirement 5 costs ~200 subscriptions or a per-user shape that forfeits the CDN collapsing that was the whole argument. A stateful Elixir service with an NVMe volume, the one thing outside Cloudflare. Stewardship changed hands in August; the docs were a month stale about it                                                                                      |
| **PowerSync**                                     | The best off-the-shelf fit for the six requirements, and a real alternative. Lost on: a second vendor in the read path, a persistent stream per client with per-user buckets, and a sync-rules DSL that would have to express our auth union. The doc's _original_ rejection — "WASM SQLite / OPFS pain" — was false; TanStack's browser persistence is wa-sqlite over OPFS via PowerSync's own fork |
| **Zero**                                          | Heaviest infrastructure of any option: a replication-manager plus view-syncers, a full SQLite replica of Postgres on high-IOPS disk. Self-host only. Query-driven, so requirement 5 means holding preload queries for every room. The doc's "cost scales with clients × queries" is stale — IVM now scales with changed rows — but the conclusion stands                                             |
| **Convex**                                        | Reactive queries over WebSocket with an in-memory cache; no durable local store, so a cold start offline shows nothing. Would also replace Postgres, Drizzle, the WorkOS mirror and three migrations. PowerSync lists it as a _source_ — the backend half of a pairing, not the offline half                                                                                                         |
| `queryCollectionOptions` for the cursor           | Tracks row ownership per query key and garbage-collects claims; a moving cursor mints unbounded keys, and rows whose key is collected lose their owner. Silent data loss. `SyncConfig` directly is the right level                                                                                                                                                                                   |
| A change-log table from day one                   | Correct and general, and it is a sync engine — trigger per table, 2× writes, partitioned log, pruning cron, the D5 trap on its sequence. Named as the escalation, not the start                                                                                                                                                                                                                      |
| `updated_at` cursors on snapshot tables           | Same commit-ordering trap as D5, plus clock skew, plus a trigger per table, plus tombstones for deletes. The snapshot's absence-means-deleted needs none of it                                                                                                                                                                                                                                       |
| A daily time bucket for the sync bound            | Cannot be expressed anyway — but even where it could, it churns every conversation at once on a clock nobody controls                                                                                                                                                                                                                                                                                |
| Per-resource REST for writes                      | Two write paths with two sets of invariants. One endpoint calling the transactions in `rooms.ts`                                                                                                                                                                                                                                                                                                     |

## Hazards

- **L1 — the commit-ordering trap.** `id > cursor` without the overlap window loses rows silently
  and permanently. The window is in the first commit or the bug ships. (D5)
- **L2 — the snapshot outgrowing a connect.** If `room_members` or `actors` per user climbs into
  the tens of thousands, first-connect latency will say so before anything breaks. Watch the
  response size; the change-log escalation is the answer, not a bigger page.
- **L3 — per-user catch-up as the top query.** The accepted cost curve. `pg_stat_statements` is
  the signal; read replicas first, the Electric swap second.
- **L4 — a doorbell without coalescing.** One Realtime message per change per room member is the
  multiplier H2 warned about, on a different meter. Coalesce per room per second from the start.
- **L5 — snapshot tables that quietly become append-heavy.** `reactions`, when it arrives, is
  small per message and unbounded per user. Classify it deliberately (D2's third shape) rather
  than dropping it into the snapshot because it looks small today.
- **L6 — two durability stories on desktop.** Collections persist to SQLite through the Electron
  bridge; the outbox persists to IndexedDB with a localStorage fallback. A queued send and the
  messages it will join live in different stores. Verify what a mid-send quit leaves behind.
- **L7 — assuming the browser keeps what it stored.** OPFS is evictable. Anything treating local
  data as authoritative — a draft, a queued write — must survive its disappearance. Request
  `navigator.storage.persist()`; design for refusal.
- **L8 — the youngest dependency under the oldest promise.** `@tanstack/db` 0.8.7, Electron
  bridge 0.1.32. Pin exact versions; treat an upgrade as a change to a load-bearing component.
- **L10 — six connections is the whole budget.** A room is five shapes and each is an open
  long-poll; with `actors` that is six, which is exactly the HTTP/1.1 per-origin limit. A second
  room deadlocks the first. Electric warns about it in the console, and it was hit on the first
  real page load. HTTP/2 multiplexes them onto one connection. **Production must be HTTP/2 end to end** — this
  is not tuning; without it, "subscriptions are independent of what is rendered" is
  unimplementable. In dev it is opt-in: `RELAY_HTTPS=1 pnpm dev` puts Vite on a self-signed
  certificate and tells the Electron shell to accept it. Opt-in rather than default because
  the certificate cost a browser trust prompt plus a Chromium switch, and the wall only appears
  with a second room open — so flip it on for multi-room work and leave it off otherwise.
- **L11 — `cleanup()` is not "stop syncing".** It tears a collection down permanently, and
  collections are cached and shared. Calling it on release meant StrictMode's double-invoke
  destroyed the instance before the second retain reused it — the symptom was a room that
  rendered its chrome with every collection empty and _no shape ever requested_. Retain holds a
  `subscribeChanges` subscription instead; a collection syncs while it has subscribers and GCs
  when it does not.
- **L9 — a missing `messages` index.** The edits/deletes query needs one on
  `(conversation_id, greatest(edited_at, deleted_at))` or a functional equivalent. Without it the
  second query is a scan that grows with history.

## Steps

- [x] Spike: `SyncConfig`, `persistedCollectionOptions`, truncate scoping, incremental append,
      cursor persistence — all verified at runtime over `node:sqlite`
- [ ] `access.ts`: `visibleRooms`, `joinedRoomIds`, `readableConversationIds` — the set forms,
      placed beside the point checks they must agree with
- [ ] `GET /sync/snapshot` — `buildSnapshot()`, ETag, 304
- [ ] `packages/sync/src/collections/`: `SnapshotSource`, seven collections, the shared persistence
- [ ] The test harness: the spike's `node:sqlite` driver, promoted to `packages/sync/test/`
- [ ] **Render a room from local data with the network off** — the first thing on screen, before
      the hardest part is built
- [ ] `rewind()` and the overlap window; `GET /sync/messages?after=`; the `messages` collection
- [ ] Index for the edits/deletes query (L9); the second bounded query
- [ ] `notify_room_change()` trigger; per-room and per-user channels; RLS on `realtime.messages`;
      coalescing
- [ ] `POST /writes` with `idempotencyKey`; outbox wiring; the reconciliation on response
- [ ] `GET /sync/room/:id` for browsing unjoined rooms
- [ ] Bootstrap for a new device: snapshot then messages from `sync_floor`
- [ ] Browser adapter, `BrowserCollectionCoordinator`, and the degraded mode

## Questions to settle

- **How far back does a new device go?** `sync_floor` per conversation is the mechanism; the
  policy — a month, a thousand messages, everything — is a product statement.
- **Does the outbox belong in SQLite on desktop?** (L6.) Two stores is probably right for now;
  it should be a decision rather than an accident.
- **Electron multi-window and the outbox's leader election.** It assumes browser tabs. Phase 11,
  but the answer may constrain multi-window.
- **The degraded browser mode.** No persistence means in-memory collections and no offline. What
  does the UI say, and does anything become read-only?
- **`reactions`, when it comes.** Which of D2's shapes, and does it need the third-shape split?

## Candidates for ARCHITECTURE.md

1. **Reverse the Phase 2 sync-engine decision.** "ElectricSQL + TanStack DB" becomes "Supabase +
   TanStack DB with a sync source we own", with D1's reasoning and requirement 5 as the cause.
   The Electric section becomes the record of why it lost, not a plan. Phase 2's steps, nuances
   and exit criterion are rewritten around the snapshot and the cursor.
2. **Retire the shape vocabulary.** Invariant 1 ("shapes are scoped by…"), hazards H3 and H11,
   and the shape proxy in Phase 2 describe a design no longer being built. What replaces them: the
   two-strategy rule (D2) and the commit-ordering trap (L1) as a named hazard.
3. **RLS has one exception.** Phase 0's "No RLS" stands everywhere except `realtime.messages`,
   which Supabase requires for private channels (D7).
4. **Phase 3's write path is simpler than described** — no `awaitTxId`; the response carries the
   row (D8).
5. **Record the third table shape** — append-only log with a mutable head — as the pattern for
   `runs` before Phase 5 designs it.
