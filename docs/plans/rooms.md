# Rooms — actors, conversations, panels

> Working plan. `ARCHITECTURE.md` sketches `rooms` and `room_members` and stops there;
> messages, panels and chat placement are named in the phase list but never designed, and
> Phase 1 deliberately did not create a room because "the room schema is still moving with
> product decisions". Those decisions are now made, and two of them **amend settled items**
> rather than extend them.
>
> **`ARCHITECTURE.md` is treated here as a product and design document, not a technical
> reference.** Its invariants are design intent and are honoured as such. Every claim in this
> plan about what Electric, TanStack DB or Postgres actually _do_ was verified against vendor
> docs and published packages on 2026-09-06, and where the two disagree the vendor wins.
> `local-first.md` records the places they did.
>
> **Sync and persistence live in [`local-first.md`](./local-first.md), not here.** That is a
> separate concern with a later deadline: this document decides the tables, that one decides
> what syncs and what survives offline. One column crosses the line — `conversations.sync_floor`
> — and it is defined here and read only there. Nothing in that document changes this schema,
> including its reversal of the sync engine: the tables are engine-agnostic by design.
>
> Like `navigation.md`, this document carries the decisions with their reasoning so they can be
> re-argued if circumstances change, not re-litigated by default. _Candidates for
> ARCHITECTURE.md_ at the bottom lists what belongs upstream when that file is next edited in
> its own turn.

**Done when:** a room renders its shared chat with humans and agents in the member list; a
public room can be joined by any workspace member without asking; a private room admits only
who a member adds; a person can hold a private chat with an agent inside a room and promote it
to the room without a message being rewritten; and every read path still authorises with
primary-key lookups and no joins.

**Scope:** the `actors`, `rooms`, `room_members`, `conversations`, `conversation_members`,
`messages` and `panels` tables, the authorisation paths over them, and the room ID type.
Not shapes, persistence or offline behaviour (`local-first.md`). Not the sidebar or room-list
IA, not unreads, not notifications, not the panel UI, not agent authoring (Phase 6) or the run
lifecycle (Phase 5).

**Not a phase.** Phase 2's exit criterion is "render a room from synced data", so this is the
schema that phase reads. It lands with Phase 0's remaining tables.

## Where things stand

| #   | Step                                           | State                          |
| --- | ---------------------------------------------- | ------------------------------ |
| 1   | UUIDv7 function on PG17                        | ✅ verified, 5,000 ids ordered |
| 2   | `actors` (+ a minimal `agents` it references)  | ✅                             |
| 3   | `rooms`, `room_members`                        | ✅                             |
| 4   | `conversations`, `conversation_members`        | ✅                             |
| 5   | `messages`                                     | ✅                             |
| 6   | `panels`                                       | ✅                             |
| 7   | `auditTenancy` exemption for `actors`          | ✅                             |
| 8   | Migration generated and exercised              | ✅ 14 assertions               |
| 9   | Signup + webhooks write and maintain the actor | ✅                             |
| 10  | Room creation, archive cascade, promotion      | ✅                             |
| 11  | Authorisation helpers over the four paths      | ✅ 57 server tests             |

## What already constrains this

| Decision                                                                                                                                                                  | Where            | What it forces                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| "Shapes are scoped by room, never per user"                                                                                                                               | Invariant 1, H3  | Message visibility can never be a per-viewer filter over one shape                  |
| "`organization_id` sits on every tenant table, and `workspace_id` on everything below the workspace… the shape proxy authorises on every request and **must never join**" | Invariant 2      | Anything the proxy filters on must be a column on the row it filters                |
| "Access is decided at workspace and room level only"                                                                                                                      | Invariant 5      | No role table below workspace. Room permissions are columns, not roles              |
| "The tier that runs untrusted code holds no secrets… the pi runtime never holds a provider token"                                                                         | Invariant 6      | An agent in a member list must not become an authorization subject                  |
| "Buffer and write once. An update is another WAL write plus another shape-log write"                                                                                      | Invariant 12, H4 | Agent progress never streams as updates to a message row                            |
| "WorkOS is upstream, Postgres is a read replica. Never write WorkOS-owned rows directly"                                                                                  | Invariant 4      | Agents cannot be rows in `users`                                                    |
| "A room holds multiple panels, arranged like editor panes… what is open is shared; how it is arranged is local"                                                           | Phase 10         | Panels are rows; arrangement stays in `sync/src/local/`                             |
| "An agent is a resource, not a principal. No agent rows in `users`"                                                                                                       | Phase 5, l. 1309 | **Amended below** — the addressability half was wrong, the authority half was right |

