# PowerSync — the sync engine, re-argued

> **This supersedes the engine choice in [`local-first.md`](./local-first.md), and nothing else
> in it.** That document's requirements, its sync-window reasoning, its `sync_floor` design and
> its inheritance from [`rooms.md`](./rooms.md) all stand. What changed is the thing underneath:
> Electric is out, PowerSync is in. The tables do not move.
>
> Written 2026-09-07. Every price, limit and SDK claim below was checked against
> `powersync.com/pricing`, `docs.powersync.com` and `tanstack.com/db` on that date. Where a
> package is pre-1.0 it is called out as such, because that is the risk this document exists to
> price.
>
> This is a **reversal**, taken deliberately and recorded with its reasoning so it can be
> re-argued if circumstances change again — the same standard `rooms.md` and `local-first.md`
> are held to. It is not a repudiation of the Electric work; see _What carries over_.

**Done when:** launching with the network off shows rooms and messages from disk; a relaunch
resumes rather than re-downloads; a message written offline uploads once on reconnect; a room
you were not looking at is current when you open it; and every mutation is authorised on the
server before it reaches Postgres.

**Scope:** the sync engine and its client stack, the sync rules that replace the shape proxy,
the write path and its authorisation, and the cost model. Not the schema (`rooms.md`), not the
run lifecycle (Phase 5), not the ephemeral transport (deferred, see D7).

---

## Why this document exists

