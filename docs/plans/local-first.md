# Local-first — shapes, persistence, and how much history lives on the device

> Working plan, and the sibling of [`rooms.md`](./rooms.md). That document decides the tables;
> this one decides **what syncs, what persists, and what a user can still see with the network
> off.** They are deliberately separate: the schema can be built and reviewed without settling
> any of this, and this can be settled without reopening the schema.
>
> Every claim here about what Electric, TanStack DB or the persistence adapters actually do was
> verified on 2026-09-06 against `electric.ax` and against the published packages — several of
> them are undocumented and were read from source, with file and line cited. `ARCHITECTURE.md`
> is treated as product intent, not as a technical reference; three places where it is wrong are
> recorded in _Candidates_ at the bottom.

**Done when:** launching with the network off shows rooms, messages and agent traces from disk;
a relaunch resumes the shape log instead of re-reading it; a message written offline sends once
on reconnect; and history a user has already read stays on their device.

**Scope:** shape definitions and the proxy that serves them, the sync window and the retained
archive, the persistence stack on desktop and browser, and the write path's reconciliation.
Not the room and chat schema (`rooms.md`), not the run lifecycle (Phase 5), not search ranking.

**Order.** `rooms.md` goes first — it is schema, it blocks Phase 2, and nothing here changes it.
This document is the second half, and its first real deadline is Phase 4.

## Where things stand

| #   | Step                                                        | State |
| --- | ----------------------------------------------------------- | ----- |
| 0   | Electric self-hosted locally, with slot alerting            | ☐     |
| 1   | Shape definitions in `packages/schema`, server-side only    | ☐     |
| 2   | Shape proxy: unseal → authorise → proxy                     | ☐     |
| 3   | Subscription registry (effect-with-inverse) and its tiering | ☐     |
| 4   | Persisted collections on Electron                           | ☐     |
| 5   | The retained archive as a local-only collection             | ☐     |
| 6   | `sync_floor` advance policy, server-side                    | ☐     |
| 7   | Write path: mutation handlers returning txid                | ☐     |
| 8   | Offline outbox                                              | ☐     |
| 9   | Browser adapter and the degraded mode                       | ☐     |

## What this inherits from `rooms.md`

Three of that document's decisions are load-bearing here, and one column exists only for this
one.

| From `rooms.md`                                           | Why it matters here                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **D5** — the conversation, not the room, is the sync unit | Every message shape is `conversation_id = $1`. Privacy is structural: a private conversation is a different shape non-members never request |
| **D6** — `messages` carries no `room_id`                  | Promotion moves a conversation between places without rewriting rows, so it never invalidates a shape's contents                            |
| **D11** — UUIDv7 primary keys                             | Ids sort chronologically, so a sync floor is a primary-key range and a merged timeline is a sorted merge                                    |
| **`conversations.sync_floor`**                            | Exists solely for D3 below. `rooms.md` carries the column; this document is the only thing that reads it                                    |

## The shapes

Every where clause is row-local equality. No joins, no subqueries, nothing gated on a plan tier.

| Shape                  | Where                                    | Shared by                         |
| ---------------------- | ---------------------------------------- | --------------------------------- |
| `actors`               | `organization_id = $1`                   | everyone in the org               |
| `agents`               | `workspace_id = $1`                      | everyone in the workspace         |
| `rooms`                | `id = $1`                                | every member                      |
| `room_members`         | `room_id = $1`                           | every member                      |
| `conversations`        | `room_id = $1 and visibility = 'shared'` | every member                      |
| `messages`             | `conversation_id = $1 and id >= $floor`  | every member of that conversation |
| `panels`               | `room_id = $1 and visibility = 'shared'` | every member                      |
| a private conversation | `conversation_id = $1`                   | its members                       |
| the directory (D2)     | `actor_id = $1`                          | one person                        |

`rooms.md` D1 is what keeps this list short: `actors` carries `display_name` and `avatar_url`,
so it alone renders every name and avatar and `users` never has to sync.

## Decisions

### D0 — Electric is self-hosted; Electric Cloud is winding down

Electric was acquired by Databricks on 11 August 2026 and **Electric Cloud is winding down** —
"Cloud users will need to self-host or move to another provider". No public shutdown date, and as
of 2026-09-06 the docs still say Cloud is the recommended production path, which is worth knowing
when reading them.