## Decisions

### D1 — `actors` is the one addressable construct; `users` stays a mirror

Agents and people are the same thing everywhere the product points at somebody: the member
list, the message author, an `@`-mention, a reaction, "who opened this panel". Repeating a
`(user_id, agent_id)` pair across six tables is the polymorphic-FK smell, and every query
that renders a name would branch.

They cannot be unified in `users`. That table is a WorkOS mirror — `users.ts` says "rows
arrive by `user.created` webhook; a direct write is silently overwritten by the next one" —
and it has `email not null unique`, which agents do not have. Writing agents there breaks
invariant 4 and the drift is silent, which is the failure mode the doc warns about hardest.

So `actors` is ours: one row per addressable thing in an org, `kind` discriminating, pointing
at either a `users` row or an `agents` row.

**It carries `display_name` and `avatar_url`**, written by the same webhook that maintains the
mirror. This is a projection, not a second source of truth: application code never writes them,
`user.created` / `user.updated` does, and drift is bounded by webhook latency — the same
guarantee `users` itself already has. Invariant 4 forbids application writes to mirrored rows;
it does not forbid the mirror's own writer maintaining a projection.

The alternative — resolving names through `users` at render time — would put a WorkOS mirror
on every device. `users` carries emails and has no `organization_id`; scoping it to an org means
joining through `organization_memberships`, and shipping it means every client holds the email
of everyone in the organization, forever, for the sake of a display name.

With the projection, **`actors` is the only collection the client needs to render anybody** —
human or agent, author or member or panel-opener — and `users` never leaves the server. That
holds whichever sync engine feeds the collection; it was originally argued from Electric's
one-table-per-shape constraint, and it survives that constraint going away.

**Org-scoped, not workspace-scoped.** A human belongs to the org (a guest has an org
membership and no workspace membership), and one actor row per person per workspace would
fragment authorship across workspaces. Agents are workspace-scoped underneath, so adding one
to a room in another workspace is blocked at write time, not by the actor's own scope.

### D2 — Authorship is not authority

D1 makes an agent _addressable_. It does not make it a _principal_, and Phase 5's reasoning
for that half stands unchanged: the agent service authenticates as a service, and each write
is authorised by the `runs` row it references, which carries `invoked_by`, `workspace_id` and
`organization_id`. The credential is the invoking human's.

**The read path only ever authorises humans.** Agents never read through it. The moment
`actor_id` becomes the subject of a _read_ check we have given agents ambient access to rooms
they were never invoked in, and invariant 6 is the thing standing in the way.

**An agent is added to a room exactly like a person** — a `room_members` row — and that row is
what makes it available to invoke there. So it is a precondition, checked where runs are
created, not where reads are served: enqueueing a run asserts `room_members(room_id,
agent_actor_id)` exists. That is a useful extra guard rather than a new authority — it bounds
an agent to the rooms it was deliberately added to, and it means removing an agent from a room
stops future invocations without touching any credential.

### D3 — Public rooms are readable by the workspace; `room_members` means "joined"

A public room is viewable and joinable by any workspace member without permission, so
membership cannot be the read grant. It is the sidebar-and-participation list, the way it is
in Slack. Two paths, both primary-key lookups, neither a join:

| Room                 | Read check                                      |
| -------------------- | ----------------------------------------------- |
| `is_private = false` | `workspace_memberships (workspace_id, user_id)` |
| `is_private = true`  | `room_members (room_id, actor_id)`              |