Electric announced it was [joining Databricks on 2026-08-11](https://electric.ax/blog/2026/08/11/electric-joining-databricks).
Electric Cloud is wound down. The engine stays Apache-2.0, but the team folds into Neon and
Lakebase, whose interest is embedded Postgres for agent sandboxes — not the sync server we
depend on.

We took the self-hosting bet in response and it worked: `phase-2-sync` has a functioning
read path, 178 tests green. The problem is not that it fails. The problem is what it costs to
keep:

- **We own the operations forever.** The replication slot, the WAL-retention hazard (H1, which
  needed its own `pnpm health` check), the volume, the version pin.
- **The maintenance future is unclear.** A dependency at the centre of the product, whose
  maintainers have been acquired into a different problem domain.
- **The write path is still unbuilt.** Phase 3 is ahead of us either way.

That last point is the timing argument, and it is the whole reason to move now rather than
later: migrating before the write path exists means rewriting the read path and _skipping_ the
write path. Migrating after means rewriting both. **This decision is cheaper today than it will
ever be again.**

The standing product requirements are unchanged and are what any engine is judged against:

1. A good desktop experience.
2. On open, everything from last session renders instantly.
3. That data is readable with no network.
4. Newer data may require the network.
5. Rooms sync in the background regardless of which one is on screen.
6. Writes are optimistic and feel instant.

---

## Decisions

### D1 — PowerSync Cloud replaces self-hosted Electric

Managed, paid, SOC 2 and HIPAA compliant since January 2026, and Postgres-native — it reads our
existing database by logical replication, so `packages/schema`, the Drizzle migrations, the
tenancy tables and the WorkOS mirror are all untouched.

It is chosen over the alternatives considered:

| Option                                   | Why not                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stay on self-hosted Electric**         | Works today, but we operate it forever and its OSS future is uncertain. The write path is unbuilt either way                                                                                            |
| **Zero (Rocicorp)**                      | Reached 1.0 in June 2026 and is genuinely good, but `zero-cache` is a service we would run. Swaps one self-hosted sync server for another                                                               |
| **Supabase Realtime + our own catch-up** | Realtime is a transport, not a sync engine — no cursor, no resume, replay capped at 25 messages over ~72 hours. We would build the sync engine ourselves, which is the work we are trying to stop doing |
| **Convex**                               | Removes the most infrastructure, but replaces Postgres entirely — schema, Drizzle, migrations, WorkOS mirroring, all of Phase 0 and 1                                                                   |
| **A managed chat SDK**                   | The most literal answer to "stop building chat", and wrong: rooms carry panels, webviews, agent runs and promotable private conversations, and agents need first-class access to that model             |

**The escape hatch is real and is part of the decision.** PowerSync's Open Edition is
source-available and self-hostable. If the company disappears we run it ourselves — a supported
product with a documented deployment, not an afterthought. That is a strictly better risk
profile than the one Electric Cloud left us with.

### D2 — TanStack DB stays, with PowerSync underneath it

`@tanstack/powersync-db-collection` provides `powerSyncCollectionOptions`. Critically there is
**no competing write path**: TanStack DB's `insert`/`update`/`delete` write directly into
PowerSync's local SQLite and ride its native CRUD upload queue. One write path, two views of it.

```
Postgres  ← packages/schema, Drizzle migrations (unchanged)
   ↓ logical replication
PowerSync Cloud  ← sync rules decide who gets which rows
   ↓ one connection
Local SQLite  ← @powersync/node (Electron main) · @powersync/web (browser)
   ↓ powerSyncCollectionOptions
TanStack DB collections
   ↓ useLiveQuery
React
```

Writes traverse it the other way:

```
collection.insert() → SQLite (instant) → CRUD queue
                    → connector.uploadData() → apps/server → access.ts → Postgres
                    → syncs back → optimistic state settles
```

| Layer              | Owns                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| **PowerSync**      | Server↔SQLite sync, offline durability, the upload queue, conflict resolution     |
| **TanStack DB**    | In-memory reactive queries, cross-collection joins, optimistic state and rollback |
| **TanStack Query** | Unchanged from `CLAUDE.md` — `/auth/*`, older history paging, anything not synced |

The three-way split in `CLAUDE.md` survives intact. Only what sits under DB changes.

**Why keep TanStack DB at all**, when PowerSync ships its own `useQuery`: because
`useLiveQuery` is already what `room.tsx` and `app-sidebar.tsx` are written against, so the
entire render layer ports unchanged. It also gives cross-collection joins — the
messages→actors lookup that `room.tsx` currently does with a client-side `.find()`. See P1 for
the risk this carries and the exit.

### D3 — One collection per table, not one per shape parameterisation

Today `packages/sync/src/collections/index.ts` is a factory and a cache, because an Electric
shape is a query and `messages` for one conversation is a different shape — and therefore a
different collection — from `messages` for another.

PowerSync has no such constraint: a table is a table locally, and filtering is a live query.
So the factory, the cache in `sync.tsx`, and the per-shape identity all collapse to one
collection per table.

### D4 — Sync streams replace the shape proxy for reads; `access.ts` moves to the write path

Reads are authorised by PowerSync **sync streams** (`config: edition: 3`), not the older
`bucket_definitions`: streams are GA, are what PowerSync recommends for new projects, and
carry on-demand subscription with a TTL cache — which is what lets a public room a viewer
has not joined be readable without syncing every such room in the workspace. The JWT carries `{user_id, organization_id}` and
never a workspace — which is exactly invariant 3, unchanged.

`apps/server/src/shapes/` and `packages/schema/src/shapes/` are deleted. But `access.ts` is
**not** deleted, and becomes more load-bearing than it was:

> With PowerSync the client writes to local SQLite freely. There is no server-side gate at
> write time. The only gate is the `uploadData` connector posting to our API — so a hostile
> client can queue any mutation it likes, and `/api/mutations` must authorise every operation
> before it reaches Postgres.

That endpoint is where `access.ts` lives, and the primary-key-lookup discipline it was built
with is exactly what a hot write path needs. See P2 and P7.

### D5 — everything on disk; memory decided separately by `syncMode`

Two independent things are called "sync" here and the distinction is load-bearing:

|                | Governs                       | Setting for relay                            |
| -------------- | ----------------------------- | -------------------------------------------- |
| **Sync rules** | Server → local SQLite         | Every room the actor is a member of. Always. |
| **`syncMode`** | SQLite → in-memory collection | `eager` for now — see below                  |

So ninety days of every room sits on disk (requirements 3 and 5), while only the open room's
messages occupy memory. `eager` would hydrate every message in every room into RAM.

### D6 — Requirement 5 becomes a sync rule, not a client-side budget

Background sync stops being the client's problem. `background-sync.tsx`, `warmRoomBudget()`
and the whole HTTP/1.1 connection-budget apparatus exist only because an Electric shape is one
long-poll and a browser allows about six per origin. PowerSync uses one connection for
everything.

Consequences: `RELAY_HTTPS` and the Electron `--ignore-certificate-errors` gate both go away.
They were scar tissue around a constraint that no longer exists.

### D7 — Ephemeral state never becomes rows

Presence, agent token streaming, cursor positions and terminal output are **not** synced rows.
They want a websocket — Supabase Realtime or a Durable Object — and they never touch Postgres.

This was already the right architecture. It now also has a price tag: an agent emitting 500
token events per run as rows, at 8 runs per user per day and a fan-out of 15, is ~12 MB per
user per day — roughly **14× the entire rest of relay's sync traffic**. See the cost model.

Choosing the ephemeral transport is deferred. It is not on Phase 2's critical path, and the
decision is better made when Phase 5 defines what a run actually emits.

### D8 — `sync_floor` bounds big rooms, and is now a cost control

`conversations.sync_floor` was defined in `rooms.md` for this document's benefit and read
nowhere else. It survives the engine change intact, and gains a second justification: fan-out
is bounded by room size, so a very large room is the one thing that can dominate the bill.
Bound how far back big rooms sync; page older history through a normal API request, which is
already what `CLAUDE.md` says Query is for.

### D9 — `@powersync/web` in the renderer, on both surfaces

**Reversed after the spike.** This first said `@powersync/node` in the Electron main process,
for the native-SQLite performance. It is the renderer instead, which is also PowerSync's own
recommendation.

The deciding constraint is D2: `powerSyncCollectionOptions` takes a live `PowerSyncDatabase`
instance, so TanStack DB collections can only exist where the database does. Running it in main
means the renderer reaches it over a hand-rolled IPC bridge and loses both PowerSync's React
hooks _and_ TanStack DB — the whole reason `room.tsx` ports unchanged. Native SQLite is
1.3–5.5× faster than WASM, and none of that matters at chat scale; being unable to use the
query layer does.

Three things follow, all of them simplifications:

- **No IPC bridge.** `packages/persist-sqlite` and the `bridgeVersion: 7` persistence channel
  are deleted rather than replaced.
- **No native module.** wa-sqlite is WebAssembly, so `better-sqlite3` and the Electron rebuild
  step it would have forced are both gone — which retracts finding 5 from the spike below.
- **One code path.** The desktop renderer and a browser tab run the same SDK against the same
  schema, so D9's "declared once, consumed by both" is literal rather than aspirational.

The cost is that Electron's renderer must be able to use OPFS, which needs a real HTTP origin.
That holds in development; Phase 11 has to keep it true when the bundle is served from disk,
and `IDBBatchAtomicVFS` is the fallback if it cannot.

wa-sqlite over a VFS, with `OPFSCoopSyncVFS` for multi-tab including Safari, falling back to
the IndexedDB VFS. No COOP/COEP headers required for those paths. This also deletes
`packages/persist-idb`, which was a stub we would have had to write.

### D10 — Panels stay Electron-only

Unaffected by the engine change, but recorded here because it bounds what the browser surface
can ever be. Embedding arbitrary third-party pages is a Chromium capability: `X-Frame-Options`
and `CSP: frame-ancestors` let any site refuse an iframe, same-origin policy blocks reading or
driving it, and third-party cookie policy means the embedded page is not logged in.

The `partition: 'persist:agent'` design — an agent acting inside the user's own authenticated
sessions — is not reproducible in a browser tab at all. That is a reason relay is a desktop
app, not a defect.

**PowerSync carries a panel's identity and state (the `panels` row); the panel's content is
whatever that panel is.** A webview panel is a viewport, never a sync client.

---

## Cost model

PowerSync Cloud, at ₹94.7/USD (2026-09-06).

|                         | Free    | Pro $49           | Team $599           |
| ----------------------- | ------- | ----------------- | ------------------- |
| Data synced             | 2 GB/mo | 30 GB/mo          | 30 GB/mo            |
| Data hosted             | 500 MB  | 10 GB             | 10 GB               |
| Peak concurrent clients | 50      | 1,000 (max 3,000) | 1,000 (max 10,000+) |

Overages are identical on both paid tiers: **$1/GB synced**, **$1/GB hosted**, **$30 per extra
1,000 concurrent clients**, **$25/mo per extra instance**. Team buys headroom and higher caps,
not a better rate.

**Assumptions.** Fan-out is what makes a sync engine expensive: a row is written once and
billed once per client that receives it. Modelled at 25 human messages (~500 B) and 30 agent
messages (~1,500 B) per DAU per day, 1.4 devices per user, +15% for re-syncs, and a fan-out
equal to average room membership.

| DAU    | Synced/mo | Peak clients | Tier           | **₹/month**  |
| ------ | --------- | ------------ | -------------- | ------------ |
| 10     | ~0.2 GB   | ~8           | Free           | **0**        |
| 100    | ~3.3 GB   | ~70          | Pro            | **4,600**    |
| 1,000  | ~42 GB    | ~600         | Pro + overage  | **6,700**    |
| 10,000 | ~500 GB   | ~6,000       | Team + overage | **1,33,000** |

**The Pro→Team cliff.** Pro caps peak concurrent clients at 3,000. With a desktop app people
leave open, expect ~55% of DAU concurrent at peak — so the wall arrives near **5,000 DAU** and
the base jumps 12×. Everything below that is cheap.

**Three levers control the bill**, in order of magnitude:

1. **Never make `run_events` synced rows** (D7). Worth ~₹31,000/mo at 10,000 DAU.
2. **Bound large rooms with `sync_floor`** (D8). One 10,000-member room taking 1% of messages
   is ~2.5 TB/month on its own — more than doubling the total.
3. **Archive history out of the synced set past ~90 days.** Hosted data otherwise grows at
   ~1.65 GB/month per 1,000 DAU, forever.

Do all three and the 10,000-DAU figure lands nearer ₹85,000–95,000. For perspective: at that
scale LLM inference will be tens of lakhs per month, so this is under 2% of infrastructure.
**Cost is not a reason to hesitate at any tier reachable in the next 18 months.**

---

## Hazards

| #      | Hazard                                                                                               | Mitigation                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | `@tanstack/powersync-db-collection` is **Alpha**                                                     | PowerSync's own `useQuery` (with Kysely for types) is stable and covers ~90% of our needs. The exit is dropping TanStack DB and writing the queries as SQL — about half a day across two files. Know the exit before committing |
| **P2** | Clients write to local SQLite unauthorised; only `/api/mutations` gates them                         | `access.ts` authorises every operation in the CRUD batch. No mutation reaches Postgres unchecked. This is the single most security-critical file in the new architecture                                                        |
| **P3** | Browser storage is evictable — Safari ITP drops script-created data after 7 days without interaction | The browser surface is a convenience client that can always re-sync, never the source of truth. Call `navigator.storage.persist()`. Requirement 3 is a hard guarantee on desktop and best-effort in browser                     |
| **P4** | Hosted data grows without bound                                                                      | D8's archival policy. Needs a scheduled job, and a decision on retention                                                                                                                                                        |
| **P5** | A single large room dominates sync cost                                                              | D8. Needs a threshold above which a room is not fully synced                                                                                                                                                                    |
| **P6** | Vendor dependency on a startup                                                                       | Open Edition is source-available and self-hostable. The ceiling is a choice, not a trap                                                                                                                                         |
| **P7** | Sync rules and `access.ts` are two authorisation surfaces for the same data, and can drift           | They must be tested against each other: a fixture asserting that what a sync rule delivers matches what `mayReadRoom`/`mayReadConversation` would allow. Non-negotiable — a drift here is a silent data leak                    |
| **P8** | PowerSync needs logical replication on the source database                                           | Not reachable from a laptop's Supabase without a tunnel. Decide the spike's database before starting                                                                                                                            |

---

## The spike

Timeboxed to **two days**, on a throwaway branch. `phase-2-sync` is not touched — the Electric
work stays intact and pushed, and remains the fallback.

1. PowerSync Cloud project, pointed at a Postgres with our existing migrations applied.
2. Sync rules for `actors`, `rooms`, `room_members`, `conversations`, `messages` — with a
   parameter query resolving workspace and room membership from the JWT.
3. An endpoint in `apps/server` minting a PowerSync JWT from the WorkOS session.
4. `@powersync/node` wired into the Electron main process, replacing `packages/persist-sqlite`.

**Exit criteria — exactly four, and nothing else:**

- A public room's messages sync to a member.
- A private room admits only its members, enforced by the sync rule and not by the client.
- Kill the network, restart the app: the data is still there.
- Send a message: instant locally, reconciles cleanly when it lands.

**If any of these fails in a way that is not obviously fixable, delete the branch, return to
`phase-2-sync`, and go build the agent runtime.** The point of the timebox is a decision in two
days rather than a drift over three weeks. The runtime is the product; this is the foundation
under it, and it is allowed to be good enough.
---

## The spike — result

**Run 2026-09-07 against a live PowerSync Cloud instance. All four exit criteria pass.**

|     | Criterion                              | Evidence                                                                                                                                                         |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A public room's messages sync          | Member's device held all 37                                                                                                                                      |
| 2   | A private room admits only its members | Member saw `founders`; a workspace member who was not in it received **no rows at all** — the exclusion is the stream refusing to send, not the client filtering |
| 3   | Relaunch with no network               | Reopened the database without ever calling `connect()`; all 37 messages and 5 rooms present                                                                      |
| 4   | Write is instant and reconciles        | Local read **1ms** after insert; uploaded through the real `access.ts`; round-trip reconciled 37 → 38                                                            |

Also verified: a workspace member who has joined nothing still sees the room _directory_ (4 public
rooms) while syncing **zero** room contents. That is D8's cost model working — a workspace costs
what its members read, not what everyone could read.

### What the spike changed

Five findings, four of which changed code:

1. **Sync streams, not sync rules** (D4). The syntax we validated is `config: edition: 3`
   with `streams:`, `auth.parameter('...')` for custom claims and `subscription.parameter('...')`
   for client-supplied ones.
2. **A CTE cannot reference a sibling CTE.** The first deploy reported `my_memberships` and
   `readable` as "tables not found" when used from another `with:` entry — referencing them
   from `queries:` is fine. Both dependencies are inlined, and the repetition is deliberate.
3. **Every synced table needs a text primary key named `id`.** `room_members` and
   `conversation_members` were keyed on a pair and could not be synced at all; both grew a
   surrogate in `20260906223042_membership_surrogate_keys.sql`, with the pair demoted to a
   unique constraint so the hot-path lookup keeps its index.
4. **P8 was a false alarm.** PowerSync Cloud reaches `db.<ref>.supabase.co:5432` directly — no
   IPv4 add-on, no pooler. (A local Docker container cannot, for want of IPv6 on the bridge,
   which is why migrations are pushed from the host.)
5. **`@powersync/node` depends on `better-sqlite3`** — which is why the spike needed a native
   build. ~~A cost for Electron packaging.~~ **Retracted:** D9 moved to the renderer and the
   web SDK, so no native module is involved at all. The finding stands only as the reason not
   to take the main-process path casually.

### What is deployed

`tooling/powersync/` holds the instance as code — `service.yaml` (connection + `client_auth`)
and `sync-config.yaml` (the streams), deployed with `powersync deploy`. Secrets are `!env`
references resolved from a gitignored `.env`, so both files are safe to commit. **The CLI reads
real environment variables, not that file** — `set -a; . tooling/powersync/.env; set +a` before
deploying, or the connection test fails with a misleading password error.

The Postgres publication is scoped rather than `for all tables`: the seven synced tables plus
`workspace_memberships`, which the parameter queries read. `users` is deliberately excluded —
it is the WorkOS mirror and carries emails, and leaving it out means PowerSync never _ingests_
it, not merely that no stream selects it.

---

## What carries over from `phase-2-sync`

The Electric work is not wasted, and most of it was never about Electric.

| Survives unchanged                                             | Rewritten                                                                     | Deleted                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/schema` — every table and migration                  | `packages/sync/src/collections/` — same `createCollection`, different options | `packages/persist-sqlite`                             |
| `access.ts` — and becomes load-bearing (D4)                    | `apps/client/src/lib/sync.tsx` — much smaller                                 | The preload persistence bridge, `bridgeVersion: 7`    |
| `room.tsx`, `app-sidebar.tsx` — `useLiveQuery` is the same API | `packages/schema/src/shapes/` → sync rules                                    | `apps/server/src/shapes/` and its tests               |
| Tenancy, auth, the WorkOS mirror, navigation, the shell        |                                                                               | `packages/sync/src/persister.ts`, `subscriptions.ts`  |
| `rooms.md` and its schema decisions entirely                   |                                                                               | `background-sync.tsx`, `warmRoomBudget()`             |
| `conversations.sync_floor` (D8)                                |                                                                               | `tooling/docker/compose.yaml`, the doctor slot checks |
|                                                                |                                                                               | `RELAY_HTTPS`, the Electron certificate gate          |

`rooms.md` claimed the tables were engine-agnostic by design. This is the test of that claim,
and so far it holds: **nothing in the schema moves.**

---

## Questions to settle

1. **Which Postgres does PowerSync read?** Local Supabase needs a tunnel (P8). Is there a
   throwaway hosted instance for the spike, and what is production?
2. **How are sync rules kept honest against `access.ts`?** (P7.) A shared fixture, or generated
   from one source?
3. **What is the retention boundary** past which history leaves the synced set (D8, P4) — and
   is it per conversation, per room, or global?
4. **Above what size is a room not fully synced?** (P5.)
5. **Does the guest model express cleanly as a parameter query?** Org membership without
   workspace membership is the case to prove; it is what makes guests work without FGA.
6. **Which ephemeral transport** (D7) — and does it wait for Phase 5?

## Candidates for `ARCHITECTURE.md`

Not edited here; recorded for a deliberate pass, per the working agreement.

- Phase 2's engine is PowerSync, not Electric. The phase's shape and exit criteria survive.
- Invariant: **ephemeral state is never a synced row** (D7).
- Invariant: **every mutation is authorised server-side at `/api/mutations`** — the client's
  local database is not a trust boundary (D4, P2).
- Invariant 3 is unchanged and now enforced by the JWT's claims.
- Phase 4 (Local Persistence) is largely absorbed into Phase 2: PowerSync ships it.
- Phase 12's browser adapter is likewise absorbed (D9).
- The panel concept is desktop-only, and that is a product decision, not a limitation (D10).
- H1 (Electric's replication slot retaining WAL) is retired — it was our slot, and it is gone.