The engine stays Apache 2.0, TanStack DB explicitly included, and the read-path economics are a
property of the protocol rather than the host — so the decision holds. **PowerSync was re-checked
rather than inherited**, because the reason recorded against it turned out to be false: it was
rejected for "WASM SQLite / OPFS pain", and TanStack's own browser persistence is wa-sqlite over
OPFS via PowerSync's fork. The real reason is better: PowerSync holds a persistent stream per
client and its buckets are scoped per user, not shared — so nothing collapses at a CDN and cost
grows with concurrent clients, which is Zero's curve. Their figure is tens of thousands of
concurrent clients per service instance; Electric's is 100k–1M on one server.

**What self-hosting actually needs**, from the deployment guide:

|                        |                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Image                  | `electricsql/electric`                                                                               |
| `DATABASE_URL`         | **Direct** connection. Poolers do not carry logical replication                                      |
| `ELECTRIC_STORAGE_DIR` | A persistent volume — shape logs and metadata live on disk                                           |
| `ELECTRIC_SECRET`      | Added by the proxy, never sent by a client                                                           |
| Postgres               | 14+, `wal_level=logical`, a user with `REPLICATION`. Publication and slot auto-created if privileged |
| Sizing                 | Disk speed first, then memory, then CPU. NVMe preferred                                              |
| Health                 | `/v1/health` → 200 `active`, 202 `waiting`/`starting`                                                |

**It is stateful, so it cannot go on Workers** — the one piece of this stack that does not live on
Cloudflare, and exactly what H8 warned about, now applied to the engine rather than the proxy. The
shape is: client → Worker (proxy, auth, cache headers) → Electric (small always-on host, fast
disk) → Postgres. The Worker is still where CDN collapsing happens, so the economics are unchanged.

**The on-disk log is derived.** Lose the volume and Electric rebuilds from Postgres; there is no
backup story to write. Clients take a `must-refetch`, which is survivable and is exactly D4.

**Neon / Lakebase is not an alternative today** — serverless Postgres with branching and
autoscaling, no sync product announced. Watch it; do not wait for it.

### D1 — Shape parameters are set at the proxy, never by the client

`electricCollectionOptions` takes a URL, not a where clause: shape configuration "happens at the
proxy level, not in client code". The client asks for a collection; the proxy decides the
`table`, `where` and `columns` it may have.

That is the shape-proxy design already planned, and it means the authorisation table in
`rooms.md` is enforced where it is written rather than trusted to a client parameter. A client
that asks for someone else's private conversation gets a rejection, not a filtered result.

### D2 — The directory is a shape, because a request is not local-first

"Which rooms am I in, and which private conversations" is per-user, and invariant 1 says shapes
are never per user. The tempting answer is a TanStack Query call — and it is wrong, because
Query is not local-first: on an offline cold start the room list would be empty while every
room's messages sat in SQLite. That fails the one thing this document exists to deliver.

So `room_members where actor_id = $1` and `conversation_members where actor_id = $1` are real
shapes, as a **deliberate, bounded exception**:

- Tens of rows, a few columns each.
- Changing on join, leave and create — a few times a week, not per keystroke.
- H3's real cost is per-user _message_ shapes, where the volume is. Those stay conversation-
  scoped and fully shared.

The alternative is a persisted Query cache, which is a third storage mechanism beside the
collections and the outbox. Two small shapes buy one mechanism for everything.

### D3 — Time bounds cannot use `now()`, so the floor is a column

Electric where clauses "cannot use non-deterministic SQL functions like `count()` or `now()`",
and there is no `LIMIT` — a shape is a row-local predicate, so neither "the last 7 days" nor
"the last 500 messages" is expressible. `ARCHITECTURE.md` asserts time-bounded shapes in three
places and never says how, and the obvious workaround is harmful: baking a literal timestamp in
at subscribe time gives every client a different shape definition, so nothing collapses at the
CDN and the read-path economics that chose Electric evaporate.

**So the bound is `conversations.sync_floor`** — a message id below which clients do not sync.
The shape is `conversation_id = $1 and id >= $floor`, and the floor comes from the conversation
row the client already holds. Every member computes the same shape, so the CDN still collapses
them, and because ids are v7 the floor is a primary-key range on the index that already serves
paging.