Guests hold no workspace membership, so they fail the public path and see only the rooms they
were added to — which is what `ARCHITECTURE.md:427` already promises them.

**This corrects the visibility union at l. 457.** As written it is
`rooms in workspaces you belong to ∪ rooms you are explicitly a member of`, which hands every
workspace member every private room. It needs `and is_private = false` on the first term.

**Workspace admins get no special access to private rooms.** There is no role check anywhere
in the two paths above, which is invariant 5 holding: the workspace role table does not reach
into rooms.

### D4 — Any member adds; the creator archives

Creator-only _invitation_ is a dead end the day the creator leaves the org, and repairing it
needs an admin override, which is the role check D3 just excluded. So any member of a private
room may add another; `room_members.added_by` is recorded for audit only.

`rooms.created_by` grants exactly one right: **archiving the room.** That is deliberately the
smallest possible privileged act — it is reversible, it destroys nothing, and it needs no role
table (invariant 5 holds). It inherits the same dead end, and the same escape hatch: when
"manage room" becomes a real requirement, it becomes a column on `room_members`, not a role.

**Archiving cascades.** A room is a container, so archiving it stamps `archived_at` on the room,
on every conversation in it — the `main` chat and every `panel` conversation alike — and on
every panel. One transaction, bounded by the room's contents. Nothing is deleted: an archived
room's messages, panels and history stay exactly where they are, and unarchiving is the same
transaction in reverse.

The same stamp covers D9's departure case: when the creator of a private panel chat leaves the
room, that conversation and its panel are archived rather than removed, and they are there
again if they return.

### D5 — The conversation is the sync and auth unit for messages, not the room

Chat is not owned by a room. A conversation can sit in a room, sit privately inside a panel in
a room, or stand detached, and it moves between those places. So `conversations` is a table in
its own right and messages hang off it.

It is also the **unit of read access** for messages, which is what makes privacy structural
rather than a filter: `mayReadConversation` decides per conversation, the message catch-up is
scoped to the set of conversations the viewer may read, and a private conversation is simply
not in that set. Nobody has to remember to exclude its rows, because nothing ever asks for them.

This was first argued in Electric's terms — a conversation as the shape's scope, shared by
everyone in it, so CDN collapsing survived the move off rooms. The engine changed
(`local-first.md` D1) and the decision did not: whatever feeds the `messages` collection scopes
by conversation, because that is where the access boundary is.

### D6 — `messages` carries no `room_id`

Invariant 2 requires `organization_id` and `workspace_id`. It does not require `room_id`, and
adding one would be the expensive kind of harmless: promoting a private research thread into
the room would rewrite every message row — O(N) synced writes against invariant 12, and every
subscriber's local cache invalidated for a change that moved nothing.

With placement on the conversation, **a promotion touches two rows** — the conversation's
`visibility` and its panel's mirror of it (D9) — and no message at all. `workspace_id` stays
correct on every message because a conversation never crosses workspaces.

### D7 — One conversation table covers room chats, panel chats and DMs

Slack shipped channels, private groups, DMs and group DMs as separate constructs and spent
2017 converging them into a single `conversations.*` API. Building the second construct later
is the mistake with a known price, so: a room's shared chat, a private panel chat, a DM and a
group DM are one table, one `messages` table, one sync path, distinguished by `kind` and
`visibility` and a nullable `room_id`.

Their mistake was not one table — it was `is_im`, a boolean that conflated _type_ with
_visibility_. Keeping those two columns separate is what avoids it.

### D8 — Visibility moves; kind does not

`kind` says what a conversation _is_ and never changes. `visibility` says who can read it and
is the only thing a promotion touches.

|                           | `kind`   | `visibility` | `room_id` |
| ------------------------- | -------- | ------------ | --------- |
| A room's shared chat      | `main`   | `shared`     | set       |
| A private chat in a panel | `panel`  | `private`    | set       |
| …after promotion          | `panel`  | `shared`     | set       |
| DM / group DM (later)     | `direct` | `private`    | null      |

A promoted chat stays `panel` and stays a panel — it becomes a tab on the right that everyone
in the room can now open, not a second chat in the centre column. **A room has exactly one
central shared chat**, which is what `main` names, enforced by a partial unique index rather
than a boolean. That index is the schema saying it: a second `main` conversation in a room is
not a product decision anyone can drift into, it is a constraint violation.

### D9 — Panels are room surfaces; a chat panel mirrors its conversation's visibility

`panels` generalises Phase 10's `{room_id, url, opened_by, at}` to `kind` plus a `config` jsonb
— `browser` and `chat` now, `sandbox`, `terminal` and `doc` when they are wanted, without a
migration each time. `created_by` is an `actor_id`, which is D1 paying for itself: "an agent
opened a panel" and "a person opened a panel" are the same row.

**The conversation is the source of truth for a chat panel's visibility, and the panel mirrors
it.** Two columns that must never disagree is a real hazard (R2), but the mirror is
load-bearing rather than lazy: whatever serves panels filters them by visibility, and per invariant 2
the proxy cannot join to `conversations` to find it. Same justification as the denormalised
`organization_id`. The promote operation writes both in one transaction.

Agent-created panels still arrive as Phase 10's dismissible banner rather than yanking someone's
layout. **Dismissal is per-user and local** — a synced `dismissed_by` column would be H2 in
miniature.

### D10 — Message body is blocks; agent progress never touches a message row

`body jsonb` holds a versioned block list, because "extensible" in practice means approval
cards, run references, attachments and whatever Phase 10 adds — not a string with conventions
grown into it. A flat `text` projection sits beside it for the Postgres `tsvector` search the
architecture already plans.

A running agent's message is a **reference to a run**. The trace renders from `run_events`,
batched at ~1s and already synced. Streaming tokens into a message row would be H4 exactly:
twelve updates costing what twelve inserts cost, on the hottest table in the product.

`kind = 'system'` covers "@Priya is not in this chat" (point 5 of the room picture) and
"Harsh added Priya". `author_id` is nullable for the ones nobody performed.

### D11 — UUIDv7, native `uuid`, no encoder

`navigation.md` left this open between UUID and ULID. Neither: RFC 9562 standardised UUIDv7 in
May 2024 and it is where the question resolved.

|                       | v4 (today) | ULID            | **v7**       |
| --------------------- | ---------- | --------------- | ------------ |
| Time-ordered          | no         | yes             | **yes**      |
| Native PG `uuid` type | yes        | no — text/bytea | **yes**      |
| Standardised          | RFC 9562   | community spec  | **RFC 9562** |
| Text length           | 36         | 26              | 36           |

ULID's pitch was a sortable 128-bit ID with good index locality; v7 delivers that without
leaving the type system, so Drizzle's `uuid()` column, the existing indexes and every tool keep
working. It also pays off twice on `messages`: insert locality on the hottest table, and
chronological ordering that falls out of the primary key, so paging older history is a keyset
scan on the PK with no secondary ordering column.

Cost: a v7 ID leaks approximate creation time. Behind auth, irrelevant.

**36 characters, so `paths.ts` gains no encoder** — rooms are clicked and pasted, never typed,
and `navigation.md` already rejected short-code tables as a separate feature. This closes that
plan's open question.

**PG17 has no built-in `uuidv7()`** (that is PG18). The function goes in via
`generate --custom`; when the database moves to 18 the built-in of the same name supersedes it.

It carries **sub-millisecond precision** (RFC 9562 §6.2 method 3): the 12 bits after the version
hold the microsecond within the millisecond rather than randomness. A plain v7 leaves those
random, so ids minted in the same millisecond have no defined order — which is a visible bug on
a chat table, where message order _is_ the read path. Verified: 5,000 ids strictly ascending,
and 25 messages inserted back-to-back in one transaction ordered correctly.

### D12 — `conversation_members` is the participant list, not the read grant