**Advancing the floor is expensive, which sets the policy in D5.** The Electric collection
persists `{offset, handle, shapeId}` under `electric:resume` and reuses it on the next launch —
but only when the shape identity is unchanged (`hasIncompatiblePersistedResume`,
`electric.js:738`). A changed where clause is a changed shape, so an advance discards the resume
state and re-downloads that conversation's window.

A daily time bucket would do that **to every conversation, for every client, every day** — H11
on a daily cadence, with a full local truncate each time (D4). A per-conversation floor moves
when that one conversation needs it to, and never for the rest.

### D4 — A shape-backed collection is a cache; the archive is the real store

Read from `@tanstack/electric-db-collection` 0.4.7, because neither vendor documents it:

- The collection maps Electric's `operation` header straight through, `delete` included
  (`electric.js:855`). Electric communicates "this row left your shape" **as a delete**, so the
  collection emits one and the persister removes the row and tombstones it.
- A `must-refetch` control message calls `truncate()` (`electric.js:973`), wiping the entire
  local collection before rebuilding it.

**Nothing that must outlive a shape change may live in a shape-backed collection.** So there are
two tiers, and the distinction is the same derived-vs-precious split Phase 4 already draws,
applied one level lower:

|           | The live window                      | The retained archive                                            |
| --------- | ------------------------------------ | --------------------------------------------------------------- |
| Backed by | an Electric shape                    | nothing — `local-only`                                          |
| Contents  | `id >= sync_floor`                   | every message this device has ever seen                         |
| Lifetime  | truncated whenever the shape changes | never truncated                                                 |
| Fed by    | the shape log                        | rows arriving in the window, plus history paged from the server |
| Bounded   | yes, by D5                           | no                                                              |

`persistedCollectionOptions` has a `PersistedLocalOnlyOptions` overload, so the archive is the
same API and the same SQLite file — a second collection, not a second mechanism.

**Reading a conversation is a merge of the two, deduped by id.** Because ids are v7 and sort
chronologically, that is a merge on a sorted key rather than a sort.

**The duplication is bounded, not doubled.** A message in the window is also in the archive, but
the window is capped by D5 at a few thousand rows per conversation while the archive is
unbounded — so the overlap is a few megabytes per conversation, not a copy of history. Keeping
the window persisted is what preserves the resume state, and therefore H11.

The one mechanical unknown left: confirm a `local-only` collection beside a shape-backed one is
not truncated with it. It has its own table and its own collection id, so it should not be —
but this is the assumption the whole tier rests on, so it gets a test rather than a shrug.

### D5 — Retention: a count-based window with hysteresis, and an archive that keeps everything

**The window is capped by message count per conversation, not by time.** Time buckets move on a
clock nobody controls and move for every conversation at once; a count moves only for the rooms
that are actually busy, and most rooms never reach it at all.

**Target 5,000 messages, advanced with hysteresis:** a conversation gets a floor only when it
exceeds 10,000, and the advance trims it back to 5,000. So the shape changes once per 5,000
messages rather than continuously, and the re-download D3 describes is paid roughly once every
fifty days in a busy room and never in a normal one.

Sizing, at roughly 0.5–1 KB per message row all-in:

|                                     | messages | on disk |
| ----------------------------------- | -------- | ------- |
| A 5,000-message window              | 5,000    | ~5 MB   |
| A busy room (100/day), one year     | ~36,000  | ~36 MB  |
| 20 active rooms, one year, archived | ~365,000 | ~365 MB |

None of that troubles SQLite on a desktop, and **memory is not the constraint either**:
`LoadSubsetOptions` carries `where`, `orderBy`, `limit`, `cursor` and `offset`, with a matching
unload, so a large archive is windowed into memory as someone scrolls rather than held whole.

**The archive is unbounded on purpose.** It is the user's own data in a file that grows slowly.
If it ever needs a limit that is a preference — "keep the last N months offline" — not an
engineering constraint, and it should not be invented before someone asks.

**What this means in the product's own words:** every room you have been in, as far back as you
have read, available offline and instantly searchable. Only a new device, or a room you have
never opened, needs the network.

### D6 — Writes: txid matching, and one txid across several collections