Same shape as D3, one level down. For a `private` conversation the member list _is_ the read
grant. For a `shared` one it is who is participating, and read access comes from the room. That
keeps "who is in this chat" answerable for both, and it is what the D10 system message reads to
decide someone was tagged who is not here.

### D13 — Room names are unique per workspace

Unique per workspace, compared case-insensitively, the way Slack's channels are — a room is a
place people refer to by name in conversation, and two `#design` rooms in one workspace make
that reference ambiguous. `unique (workspace_id, lower(name))`.

**Renames are free and need no redirect**, because `navigation.md` D2 already put IDs in the
path and not slugs. That is the payoff of a decision made before there was a room to rename:
Slack has to keep the old channel name resolving; we do not.

Shape and length are a validator concern in `packages/schema`, not a CHECK — Slack's own rules
(lowercase, no spaces or periods, 80 characters) have moved over the years, and a vocabulary
that moves does not belong in a constraint that requires a migration to change. Uniqueness is
different: it is an integrity property and belongs in the index.

## Schema

```sql
-- ── Actors ─────────────────────────────────────────────────────────────

create table actors (
  id              uuid primary key default uuidv7(),
  organization_id text not null references organizations(id),
  kind            text not null,                       -- human | agent
  user_id         text references users(id),           -- iff human
  agent_id        uuid references agents(id),          -- iff agent
  display_name    text not null,                       -- projection; webhook-written for humans
  avatar_url      text,
  created_at      timestamptz not null default now(),
  check (kind in ('human', 'agent')),
  check ((kind = 'human') = (user_id  is not null)),
  check ((kind = 'agent') = (agent_id is not null)),
  unique (organization_id, user_id),
  unique (agent_id)
);

-- ── Rooms ──────────────────────────────────────────────────────────────

create table rooms (
  id              uuid primary key default uuidv7(),
  workspace_id    uuid not null references workspaces(id),
  organization_id text not null references organizations(id),   -- denorm
  project_id      uuid,                                          -- nothing reads it
  name            text not null,
  is_private      boolean not null default false,
  created_by      uuid not null references actors(id),   -- D4: may archive
  archived_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- D13. Renames need no redirect: the URL is by id.
create unique index rooms_workspace_name_key on rooms (workspace_id, lower(name));

create table room_members (
  room_id         uuid not null references rooms(id) on delete cascade,
  actor_id        uuid not null references actors(id),
  workspace_id    uuid not null references workspaces(id),       -- denorm, invariant 2
  organization_id text not null references organizations(id),    -- denorm
  added_by        uuid references actors(id),
  created_at      timestamptz not null default now(),
  primary key (room_id, actor_id)
);

create index room_members_actor_idx on room_members (actor_id, workspace_id);

-- ── Conversations ──────────────────────────────────────────────────────

create table conversations (
  id              uuid primary key default uuidv7(),
  workspace_id    uuid not null references workspaces(id),
  organization_id text not null references organizations(id),
  kind            text not null,                       -- main | panel | direct
  visibility      text not null,                       -- shared | private
  room_id         uuid references rooms(id) on delete cascade,
  created_by      uuid not null references actors(id),
  sync_floor      uuid,                                -- bootstrap floor; see local-first.md
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  check (kind in ('main', 'panel', 'direct')),
  check (visibility in ('shared', 'private')),
  check ((kind = 'direct') = (room_id is null)),
  check (kind <> 'main' or visibility = 'shared'),
  check (kind <> 'direct'  or visibility = 'private')
);

-- Exactly one shared chat per room; D8's is_default without the boolean.
create unique index conversations_room_main_key
  on conversations (room_id) where kind = 'main';

create table conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  actor_id        uuid not null references actors(id),
  workspace_id    uuid not null references workspaces(id),
  organization_id text not null references organizations(id),
  created_at      timestamptz not null default now(),
  primary key (conversation_id, actor_id)
);

-- ── Messages ───────────────────────────────────────────────────────────

create table messages (
  id                uuid primary key default uuidv7(),
  conversation_id   uuid not null references conversations(id) on delete cascade,
  workspace_id      uuid not null references workspaces(id),
  organization_id   text not null references organizations(id),
  author_id         uuid references actors(id),        -- null for unperformed system messages
  parent_message_id uuid references messages(id),      -- threads
  run_id            uuid,                              -- Phase 5; trace renders from run_events
  kind              text not null default 'message',   -- message | system
  body              jsonb not null,                    -- versioned blocks
  search_text       text not null default '',          -- projection, for tsvector
  created_at        timestamptz not null default now(),
  edited_at         timestamptz,
  deleted_at        timestamptz,
  check (kind in ('message', 'system')),
  check (kind <> 'message' or author_id is not null)
);

-- v7 ids sort chronologically, so this is the paging index too.
create index messages_conversation_idx on messages (conversation_id, id desc);
create index messages_thread_idx on messages (parent_message_id)
  where parent_message_id is not null;

-- ── Panels ─────────────────────────────────────────────────────────────

create table panels (
  id              uuid primary key default uuidv7(),
  room_id         uuid not null references rooms(id) on delete cascade,
  workspace_id    uuid not null references workspaces(id),
  organization_id text not null references organizations(id),
  kind            text not null,                       -- browser | chat
  visibility      text not null default 'shared',      -- mirrors the conversation when chat
  conversation_id uuid references conversations(id),   -- iff kind = 'chat'
  created_by      uuid not null references actors(id),
  config          jsonb not null default '{}',         -- kind-specific: {url} for browser
  archived_at     timestamptz,                         -- D4: stamped with the room
  created_at      timestamptz not null default now(),
  check (visibility in ('shared', 'private')),
  check ((kind = 'chat') = (conversation_id is not null))
);
```