Electric is read-path only and "intentionally doesn't prescribe a built-in write solution".
TanStack DB reconciles by transaction id: the mutation handler returns the txid of the
transaction that performed the write, the client calls `awaitTxId()`, and TanStack DB "blocks
sync data until the mutation is confirmed". The documented requirement is to query the txid
**inside** the same transaction as the mutation.

`rooms.md` writes across several tables at once, so:

- **Room creation** is three inserts (`rooms`, `conversations`, `room_members`) and **promotion**
  is two updates (`conversations`, `panels`). One Postgres transaction yields one txid, so every
  affected collection awaits the same value — the write endpoint returns it once and the client
  feeds it to each collection.
- **Archiving a room** stamps four tables at once. Same mechanism, wider fan-out, and the reason
  it is one transaction rather than a cascade of writes.

### D7 — Exclude the `search_text` projection from every shape

Electric shapes take a column allow-list. `messages.search_text` duplicates `body` on the wire for
every message and exists only for the server's `tsvector`; clients derive their own text from
the blocks. Excluding it roughly halves the message shape's bytes.

Invariant 13 applies to `body` for the same reason — labels in Postgres, payloads in object
storage. A block carrying an agent's tool output is that invariant broken on the highest-volume
table in the product.

### D8 — The desktop stack exists, and we build less than the doc assumed

`ARCHITECTURE.md` says Phase 4 was rewritten around `persistedCollectionOptions` and
`db-sqlite-persistence-core`. Both exist, and so does more than it knew — none of it in
TanStack DB's documentation index, so this was read from the published packages:

| Package                                    | Version    | What it is                                  |
| ------------------------------------------ | ---------- | ------------------------------------------- |
| `@tanstack/db`                             | 0.8.7      | the collection engine                       |
| `@tanstack/electric-db-collection`         | 0.4.7      | the Electric sync source                    |
| `@tanstack/db-sqlite-persistence-core`     | 0.2.20     | `persistedCollectionOptions`                |
| `@tanstack/node-db-sqlite-persistence`     | 0.2.20     | Node adapter over a `better-sqlite3` handle |
| `@tanstack/electron-db-sqlite-persistence` | **0.1.32** | main-process bridge + renderer client       |
| `@tanstack/browser-db-sqlite-persistence`  | 0.2.20     | wa-sqlite over OPFS                         |
| `@tanstack/offline-transactions`           | 1.0.53     | durable outbox, retry, leader election      |

All published 2026-08-31.

**Invariant 10 holds by construction.** The Electron bridge runs `better-sqlite3` in the main
process and exposes it to the renderer over IPC, re-exporting the same `persistedCollectionOptions`
the browser adapter uses. Same API, two adapters, and `packages/sync/src/local/` already has the
seam from `navigation.md`.

**What arrives for free:**

- `persistedCollectionOptions` **wraps** a sync config rather than replacing it, and declares a
  `PersistedCollectionMode` of `sync-present` or `sync-absent` — offline cold start is a
  first-class mode, not an accident.
- The adapter owns its SQLite schema: a table per collection plus `collection_metadata`,
  `applied_tx`, `collection_version`, `schema_version`, `collection_reset_epoch`, a tombstone
  table, and `leader_term` for multi-process coordination.
- Shape resume across restarts (D3). **That is H11, solved upstream** — the hazard the doc kept
  for us to test is now someone else's code, and testing it becomes a regression check rather
  than a design task.

**What stays ours:**

| Ours                                                        | Theirs                                  |
| ----------------------------------------------------------- | --------------------------------------- |
| The shape proxy and the auth paths                          | Shape transport, resume, local SQLite   |
| The write endpoint — handlers, txid return (D6)             | Optimistic reconciliation, `awaitTxId`  |
| The cross-room subscription registry and its tiering        | Per-collection sync lifecycle           |
| The retained archive and history paging (D4)                | Persistence of shape-backed collections |
| `sync/src/local/` view state — tab strip, panel arrangement | The adapter under it                    |

### D9 — The browser persists too, but durability is best-effort

`@tanstack/browser-db-sqlite-persistence` is wa-sqlite over OPFS, sharing the same core and
re-exporting the same options.

**It does not need cross-origin isolation**, which is the thing that would have hurt. The
prerequisite check is only `navigator.storage.getDirectory` and `Worker` — no `SharedArrayBuffer`,
no `crossOriginIsolated`. COOP/COEP would have meant CORP headers on every asset and broken
embeds, in a product whose thesis is embedding other people's pages.