## Authorisation

Four paths, every one a primary-key lookup, no joins, no network call — which is what
invariant 2 and the FGA deferral both depend on.

```
may_read(conversation c, human h):
  c.visibility = 'private'   →  conversation_members (c.id, h.actor_id)
  c.visibility = 'shared'    →  may_read(room c.room_id, h)

may_read(room r, human h):
  r.is_private = false       →  workspace_memberships (r.workspace_id, h.user_id)
  r.is_private = true        →  room_members (r.id, h.actor_id)
```

The endpoint already reads the conversation or room row to scope the query, so the delegation
costs no extra round trip. Agents never appear here (D2).

## Rejected

| Option                                                | Why it lost                                                                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents as rows in `users`                             | Mirror table, webhook-owned, `email not null unique`. Silent drift, the failure mode the doc warns about hardest                                |
| `kind` column on `users` instead of `actors`          | Same problem, plus it makes the mirror's purity a matter of discipline rather than structure                                                    |
| Syncing `users` to the client to resolve names        | A WorkOS mirror with emails on every device, scoped by a join through `organization_memberships`. D1's projection keeps it server-side entirely |
| Per-actor rows in `users` and a `person` link table   | Explicitly rejected in `users.ts` — server-side identity linking routes around SSO enforcement                                                  |
| `room_id` on `messages`                               | Makes every promotion O(N) synced writes and invalidates every cache, for a move that changed one fact                                          |
| `visibility` on `messages`, filtered per viewer       | A per-viewer predicate over shared rows. The access boundary is the conversation (D5); a filter on messages is a second boundary that can drift |
| Separate `dms` / `channels` tables                    | Slack built it and spent 2017 converging it                                                                                                     |
| `is_default` boolean on conversations                 | A partial unique index says the same thing and cannot drift                                                                                     |
| Room-level roles                                      | Invariant 5. Creator rights are a column; anything more is the FGA phase                                                                        |
| Workspace-admin override into private rooms           | Would reintroduce a role check into the hot path D3 just cleared                                                                                |
| ULID                                                  | v7 gives the same ordering inside the native `uuid` type, and is an RFC                                                                         |
| Panel visibility derived at read time                 | The proxy would have to join `panels` to `conversations`; invariant 2                                                                           |
| Conversation membership rows for shared conversations | Would break "join a public room without permission" and amplify writes on every join                                                            |
| Deleting a room or its contents on archive            | Archiving is reversible and destroys nothing; `archived_at` on four tables in one transaction (D4)                                              |
| Room-name CHECK constraint                            | Slack's own naming rules have moved repeatedly; a moving vocabulary belongs in a validator, uniqueness in an index (D13)                        |

## Hazards

- **R1 — a per-viewer message filter.** The first request that looks like "hide this message
  from some room members" puts a per-viewer predicate on the messages read path, and the
  access boundary stops being the conversation. The answer is always a separate conversation,
  never a filter — that is what D5 is for.
- **R2 — the promote transaction.** `conversations.visibility` and `panels.visibility` must
  move together or a shared panel wraps a private conversation. One transaction, and a test
  that asserts they never disagree.
- **R3 — `room_id` creeping onto `messages`.** It will look like an obvious denormalisation
  the first time someone writes a room-wide query. D6 is the reason it is not.
- **R4 — `actor_id` as an authorization subject.** The single change that would give agents
  ambient room access. Invariant 6.
- **R5 — streaming into `messages`.** H4. Agent progress goes through `run_events`.
- **R6 — a user without an actor.** Signup must write the human `actors` row in the same
  transaction as the org and workspace membership, or a real account exists that cannot be
  added to anything. Same advisory-lock path Phase 1 already uses.
- **R7 — the `auditTenancy` exemption.** `actors` is org-scoped and needs adding to
  `NO_WORKSPACE_ID` in `tenancy.ts`. That set is designed so the exemption is an edit someone
  justifies in review — `connections` needs the same and does not have it yet.
- **R8 — `sync_floor` looks like a dead column.** Nothing in this document reads it, and the
  first person to run a schema audit will propose dropping it. It is the **bootstrap floor** —
  how far back a brand-new device fetches a conversation on first sync — and it is a column
  rather than a policy because the right answer legitimately differs per conversation. See
  `local-first.md`, _Table by table_.

## Steps

- [x] `uuidv7()` SQL function via `drizzle-kit generate --custom`, with sub-ms precision
- [x] `packages/schema/src/tables/actors.ts`, exported from the barrel
- [x] A minimal `agents.ts` — `actors.agent_id` references it, so it could not wait. Id,
      workspace, org, creator, name. Phase 6 owns pi packages, prompt and providers
- [x] `NO_WORKSPACE_ID` gains `actors`, with the reason in the comment (`connections` when it lands)
- [x] `rooms.ts`, `room-members.ts` — `actor_id`, not `user_id`
- [x] `conversations.ts`, `conversation-members.ts` with the five CHECKs and the partial index
- [x] `messages.ts` — the projection column is `search_text`, not `text`, which shadowed
      Drizzle's own `text()` import at every use site
- [x] `panels.ts`
- [x] Signup writes the human actor row inside the advisory lock (R6); `backfillActors`
      repairs organizations created before the table, scoped to one org at a time
- [x] `user.updated` maintains the projection; `organization_membership.created` creates the
      actor, guests included; `organization_membership.deleted` revokes grants and keeps it
- [x] `createRoom` writes `rooms` + the `main` conversation + `room_members` in one txn
- [x] Archive cascade and its inverse, and `promoteConversation` moving two rows and no message
- [x] `access.ts` — the four paths, exercised against a guest, a workspace admin, a
      non-member and a foreign organization
- [x] `drizzle-kit generate`; migration reviewed by hand and exercised against live PG17 in a
      rolled-back transaction — 14 assertions covering every CHECK, the partial unique index,
      the case-insensitive name index, id ordering, and that a promotion leaves message rows
      untouched (`xmin` unchanged)

## What building it changed

Five things the plan did not anticipate. Four were found by the tests.

- **Actors outlive what they point at.** Both references are `set null` and the two CHECKs are
  one-directional, not biconditional. The plan had `(kind = 'human') = (user_id is not null)`,
  which makes `user.deleted` impossible: `messages.author_id` is `restrict`, so an actor that
  could be deleted could never have written anything, and a foreign key that refuses a WorkOS
  webhook makes WorkOS retry a delivery that can never succeed. A tombstone keeps a departed
  colleague's name on what they wrote, which is what Slack does. Migration 3.