Three real differences from desktop:

- **Storage is evictable.** OPFS sits under the origin quota, and Safari caps script-writable
  storage at seven days without user interaction. `navigator.storage.persist()` improves the odds
  and is granted on heuristics. So on browser, local-first means "fast and offline-capable while
  the data is there" — not "your history is on your disk". D5's archive is a promise desktop can
  keep and the browser cannot.
- **Multi-tab coordination is opt-in and effectively mandatory.** The default is
  `SingleProcessCoordinator` — no leader election, no `BroadcastChannel`, no Web Locks — correct
  only if the app is open in exactly one tab, which a browser app never is.
  `BrowserCollectionCoordinator` elects a leader over Web Locks and fans transactions out over
  `BroadcastChannel`, followers RPC-ing writes to the leader.
- **There is no fallback.** Missing prerequisites throw `PersistenceUnavailableError` rather than
  degrading to IndexedDB. Private browsing, an old Safari or blocked storage means no persistence,
  so **we** own the degraded mode: in-memory collections, no offline, and a UI that says so.
  `packages/sync/src/platform.ts` types `persistence` as `'sqlite' | 'indexeddb'` today and wants
  `'sqlite' | 'opfs' | 'memory'`.

**And the PowerSync rejection is stale.** The peer dependency is `@journeyapps/wa-sqlite` —
PowerSync's own fork. `ARCHITECTURE.md` rejected PowerSync "on browser grounds (WASM SQLite /
OPFS pain)" and the chosen path runs on PowerSync's wa-sqlite over OPFS. Electric still wins on
read-path economics, which was always the reason that mattered; the browser line should be struck.

### D10 — What a room looks like on the browser surface

- **`panels` of kind `browser` cannot render.** There is no `<webview>`, and `X-Frame-Options` /
  CSP blocking naive iframes is precisely why Electron was chosen. So a panel degrades to what
  the row already is — a URL — and opens in a new tab. The room still shows _what is open and who
  opened it_, which is most of the value. `terminal` and `sandbox` degrade the same way, and
  nothing in the schema changes: the renderer switches on `kind` and on the platform capability.
- **L2 bites harder.** Five shapes per active room is survivable over HTTP/2, where the limit is
  concurrent streams rather than six connections — but any downgrade to HTTP/1.1 makes six a hard
  wall. The subscription tiering that is a nicety on desktop is load-bearing here.

## What local-first does not buy

Worth stating plainly so it is not discovered in a demo. Offline, a user can read, search and
review everything already synced, and queue a message that sends on reconnect. They cannot start
an agent run, and they cannot load a webview panel — the runtime is server-side and the artifacts
live in Notion and Google Docs by design.

That is the right half to have offline. The product's thesis is that it owns _who is doing what
to which part_; the record is the thing worth carrying, and the doing was always going to need
the network.

## Hazards

- **L1 — treating a shape-backed collection as storage.** It is a cache and it gets truncated
  (D4). Anything that must survive a shape change belongs in the archive, and a later
  "simplification" that merges the two deletes user history.
- **L2 — five shapes per active room.** Electric covers one table per shape, so a room is
  `rooms`, `room_members`, `conversations`, `messages` and `panels`, plus one more `messages`
  shape per promoted panel chat. Phase 2 worried about forty subscriptions for someone in forty
  rooms; the real number is nearer two hundred, and the tiering stops being an optimisation.
- **L3 — a floor that advances too often.** Every advance discards the resume state and
  re-downloads the window (D3). Continuous trimming would turn a bounded cost into a constant
  one; D5's hysteresis is the whole reason the threshold and the target are different numbers.
- **L4 — two durability stories on desktop.** Collections persist to SQLite through the Electron
  IPC bridge; `@tanstack/offline-transactions` persists its outbox to IndexedDB with a
  localStorage fallback. A queued send and the messages it will join live in different stores
  with different failure modes. Verify what a mid-send quit leaves behind.
- **L5 — assuming the browser keeps what it stored.** OPFS is evictable and Safari caps
  script-writable storage at seven days without interaction. Anything that treats local data as
  authoritative — an unsent draft, a queued write, a read cursor — must survive its
  disappearance. Request `navigator.storage.persist()`, but design for the refusal.
- **L6 — the youngest dependency under the oldest promise.** `@tanstack/db` is 0.8.7 and the
  Electron bridge 0.1.32, both published a week before this plan, and local-first is a goal from
  day one. Pin exact versions, keep the persister behind the `sync/src/local/` interface, and
  treat an upgrade as a change to a load-bearing component.

## Steps

- [ ] **H1 first, genuinely.** `electricsql/electric` in the local compose stack with a named
      volume, wired into `pnpm run up` and `pnpm health`; replication-slot lag alerting before
      any data flows. An inactive slot grows the WAL without bound and Supabase disk never shrinks
- [ ] Decide where the container runs in deployed environments — stateful, fast disk, not Workers
- [ ] Shape definitions in `packages/schema`, server-side only, one per row of the table above
- [ ] Shape proxy: unseal session → authorise per `rooms.md` → proxy to Electric
- [ ] `packages/sync`: Electric collections, then wrap them in `persistedCollectionOptions`
- [ ] The subscription registry with its inverse, plus the active/idle tiering (L2)
- [ ] **Test that a `local-only` collection survives a sibling's `truncate()`** (D4) — the
      assumption the archive tier rests on
- [ ] The archive collection, fed from the window and from paged history
- [ ] Merged read: window ∪ archive, deduped by id, windowed by `loadSubset`
- [ ] `sync_floor` advance job, server-side, with D5's hysteresis
- [ ] Write endpoint returning txid from inside the transaction (D6)
- [ ] Offline outbox, honouring `idempotencyKey` from the first write (H6)
- [ ] Browser adapter, multi-tab coordinator, and the degraded mode (D9)

## Questions to settle

- **Where does the Electric container run?** Stateful, wants local NVMe, cannot go on Workers,
  so it is the one service outside Cloudflare. Fly.io with a volume, a small storage-optimised
  VM, or a container platform with a disk. Replaces the old Q2 about Electric Cloud egress IPs.
- **How far back, in the product's words?** D5 proposes a 5,000-message window and an unbounded
  archive, which means "everything you have read, forever". Confirm that is the promise — it is
  a product statement, and the alternative (a stated retention limit) is cheaper to say now than
  to introduce later.
- **What advances `sync_floor` — a job, or a write-path trigger?** The policy is D5; the
  mechanism is not settled. A nightly job is simpler and the hysteresis makes latency irrelevant.
- **Does the outbox belong in SQLite on desktop?** (L4.) Living with two stores is probably right
  for now; it should be a decision rather than an accident.
- **Electron multi-window and the outbox's leader election.** It assumes browser tabs. Phase 11,
  but the answer may constrain multi-window.
- **The degraded browser mode.** No persistence means in-memory collections and no offline. What
  does the UI say, and does anything become read-only?

## Candidates for ARCHITECTURE.md

> **Applied 2026-09-06.** Everything below is now recorded upstream. Kept as the record of
> what changed and why, not as a to-do.

1. **Time-bounded shapes cannot use `now()`** (D3). Asserted in three places without a mechanism,
   and the naive one destroys the CDN collapsing the Electric choice rests on. `sync_floor`
   replaces it.
2. **A shape-backed collection is a cache, not storage** (D4). The two-tier window-and-archive
   model, and the reason history cannot live in a synced collection.
3. **Refine invariant 1.** Shapes are scoped by a container many subscribers share — room _or_
   conversation — never per user, with the directory (D2) as a named, bounded exception.
4. **Phase 4's persistence stack is real, richer than recorded, and pre-1.0** (D8). An Electron
   bridge and a durable outbox exist, neither is in TanStack's docs index, and the Electron
   bridge is 0.1.x. H11 is solved upstream. The version table belongs in the doc.
5. **Strike the PowerSync browser-grounds rejection** (D9). Our browser path is wa-sqlite over
   OPFS via PowerSync's own `@journeyapps` fork. The Electric decision stands on read-path
   economics; that line does not.
6. **Browser durability is best-effort** (D9). The surface table calling browser "everything
   except the webview panel" understates the difference.
7. **Electric's docs moved to `electric.ax`** — the llms.txt and guide links in
   `ARCHITECTURE.md` and `CLAUDE.md` now redirect.