- **`user.deleted` was already broken**, before any of this. `organization_memberships.user_id`
  is `restrict`, and WorkOS delivery is unordered — so a user deleted before their membership
  event arrived could never be removed, and the retry would never stop. The handler now clears
  what hangs off the user first. Found by a test written for the tombstone.
- **Signup could not work locally.** It assumed a mirrored user, which only `user.created`
  writes — a webhook, which without a tunnel never arrives. It now fetches and mirrors on
  demand, the same self-healing `ensureParents` already does from the other direction.
- **`revokeRoomGrants`** is new. Rooms are the first thing a departing member can hold a grant
  to, so losing an organization membership now drops room and conversation membership as well
  as the workspace one. The actor stays.
- **`backfillActors` is scoped to an organization** and returns rows _written_ rather than rows
  _found missing_. As one global batched insert it was a single stale foreign key away from
  silently writing nothing while reporting success — which is exactly how a parallel test run
  caught it.

## Deliberately not built

| Item                                       | Why                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Unreads / read cursors                     | Per-user-per-room state with no home yet. Needs its own decision — the `starred rooms` row in `navigation.md` D9 is the same shape of problem |
| Reactions                                  | One table, `(message_id, actor_id, emoji)`. Nothing blocks it; nothing needs it yet                                                           |
| Mentions table                             | The `text` projection and `body` blocks carry them; a table is for notification fan-out, which is not designed                                |
| Thread → conversation promotion            | Rewrites `conversation_id` on the moved messages. Bounded and explicit, but not free — build when asked                                       |
| Merging two conversations                  | Explicitly out of scope                                                                                                                       |
| DMs and group DMs                          | The schema admits them (D7/D8); no UI, no shapes, no route                                                                                    |
| `sandbox` / `terminal` / `doc` panel kinds | `kind` + `config` takes them without a migration                                                                                              |
| `projects`                                 | Unchanged: the column is there, nothing reads it                                                                                              |

## Questions to settle

None blocking. The schema can be written from what is decided above; these are refinements that
change no table.

- **Guest naming.** A guest has an org membership and therefore an actor, so they render like
  anyone else. Should the UI mark them, and does that belong on `actors` or come from
  `organization_memberships.roles`? The latter, probably — already synced, already authoritative.
- **Unarchiving.** D4 says archiving is the creator's and reversible. Confirm anyone who could
  archive can unarchive, and that a room archived because its creator left is not stranded.
- **Reactions and mentions.** Both fit without disturbing anything (see _Deliberately not
  built_); they need a product decision, not a schema one.

Everything about how these tables sync, persist and behave offline is in
[`local-first.md`](./local-first.md) and does not block this work.

## Candidates for ARCHITECTURE.md

> **Applied 2026-09-06.** Everything below is now recorded upstream. Kept as the record of
> what changed and why, not as a to-do.

1. **Amend Phase 5's _Decided: agent identity_.** "No agent rows in `users`" stands and is now
   load-bearing for a different reason; "an agent is a resource, not a principal" splits into D1
   and D2 — addressable and a room member, never a read principal.
2. **Correct the visibility union:** the first term needs `and is_private = false`, or every
   workspace member can read every private room.
3. **Record the two room read paths** (D3), that workspace roles do not reach into rooms, and
   that `created_by` grants archiving and nothing else (D4).
4. **Fix the Phase 0 sketch:** `room_members` and `connections` lack `workspace_id` and would
   fail the H7 guard as written.
5. **Generalise the Phase 10 panel row** from `{room_id, url, opened_by, at}` to `kind` +
   `config`, with visibility mirrored from the conversation for chat panels.
6. **Room ID type is UUIDv7** — closes `navigation.md`'s open question, and applies to every
   `uuid` primary key written from here.

`local-first.md` carries its own list, including the invariant 1 refinement that both documents
depend on.
