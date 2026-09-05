# Multiplayer Agent Workspace — Build Document

> Working document, ordered by implementation sequence.
> Each phase carries its own decisions, nuances, open questions and exit criteria.
> Governance, analytics and telemetry are deliberately out of scope.

**How to use this:** work one phase at a time. Before starting a phase, resolve its
_Questions to settle_ section. The _Decisions_ in each phase are already made — they carry
their reasoning so they can be re-argued if circumstances change, not re-litigated by default.

---

## Product Definition

A **local-first multiplayer workspace** where rooms contain both humans and agents.
Users chat with each other, invoke agents, watch agent activity, and author their own agents.

**Core thesis:** the app is a _coordination layer over external artifacts_, not another editor.
Two people and their agents collaborate on the same Notion page or Google Doc. The artifact stays
in Notion. The app owns _who is doing what to which part_ — which Notion has for humans but not
for humans-plus-agents.

| Surface          | Status           | Notes                                        |
| ---------------- | ---------------- | -------------------------------------------- |
| Electron desktop | Primary          | Full feature set including the webview panel |
| Browser          | Secondary, later | Everything except the webview panel          |

The browser surface is a real target, not a maybe. Every decision below preserves it.

**Tenancy:** multi-tenant, a **direct parallel to Slack**. Three levels:
**Organization → Workspace → Room**, with Projects later as a grouping inside a workspace.
Identity unifies at the org level and nowhere above it. There is no "personal account" concept —
a solo user is an org with one member, exactly as in Slack.

**Model hosting:** self-hosted. LLM inference cost is out of scope for all cost modelling here.

---

## Cross-Cutting Invariants

Rules that apply in every phase and are cheap now, expensive later. Violating any of these is a
design regression, not a trade-off.

1. **Shapes are scoped by room, never per user.** Per-user shapes destroy CDN hit rate _and_
   multiply the Electric write meter.
2. **`organization_id` sits on every tenant table, and `workspace_id` on everything below the
   workspace** — including where either is derivable by join. The shape proxy authorises on every
   request and must never join to do it; a missing hop can't silently leak across tenants.
3. **Workspace is never in the session token.** Slack put it there, it became their shard key, and
   they spent years unwinding it. Session is `{user_id, organization_id}`; workspace is navigation
   state validated per request.
4. **WorkOS is upstream, Postgres is a read replica.** Never write WorkOS-owned rows directly —
   they arrive by webhook.
5. **Access is decided at workspace and room level only.** Projects group; they never gate. No
   authorization check may read `project_id`.
6. **The tier that runs untrusted code holds no secrets; the tier that holds secrets runs no
   untrusted code.** The pi runtime never holds a provider token, never reaches a provider
   directly, and never has a shell.
7. **The stack runs locally with no managed-service dependency.** A local run must never reach a
   production Postgres, Electric project or R2 bucket. Every new service added must arrive with its
   local story.
8. **Any caller-supplied URL is origin-allowlisted before it is fetched** — callbacks, progress
   webhooks, agent-emitted panel URLs alike.
9. **Dependencies point from apps into packages, never sideways between apps.**
10. **Nothing above the persister knows which platform it is on.** Capability interface, not
    `if (isElectron)`.
11. **Two histories, never merged.** Pi's session is agent working memory; `run_events` is the
    user-facing trace.
12. **Buffer and write once.** An update is another WAL write plus another shape-log write, so 12
    updates cost what 12 inserts cost.
13. **Tool payloads never enter Postgres or the UI.** Labels in Postgres, payloads in object storage.
14. **`packages/schema` is the single source of truth**, consumed by client, API server and agent
    service alike.

---

## Hazards Register

Referenced from the phases where they first apply.

| #   | Hazard                                          | Consequence                                                                                                                   | Mitigated in           |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| H1  | **Inactive `pg_replication_slot`**              | Unbounded WAL growth. Supabase disk grows and **never shrinks**. _The single most dangerous operational hazard in the stack._ | Phase 2                |
| H2  | Read receipts / presence in synced tables       | Multiplies writes by reader count — a 50-person room is 50×.                                                                  | Phase 3                |
| H3  | Per-user shapes creeping in                     | Destroys CDN hit rate and multiplies the write meter.                                                                         | Phase 2                |
| H4  | Write-then-update in the harness                | 12 updates cost what 12 inserts cost.                                                                                         | Phase 6                |
| H5  | Unbounded run fan-out                           | Sandbox budget burned in an afternoon.                                                                                        | Phase 5                |
| H6  | Non-idempotent run retries                      | Duplicate PRs, duplicate comments.                                                                                            | Phase 5                |
| H7  | Missing `organization_id` on a table            | Cross-tenant leak.                                                                                                            | Phase 0                |
| H8  | Proxy on a container platform                   | Rebuilds the cost curve Zero was abandoned for.                                                                               | Phase 2                |
| H9  | Duplicate pi runtime                            | Miserable-to-debug module-root bugs.                                                                                          | Phase 6                |
| H10 | Internal-IP navigation in the webview           | Network pivot from inside the user's LAN.                                                                                     | Phase 10               |
| H11 | Local persister offset bug                      | Every launch re-reads every shape and bills for it. Now largely upstream's job, but still test it.                            | Phase 4                |
| H12 | R2 lifecycle not matched to partition retention | `blob_key` references outlive their rows; storage only grows.                                                                 | Phase 0                |
| H13 | Cloudflare concentration                        | Proxy, sandbox, storage and possibly browser all on one vendor.                                                               | Accepted — see Phase 8 |

---

# Phase 0 — Repo and Schema Foundation

**Goal:** the monorepo exists, types are shared, nothing runs yet.

## Decisions

### Monorepo: npm workspaces

```
.
├── package.json                  # workspaces: ["apps/*", "packages/*"]
├── tsconfig.base.json
│
├── apps/
│   ├── web/                      # Vite React — browser surface
│   │   ├── src/main.tsx          # entry, wires persist-idb
│   │   └── vite.config.ts
│   │
│   ├── desktop/                  # Electron — primary surface
│   │   ├── main/                 # main process, webview hardening,
│   │   │                         #   partitions, autoUpdater
│   │   ├── preload/              # contextBridge — capability API
│   │   ├── renderer/
│   │   │   └── src/main.tsx      # entry, wires persist-sqlite
│   │   └── electron-builder.yml  # signing, notarisation, feed
│   │
│   ├── marketing/                # site + /docs route
│   │
│   └── server/                   # API: shape proxy + write endpoint
│       └── src/
│           ├── shapes/           # membership check → Electric
│           └── writes/
│
└── packages/
    ├── schema/                   # ← single source of truth
    │   └── src/                  # shape defs, run_event types,
    │                             #   validators. Used by client,
    │                             #   server AND agent.
    │
    ├── ui/                       # uncompiled TSX, main → src/index.ts
    │   └── src/
    │       ├── room/
    │       ├── trace/            # run event labels
    │       ├── panel/            # webview — behind capability flag
    │       └── platform.ts       # capability interface
    │
    ├── sync/
    │   └── src/
    │       ├── collections/      # createCollection(electricOptions)
    │       ├── local/            # local-only: drafts, UI state
    │       │                     #   (real migrations — never dropped)
    │       ├── queries/          # client-side joins across shapes
    │       ├── subscriptions.ts  # effect-with-inverse registry
    │       └── persister.ts      # interface + offset contract
    │
    ├── persist-sqlite/           # Electron adapter over
    │                             #   db-sqlite-persistence-core
    ├── persist-idb/              # browser adapter
    │
    └── agent/                    # pi SDK embedding
        └── src/
            ├── runtime.ts        # one instance per run
            ├── events.ts         # pi.on("tool_call") → labels
            └── connectors/
                ├── github/       # extension + skills + prompts
                ├── linear/
                ├── slack/
                └── notion/
```

**`ui` ships uncompiled.** Its `package.json` main points at source, not `dist`. No build step, no
watch process, no stale artefacts — each app's Vite build compiles it as if the components lived
inside that app. The package boundary is source organisation, not a distribution mechanism.
Compile it only if it is ever published for outside consumers.

**`persist-sqlite` is a separate package** so its native module can never end up in a browser
bundle — enforced by construction, not discipline.

**Each connector folder mirrors pi's package layout**, so any one can be extracted and published
later without restructuring.

Because npm workspaces give no compile step at the package boundary, **each app's build must
typecheck across the packages it consumes**.

### Tenancy: a direct parallel to Slack

**Organization → Workspace → Room.** Projects come later as a grouping inside a workspace.

**Why three levels from day one, even though only two are used.** Slack shipped workspaces first
and routed every query to a database shard identified by the workspace ID in the session token.
When divisions started creating separate workspaces, they had to retrofit "org" as a parent (2017,
Enterprise Grid) — and then re-architect _again_ ("Unified Grid") when users started belonging to
several workspaces at once. Two re-architectures, because a hierarchy level was added after data
existed.

Adding an **auth boundary** later is expensive: every existing row needs a correct access decision
and there is no safe default. Adding a **grouping** later is cheap: everything defaults to
"Unfiled". That asymmetry is why `workspaces` exists now and `projects` does not.

### The WorkOS boundary

**WorkOS owns identity and org membership. We own everything below the org line.**

| Concept                    | Source of truth | Why                                                              |
| -------------------------- | --------------- | ---------------------------------------------------------------- |
| User (identity)            | WorkOS          | Email is the identity key                                        |
| Organization               | WorkOS          | SSO, domains, Directory Sync attach here                         |
| Org membership + org roles | WorkOS          | RBAC is org-scoped by design                                     |
| Org invitations            | WorkOS          | First-class resource; `onboard-user` sends invite + assigns role |
| **Workspace and below**    | **Us**          | WorkOS has no such concept                                       |

The direction is forced: an enterprise wants one Okta connection company-wide, not one per
workspace. So WorkOS Organization must map to _our_ Organization, and workspace is invisible to
WorkOS.

### Schema

```sql
-- ── Mirrored from WorkOS (webhook-maintained, never written directly) ──

create table users (
  id            text primary key,        -- WorkOS user_...
  email         text not null unique,
  first_name    text,
  last_name     text,
  profile_pic   text,
  created_at    timestamptz not null default now()
);

create table organizations (
  id            text primary key,        -- WorkOS org_...
  name          text not null,
  created_at    timestamptz not null default now()
);

create table organization_memberships (
  id              text primary key,      -- WorkOS om_...
  user_id         text not null references users(id),
  organization_id text not null references organizations(id),
  roles           text[] not null default '{member}',  -- WorkOS role slugs
  status          text not null,         -- active | inactive | pending
  created_at      timestamptz not null default now(),
  unique (user_id, organization_id)
);

-- ── Ours ───────────────────────────────────────────────────────────────

create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id),
  name            text not null,
  slug            text not null,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  unique (organization_id, slug)
);

create table workspace_memberships (
  workspace_id    uuid not null references workspaces(id),
  user_id         text not null references users(id),
  organization_id text not null references organizations(id),  -- denorm
  role            text not null default 'member',   -- admin | member | guest
  created_at      timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table rooms (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id),
  organization_id text not null references organizations(id),  -- denorm
  project_id      uuid,                  -- null until projects ship; nothing reads it
  name            text not null,
  is_private      boolean not null default false,
  created_at      timestamptz not null default now()
);

create table room_members (
  room_id         uuid not null references rooms(id),
  user_id         text not null references users(id),
  organization_id text not null references organizations(id),  -- denorm
  created_at      timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table agents (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id),
  organization_id text not null references organizations(id),
  created_by      text not null references users(id),
  name            text not null,
  packages        jsonb not null default '[]',   -- pi packages
  prompt          text,
  providers       text[] not null default '{}'   -- declared: github, linear…
);

create table connections (                        -- Pipes mirror
  user_id         text not null references users(id),
  organization_id text not null references organizations(id),
  provider        text not null,
  scopes          text[] not null default '{}',
  primary key (user_id, organization_id, provider)
);
```

`runs`, `run_events`, `messages` and `claims` all carry `organization_id` and `workspace_id` on the
same denormalisation rule.

### Identity across orgs — the Slack rule

**Within an org, one identity.** Enterprise Grid users have the same identity and profile across
all workspaces in the org, and migration into Grid merges accounts by email address.

**Across orgs, nothing.** Slack's non-Grid workspaces are simply not connected.

So: **one `users` row per WorkOS user, not per human.** `harsh@personal.com` and `harsh@acme.com`
are two rows, and that is correct — AuthKit keys identity on email. No `person` table, no
server-side account linking. The account switcher is **client-side**: Electron holds multiple
sessions and the UI lists them.

**Do not soften this.** Linking identities server-side creates a path around an enterprise's SSO
enforcement, which is the exact thing they are paying for.

### No "personal account" concept

Slack has none, and neither do we. Every org is created the same way; a solo user simply has one
member. **One code path, no branch, no `is_personal` flag.** If billing ever needs the distinction,
a `plan` column or a member count answers it without touching the hierarchy.

**Slack also hides the org level until Enterprise Grid** — you sign up and create a "workspace",
never hearing the word organization. We do the same: both rows are always created, the UI shows one
thing.

| What the user does               | What exists in the DB                                           |
| -------------------------------- | --------------------------------------------------------------- |
| "Create a workspace called Acme" | `organizations` row + default `workspaces` row, both named Acme |
| Invites teammates                | org membership + workspace membership                           |
| Later: enterprise consolidation  | org gains more workspaces, UI reveals the level                 |

**Signup — one path for solo, startup and enterprise alike:**

```
create org (name)
  → org membership (roles: ['owner'])
  → default workspace (same name, is_default true)
  → workspace membership (role: 'admin')
  → room "general"
```

### Role model

| Level     | Mechanism                        | Roles                               |
| --------- | -------------------------------- | ----------------------------------- |
| Org       | **WorkOS RBAC**                  | `owner`, `admin`, `member`, `guest` |
| Workspace | **`role` column now; FGA later** | `admin`, `member`, `guest`          |
| Room      | Membership only                  | —                                   |

WorkOS roles are unique immutable slugs assigned via organization memberships, and a membership can
carry **multiple roles with permissions as the union** — which avoids the "design-engineering"
combined-role explosion.

**WorkOS roles cannot express workspace-level roles.** "Admin of workspace A, member of workspace
B" is not representable in an org membership, and neither are workspace invitations. Storing the
role locally is fine at launch; FGA later replaces the _evaluation_, not the storage.

**What triggers the FGA phase:** guests. Slack has single-channel and multi-channel guests, and a
guest in one room but not the workspace breaks a simple membership check. That is the signal.

### Deliberately not built

- `projects` table — see below
- Workspace switching UI — one default workspace, hidden
- FGA — deferred until guests are real
- Cross-workspace rooms (Slack's XWS channels) — needs a join table; resist
- Person-level identity linking

### Projects are a grouping, not an access boundary

**Decided.** A project groups rooms inside a workspace for organisation. It never grants or
restricts access. Access is decided at workspace and room level only.

This is why `project_id` can safely wait: adding a **grouping** later has a safe default —
everything becomes "Unfiled" — with no authorization backfill and no per-customer conversation
about intent. Adding an **access boundary** later has no safe default, which is the whole reason
`workspaces` exists from day one.

The column is on `rooms` now, nullable, and nothing reads it.

**The line to hold.** The first request will be _"can I share this project with a client without
giving them the whole workspace?"_ Saying yes makes projects an FGA resource with a parent
relation, not a column — a different and much larger piece of work. If that becomes a real
requirement, the answer is a **guest with room-level grants**, which is the FGA work already
scheduled by the guest trigger. Do not reach for it by promoting projects.

**Corollary for the UI:** a room's project must never affect who can see it. If a project ever
looks like it is hiding rooms, that is a bug, not a feature request.

### Three-tier storage

| Tier                            | Where                    | Synced? | Shape                                                                |
| ------------------------------- | ------------------------ | ------- | -------------------------------------------------------------------- |
| Event labels                    | `run_events` in Postgres | Yes     | `{run_id, seq, kind, label, count, started_at, blob_key}` ≈200 bytes |
| Full tool inputs/outputs, media | **Cloudflare R2**        | Never   | Arbitrary size                                                       |
| Run metadata                    | One row per run          | Yes     | Status, timings, credential ref                                      |

Pi's own session state (session trees, compaction, branch summaries) is a **blob in R2 keyed by
run**. Tables defined here; blob writing lands in Phase 6.

### Object storage: Cloudflare R2

**Decided.** S3-compatible, so `@aws-sdk/client-s3` works and a later move to GCS or S3 is config,
not a rewrite.

Three reasons, in order of weight:

1. **Zero egress on every storage class.** Artifacts are read from Electron clients and some are
   large (Playwright traces, video). On S3/GCS that is ~$0.09–0.12/GB out — the line item that
   grows unpredictably and makes you hesitate before shipping "download the full trace".
2. **Everything else is already there.** The sandbox mounts R2 as a filesystem (so large artifacts
   never transit the broker), the serving Worker binds to it directly, the shape proxy is on the
   same platform.
3. **S3 compatibility** keeps the exit cheap.

**Pricing:** Standard $0.015/GB-month, Class A (writes) $4.50/M, Class B (reads) $0.36/M, egress
free. Free tier 10 GB + 1M Class A + 10M Class B monthly. **Billing rounds up to the next unit** —
1,000,001 operations bills as 2 million.

#### The cost shape is inverted: writes dominate, not storage

Modelled at 1,000 DAU / 300K runs per month:

| Line                                           | ₹/month     |
| ---------------------------------------------- | ----------- |
| Storage (~390 GB rolling)                      | ~₹515       |
| **Class A (writes), one object per tool call** | **~₹2,100** |
| Class B (reads)                                | ~free tier  |

Because egress is free, the bill moves onto operations. Hence:

**[DECISION] Batch blob writes on the same boundary as `run_events`** — one object per _flush_
(tool kind changes / ~10 calls / ~1s), not one per tool call. Cuts Class A roughly 10×, taking that
line to ~₹200. This is the same discipline as invariant 6, applied to the blob tier.

#### Serving: a Worker with cache headers, NOT presigned URLs

Presigned S3 requests bypass the edge cache, so every view is a fresh Class B read. Instead: a
Worker checks authorisation, then serves from the R2 binding with
`Cache-Control: public, max-age=31536000, immutable`.

Artifacts are immutable and content-addressed by `run_id/seq`, so infinite cache is correct, and
the second view of a screenshot costs nothing. The proxy is already on Workers — same deployment.

**Never stream blob bytes through the broker or API server.**

#### Storage classes — Infrequent Access is a trap for the small-payload tier

IA is $0.01/GB storage but **doubles operations** ($9.00/M Class A, $0.90/M Class B), adds
$0.01/GB retrieval, has a 30-day minimum, and **receives no free tier**. Since operations dominate,
IA would make the payload tier _more_ expensive.

**Use IA only for large, rarely-read objects** — video and traces past 30 days. Tool payloads stay
Standard.

#### Video: plain MP4 in R2, not Cloudflare Stream

R2 supports HTTP range requests, which is what gives seeking and progressive playback in Electron.
That is all a 1–3 minute agent clip needs. Stream earns its keep for long video, adaptive bitrate
and many concurrent viewers — none of which describes "watch what the agent did".

**Prefer Playwright `trace.zip` over video where possible** — it carries screenshots, clicks,
navigation and console messages, opens in the Trace Viewer, and is smaller and more useful for
debugging.

#### Bucket layout

```
runs/{run_id}/{flush_seq}.json     Standard → IA @30d → expire @retention
runs/{run_id}/session.json         pi session blob
media/{run_id}/{seq}.png           screenshots — Standard, cached hard
media/{run_id}/{seq}.mp4           video — IA @30d
traces/{run_id}/{seq}.zip          Playwright traces — IA @30d
attachments/{org_id}/{file_id}     user uploads — Standard, NO expiry
```

`attachments/` never expires: user data, not derived artifacts. Same derived-vs-precious split as
the local SQLite tables in Phase 4.

**[HAZARD H12] Lifecycle rules must match `run_events` partition retention.** Partitions are
dropped monthly; if blobs do not expire on the same clock, `blob_key` references outlive their rows
and storage only grows. **Configure lifecycle when the bucket is created**, not later.

### Local development: everything runs offline, nothing touches managed data

**Decided.** The whole stack is locally runnable. This is a hard requirement, not a convenience —
the failure being guarded against is a local run writing to a production replication slot (H1),
which is unrecoverable.

| Layer               | Locally                   | Notes                                                                                                                                                                                                                       |
| ------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres            | Docker / `supabase start` | Full control incl. replication slots                                                                                                                                                                                        |
| Electric            | Docker (open source)      | Runs against any Postgres — whole read path local                                                                                                                                                                           |
| API server / broker | `wrangler dev` (workerd)  |                                                                                                                                                                                                                             |
| Durable Objects     | `wrangler dev`            | SQLite storage included                                                                                                                                                                                                     |
| R2                  | `wrangler dev`            | Emulated                                                                                                                                                                                                                    |
| **Sandbox**         | Docker via `wrangler dev` | **Egress interception works locally** — a `proxy-everything` sidecar applies TPROXY rules routing container traffic to workerd, explicitly so local mirrors prod. The open-then-lock pattern is testable without deploying. |
| **WorkOS**          | **`@workos/emulate`**     | See below                                                                                                                                                                                                                   |
| pi                  | Node library              | Point `pi-ai` at local vLLM or Ollama                                                                                                                                                                                       |
| Electron / web      | Vite                      |                                                                                                                                                                                                                             |

**`@workos/emulate` is the piece that makes this work.** An open-source local WorkOS API server —
point any SDK at it via a base-URL override and nothing reaches the live environment. Listens on
`:4100`, accepts `sk_test_default`, `GET /health` for readiness. Self-contained binaries for macOS,
Linux and Windows; no Node required.

Three properties that matter:

- **Declarative seed file.** Users, organizations, memberships, RBAC roles and SSO connections seed
  from YAML, and the emulator **rebuilds that exact world on every boot** — no cross-test state.
- **Pin IDs to match the real environment.** Both organizations and users accept an optional `id`.
  Pin them so a database already referencing real org/user IDs lines up, and stays stable across
  restarts. **Do this from the first seed file** — otherwise local fixtures rot against staging.
- **Forced failures.** The emulator can fail on command, which is the only practical way to test
  token refresh and retry logic before production is the first place it meets an expired token.

**What cannot be local:**

| Not local                   | Use instead                                 |
| --------------------------- | ------------------------------------------- |
| Pipes (real provider OAuth) | Dedicated GitHub test org + test app        |
| Browser Rendering           | Remote binding, or plain Playwright locally |
| A real IdP handshake        | Staging WorkOS environment                  |

**Two tiers, which is WorkOS's own recommendation:** the emulator covers most unit, integration and
local end-to-end tests; the remainder runs against **a dedicated WorkOS environment that never
serves production traffic**, seeded from YAML with `workos seed` (which also tears down cleanly).

**[DECISION] Separate every environment from day one** — WorkOS staging environment, separate
Supabase project, separate Electric project, separate R2 bucket, separate Workers environment.

### `pnpm run up` — the bootstrap contract

**Adopted from Xyne Spaces**, whose bootstrap is the best-shaped example of this for a stack this
wide. Each phase runs serially, stops at the first failure, and is **idempotent** — re-running on
an existing checkout is safe, and any phase can run on its own.

| Phase       | What it does                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------- |
| `env:setup` | Copies each app's `.env.example` into place — **never overwrites an existing file**           |
| `setup`     | Installs workspace dependencies, builds shared packages                                       |
| `secrets`   | Generates local secrets that ship as `set-me` placeholders                                    |
| `services`  | Asks which features are needed, **checks ports**, starts containers, runs migrations, seeds   |
| `dev`       | Asks which apps to run, opens them in a multi-pane process TUI (restart any one individually) |

Details worth copying exactly:

- **Pickers remember previous answers**, and scripted runs skip every prompt entirely
  (`bootstrap:raw`, `<APP_ENV>=all pnpm run dev`) so CI never hangs on a question.
- **Port checks name the process holding a busy port.** Small thing; removes the single most common
  first-run failure.
- **`set-me` placeholders** make a missing secret fail loudly with an obvious cause rather than a
  confusing runtime error.
- Xyne also ships a **doctor** command that, in an interactive terminal, can package a redacted
  local failure report. Worth having once the stack is wide enough that "it didn't start" has
  twenty causes.

**Why this earns its place:** with Postgres, Electric, workerd, Docker containers, the WorkOS
emulator and a local model endpoint, an undocumented setup means a new contributor loses a day.
For an open-source project that is the difference between contributions and none.

### Postgres stays on Supabase

GCP Cloud SQL only won if self-hosting Electric on a private IP; Electric Cloud managed means
Postgres is reached over the public internet either way. AlloyDB rejected.

_If ever revisited:_ `cloudsql.logical_decoding=on` requires a restart, and
`CREATE USER electric WITH REPLICATION IN ROLE cloudsqlsuperuser LOGIN PASSWORD '...'`.

### No RLS

Authorization lives in the shape proxy and write endpoint. Supabase RLS would be a second,
unusable authz system — `auth.uid()` requires a Supabase JWT we never issue. Leaving RLS half-on
is worse than off.

## Steps

1. npm workspaces skeleton per the tree above. All directories, empty packages.
2. `packages/schema` first: `users`, `organizations`, `organization_memberships`, `workspaces`,
   `workspace_memberships`, `rooms`, `room_members`, `messages`, `runs`, `run_events`, `claims`,
   `agents`, `connections`. Types and validators only — no runtime code.
3. Supabase project. Migrations for the above.
4. **`run_events` partitioned by month at creation time**, plus the partition-management job.
5. `tsconfig.base.json` with project references; each app typechecks across consumed packages.
6. **The bootstrap contract** — `env:setup` / `setup` / `secrets` / `services` / `dev`, each phase
   idempotent and independently runnable, with port checks and remembered answers.
7. `workos-emulate.config.yaml` with **pinned IDs**, plus the equivalent `workos seed` YAML for the
   staging environment.
8. Separate environments provisioned: WorkOS staging, Supabase, Electric, R2 bucket, Workers env.

## Nuances

- **Partition `run_events` from day one.** Retrofitting partitioning means rebuilding the Supabase
  instance. Write the cron that creates next month's partition and drops those past retention
  _now_, not when the first partition fills.
- **Decide the retention window now** — it's a schema property, and changing it later means
  reprocessing.
- **Write the bootstrap before the second developer joins**, not after. It is cheap while there are
  three services and expensive to retrofit at ten.
- **Pin emulator IDs in the very first seed file.** Retrofitting means every local fixture stops
  matching staging at once.
- **Never point a local run at a managed Postgres.** A stray replication slot is H1, and Supabase
  disk grows and never shrinks.
- **Create the workspace row from day one even though the UI never shows it.** This is the whole
  point of the Slack lesson — it costs ~half a day now and a data migration later.
- **Webhook handlers before anything reads the mirrored tables.** `user.created`,
  `organization.created`, `organization_membership.created/updated/deleted`. Postgres is a replica;
  if the webhook path is missing, the mirror silently drifts.
- Marketing and docs are **one app** unless docs need versioning and search badly enough to justify
  a second deployment and a second set of shared-component friction.

## Questions to settle

- **Q10:** docs as a route inside marketing, or its own app?
- What is the `run_events` retention window?

## Done when

`pnpm run up` on a clean machine brings up Postgres, Electric, the WorkOS emulator and the Workers
dev environment; migrations apply; `schema` typechecks; and **nothing in the local stack can reach
a managed service.**

---

# Phase 1 — Auth and Tenancy

**Goal:** a human can log in, belongs to one or more workspaces, and can switch between them.

## Decisions

### WorkOS AuthKit

The sealed cookie is unsealed by the proxy and the write endpoint, yielding
`{ user_id, organization_id }`. Every authorization decision keys off that pair.

### Login is identity-only; the session carries the active org

**Session shape is `{ user_id, organization_id }`. Workspace is NOT in it** — see invariant 9.
Workspace is navigation state, validated per request against `workspace_memberships`.

Consequences:

- Switching **workspace** needs no re-auth — it is a local UI change plus a membership check.
- Switching **org** re-issues the session, because the authentication method may differ.

**The enterprise wrinkle drives this.** An org with SSO enforced must be entered through that IdP.
The same human may hold one org via email login and another via Okta — different WorkOS users
entirely (see the identity rule in Phase 0). So _"user is authenticated"_ is never sufficient; you
need _"authenticated **for this organization**"_.

### What WorkOS gives us for free

Worth knowing before building any of it by hand:

- **RBAC** with multiple roles per membership, permissions as the union.
- **Invitations** as a first-class resource, plus an `onboard-user` workflow that sends the invite
  and assigns the role in one step.
- **Admin Portal** — embeddable UI for managing users, roles and invites, and mapping IdP groups to
  roles. This is the entire org-admin surface without building it.
- **Org domains** — domain verification gives the Slack-like "anyone with @acme.com joins Acme"
  routing.
- **Per-org API keys** and **Vault**, both in their resource set.

**What it does not give us:** anything workspace-scoped. Workspace invites are ours — WorkOS invites
to the org, our webhook handler adds the default `workspace_membership` on acceptance.

### Authorization: Postgres now, FGA for the relational tail later

Room membership checks are simple enough for Postgres, and they sit in the shape proxy's hot path
where a network call is expensive.

**WorkOS FGA** is worth adopting later for the genuinely relational cases: guest access to specific
rooms, per-event trace visibility, which agents a user may invoke, cross-workspace sharing. Its
model is `resource_type / relation / subject` with inheriting relations, answering both "is user A
an editor of document X" and "which documents can user A edit".

_Caution from WorkOS's own docs:_ checks traverse the ACL graph, and deeply nested models
significantly increase computational cost — they expose an `operations_consumed` metric because
this is hard to capacity-plan. **Never put an FGA round trip in the shape proxy's hot path.**

**WorkOS MCP Auth is not needed.** It makes AuthKit the authorization server so _external_ agents
can authenticate into an MCP server _we publish_. We are the client, not the server.

## Steps

1. AuthKit integration in `apps/server`. Sealed cookie handling.
2. WorkOS webhook handlers mirroring `users`, `organizations`, `organization_memberships`.
3. **Signup — the single path** (org → org membership `owner` → default workspace → workspace
   membership `admin` → room "general"). UI says "workspace" throughout; never shows the org level.
4. Session carries `organization_id` only. Org switcher re-issues the session.
5. Org roles configured in the WorkOS dashboard: `owner`, `admin`, `member`, `guest`.
6. Invitation flow via WorkOS `onboard-user`; webhook handler adds the default
   `workspace_membership` on acceptance.
7. A shared `unsealSession()` helper used by both the shape proxy and the write endpoint.
8. Client-side account switcher — Electron holds multiple sessions.

## Nuances

- **Build the org-switch re-issue now**, even with only one org. Retrofitting the assumption "org
  lives in the session" after code has read it from a URL param is a wide refactor.
- **Resist putting `workspace_id` in the session** even though there is only one workspace and it
  would be convenient. That convenience is precisely what Slack had to unwind.
- Mirrored tables are **read-only in application code**. A direct write to `organization_memberships`
  will be silently overwritten by the next webhook.
- **Test the SSO-enforced case early** with a WorkOS test org — the same identity entering one
  workspace by password and another by IdP. If that path is broken you won't find out until an
  enterprise trial.
- `unsealSession()` must be **the only** place the cookie is parsed. Two implementations will drift.
- **Leave room for Directory Sync.** Enterprises will want membership provisioned from their IdP,
  which changes membership from something users create to something that syncs.

## Questions to settle

- **Q1:** consumer or B2B first? This determines SSO connection spend and how early Directory Sync
  and the Admin Portal matter. _Note: the tenancy model no longer depends on this answer — the
  Slack parallel serves both._
- **Q11:** does the Admin Portal cover enough of the org-admin surface to skip building one, or do
  workspace-level admin needs force a custom UI sooner?

## Done when

Signup creates org + default workspace in one flow, an invited teammate lands in both, switching
between two orgs re-issues the session, and no code path reads a workspace from the session token.

---

# Phase 2 — Sync Read Path

**Goal:** data flows Postgres → Electric → proxy → TanStack DB → React, room-scoped and authorised.

## Decisions

### Sync engine: ElectricSQL (Postgres Sync) + TanStack DB

Electric ships shape logs over plain HTTP; TanStack DB holds collections and runs the differential
query engine.

**Rejected:**

- **Supabase Realtime** — change broadcast, not a sync engine. No shape semantics, no resume.
- **Rocicorp Zero** — the Replication Manager is a single instance, and every client query is a
  server-maintained materialised view, so cost scales with `clients × queries`. Electric's shape
  logs are plain HTTP so CDNs de-duplicate; benchmarked at 100k–1M concurrent clients on one server.
- **PowerSync** — rejected on browser grounds (WASM SQLite / OPFS pain). _This rejection is weaker
  than it was_ — in Electron you'd use native SQLite and that pain disappears. Electric still wins
  on read-path economics, which is the reason that mattered.

**Trade-offs accepted:** Electric is read-path only (Phase 3 builds the write path); a shape covers
**one table** so joins happen client-side; Electric's HTTP API is **public by default**, so shapes
must be defined server-side behind a proxy.

### Shapes are room-scoped and time-bounded

The proxy verifies the session, checks membership, and proxies to the _same_ shape every member of
that room reads (H3).

**Time-bounded too:** a room shape carries active runs plus the last few days of events. Older
history pages through a normal API request. This keeps each subscription small and stops the local
database growing without limit.

### Subscriptions are independent of what is rendered

A shape is an HTTP long-poll against a log offset; it doesn't care whether anyone is looking. So
subscriptions for all _active_ rooms stay open regardless of which room is on screen, and switching
rooms is a local query against data already present — no fetch, no spinner.

**Bound it two ways:**

1. **How many.** Someone in forty rooms should not hold forty live subscriptions — browsers cap
   concurrent requests per origin. Tier it: recently-touched or starred rooms stay live; the rest
   sync on entry then go idle.
2. **How much each carries** — the time bound above.

**Implementation: an effect-with-inverse registry.** Every subscription registers its own teardown,
living outside the React tree, with a thin hook bridging into React.

_Where this pattern comes from:_ Cordis (the meta-framework under DeepSeek Harness) formalises
_temporal composability_ — every side effect has a registered inverse, so unloading reverses it.
We adopt the discipline, not the framework: React's `useEffect` cleanup already provides this
inside the tree, and layering Cordis under React means two lifecycle systems fighting. But Electric
subscriptions live _outside_ the tree and outlive any component, which is exactly where the leak
happens. ~50 lines we own.

### The proxy runs on edge compute

**The proxy is the highest-leverage cost line** — every shape request passes it before the CDN. On
a container platform this rebuilds the cost curve Zero was abandoned for; on Cloudflare Workers or
equivalent it stays in the tens of dollars at 100k MAU (H8).

## Steps

1. Electric Cloud project pointed at Supabase. Verify logical replication.
2. **Set up `pg_replication_slots` lag alerting before anything else** (H1).
3. Shape proxy in `apps/server/src/shapes/`: unseal session → check membership → proxy to Electric.
4. Shape definitions in `packages/schema`, **server-side only**.
5. `packages/sync`: `createCollection` per shape, TanStack DB setup.
6. `subscriptions.ts` — the effect-with-inverse registry, plus the React bridge hook.
7. Render a room from synced data.

## Nuances

- **H1 first, genuinely.** An inactive replication slot grows the WAL without bound, and Supabase
  disk grows and never shrinks. This is the hazard most likely to cause an unrecoverable incident.
- On Electric PAYG there are **no Postgres subqueries in shapes**. Design shapes accordingly or
  budget for Pro.
- **Time-bound the shapes from the start.** A shape without a time bound is easy to write and
  painful to retrofit once clients depend on the history being there.
- **Build the subscription registry now**, before there are many rooms. It's the thing you can't add
  later without touching every call site.
- **Verify a CDN actually sits in front of Electric and is collapsing requests.** The entire cost
  argument for Electric over Zero rests on this.

## Questions to settle

- **Q2:** Electric Cloud egress IPs / region — needed before locking any Supabase network allowlist.
- **Q3:** does Electric's replication connection count as "activity" for Supabase free-tier pause?
  (Matters for staging cost.)

## Done when

Two browser windows in the same room see the same data, and the proxy rejects a non-member.

---

# Phase 3 — Write Path

**Goal:** users can write; writes appear via sync.

## Decisions

### We build the write path ourselves

Electric is read-only by design. The write endpoint does the same session unsealing and the same
membership check as the shape proxy, using the same `unsealSession()` helper.

### No presence or read receipts in synced tables

These multiply writes by reader count — a 50-person room is 50× (H2). If presence is wanted, it
goes over a separate ephemeral channel, never through Postgres.

## Steps

1. Write endpoint in `apps/server/src/writes/`.
2. Validators from `packages/schema` on every write.
3. Optimistic local write in TanStack DB, reconciled when the shape log catches up.
4. Message sending as the first real write.

## Nuances

- Optimistic writes need an explicit **reconciliation rule** for server rejection. Decide now
  whether a rejected write rolls back silently or surfaces — silently is usually wrong.
- Watch the write meter from the first feature. Every synced write is metered; the habit of asking
  "how many rows does this user action produce?" should form here, not at 10k DAU.

## Done when

Two users chat in a room in real time, and no user action writes to a synced table more than once.

---

# Phase 4 — Local Persistence (SQLite)

**Goal:** offline cold start renders the room.

> **Revised.** Earlier drafts of this document assumed the persister was ours to write from
> scratch (est. 2–3 days plus a week of edge cases). That is out of date. TanStack DB now ships
> `persistedCollectionOptions` over a shared `db-sqlite-persistence-core`, with published adapters
> for Tauri, Expo, React Native and Cloudflare Durable Objects. **Revised estimate: 1–2 days**,
> most of it native-module packaging rather than logic.

## Decisions

### Ship persistence in the PMF version

Previously deferred as "acceptable to re-sync on restart for PMF." Reversed on cost: at 1–2 days
we get offline reads and instant cold start for roughly the packaging work we'd have to do anyway
before shipping a desktop app.

TanStack DB is in-memory by default, and its only browser persistence option is `localStorage` —
synchronous and ~5MB capped, suitable for preferences, not run history. So without this, an offline
cold start shows an **empty room**.

### Use `persistedCollectionOptions`, don't hand-roll

It **wraps** the existing Electric options rather than replacing them:

```ts
import { createCollection } from '@tanstack/react-db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';
import { persistedCollectionOptions } from '@tanstack/db-sqlite-persistence-core';

const persistence = createElectronSQLitePersistence({ database }); // ← the bit we write

const runEvents = createCollection(
  persistedCollectionOptions({
    ...electricCollectionOptions({
      id: 'run_events',
      shapeOptions: { url: '/api/electric/run_events' },
      getKey: (item) => item.id,
    }),
    persistence,
    schemaVersion: 1,
  }),
);
```

**Three things this hands us that we previously scoped as our own work:**

1. **Offset handling is upstream.** The core resolves persistence config from collection ID and
   inferred sync mode (`sync-present` / `sync-absent`). That is the resume logic — and with it, the
   H11 bug class — handled by the library rather than by us.
2. **`schemaVersion` is per-collection and built in.** Our drop-and-rebuild decision (below) is
   already the library's model. Bump the number, it rebuilds.
3. **The adapter is a thin wrapper over a database handle.** Every published adapter is
   `createXSQLitePersistence({ database })` where `database` is that platform's SQLite binding.
   Ours passes `better-sqlite3`.

**Existing adapters, for reference when writing ours:**

| Package                                                      | Binding                  |
| ------------------------------------------------------------ | ------------------------ |
| `@tanstack/tauri-db-sqlite-persistence`                      | `@tauri-apps/plugin-sql` |
| `@tanstack/expo-db-sqlite-persistence`                       | `expo-sqlite`            |
| `@tanstack/react-native-db-sqlite-persistence`               | RN SQLite                |
| `@tanstack/cloudflare-durable-objects-db-sqlite-persistence` | DO `ctx.storage`         |

The React Native one is the closest reference — similar synchronous binding shape.

**Verify before starting:**

- Is `db-sqlite-persistence-core` published standalone? (It is referenced as its own package, which
  suggests yes.)
- Does one of the existing adapters work unmodified against `better-sqlite3`?

If either answer is favourable, this phase shrinks further.

### Local schema changes: rebuild derived data, migrate local-only data

The local SQLite file is a _cache of a shape log_, not a source of truth.

- **Derived data** (anything from Electric): handled by `schemaVersion`. On mismatch the collection
  rebuilds from the shape.
- **Local-only data** (drafts, unsent mutations, UI state): cannot be rebuilt. **Real migrations**,
  in separate tables or a separate file, never dropped. These are _not_ persisted collections in
  the Electric sense.

_Why not ALTER TABLE for everything:_ you'd need an ordered migration chain, handling of a device
offline for four versions, and a buggy migration would permanently damage data on machines you
can't reach — all to avoid a re-sync you were doing on every page load anyway.

**The client triggers this, not the server** — it arrives with the app update. The server only needs
a **minimum-supported-version** check so an ancient client is told to update rather than syncing
against a shape it can't parse.

### Upstream contribution — now a much stronger case

An Electron adapter is a **clear gap in a set of four**, following an established pattern in an
existing core package. That is the easiest kind of PR to land — far better than the speculative
from-scratch persister previously described here.

Still: build it for ourselves first, live with it, then offer it. Open an issue before the PR.

## Steps

1. Confirm `db-sqlite-persistence-core` is consumable standalone; read the React Native adapter.
2. `packages/persist-sqlite` — `createElectronSQLitePersistence({ database })` over
   `better-sqlite3`.
3. Wire `persistedCollectionOptions` around the existing Electric collections from Phase 2.
4. Set `schemaVersion` per collection.
5. Separate the local-only tables into their own migration path.
6. Native module packaging against Electron's Node ABI, per architecture.

## Nuances

- **Native module packaging is now the dominant cost**, not the persistence logic. Rebuild against
  Electron's ABI per architecture, and confirm it survives code signing. Sort this before it
  collides with Phase 11.
- **Still test offset resume explicitly** (H11). It is upstream's job now, but the failure mode
  remains silent — everything works, you just pay for a full re-read on every launch.
- The rebuild must be **visible but non-blocking** — "updating local data" with the room still
  usable from the server, not a modal. Users restart into new versions at inconvenient moments.
- **Get the derived/local-only split right at this step.** Once drafts live in a collection that
  rebuilds on `schemaVersion` bump, you're losing user data on every app update.
- Phase 12's `persist-idb` gets the same treatment — check whether an IndexedDB adapter exists
  upstream by then. `tanstack-dexie-db-collection` (community, Dexie/IndexedDB) is a starting point.

## Done when

Kill the network, restart the app, and the room renders from disk.

---

# Phase 5 — Queue and Run Lifecycle

**Goal:** runs can be created, claimed and completed. No agent yet — a stub worker.

## Decisions

### Three services, not two — the credential/code split

> **Revised.** Earlier drafts had two services: API server and agent service, with the agent
> service holding both the pi runtime and the Pipes credentials. That leaves a live provider token
> in the same process that ingests prompt-injectable content (issue bodies, PR comments, repo
> files, fetched web pages) on the API-only path where there is no sandbox. Flagged as the
> "security asymmetry" in Phase 7 with no clean answer.
>
> **Xyne Spaces (`juspay/xyne-spaces`, Apache-2.0) has the answer, running in production on the
> same pi harness we chose (pi 0.75.5).** Their formulation: _the tier that runs untrusted code
> holds no secrets, and the tier that holds every secret runs no untrusted code._ Adopted.

| Service                              | Holds                | Runs                                                                      | Placement               |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------- | ----------------------- |
| **API server**                       | Session key          | Shape proxy, write endpoint                                               | Edge                    |
| **Broker** (`claw-auth` equivalent)  | **Every credential** | Pipes lookups, connector execution, approval verification, queue dispatch | Container platform      |
| **Runtime** (`xyne-claw` equivalent) | **Nothing**          | pi loop + path-scoped filesystem tools                                    | Container platform      |
| **Sandbox**                          | Nothing              | Shell, git, tests                                                         | Micro-VM, egress closed |

**The runtime cannot reach a provider.** It posts a tool name and parameters to the broker and
receives only the result. A compromised run yields no reusable secret, because none was ever there.

**Runtime → broker auth is two factors:** `Authorization: Bearer <sessionToken>` (short-lived,
minted per run) **plus** a shared service key header. Xyne requires both on their `/sessions/:id/*`
routes; a leaked service key alone is not enough, and a leaked session token expires with the run.

**Broker → provider is a second exchange, not a forward.** Xyne signs a short-lived RS256 JWT
(`jose`) and calls the target service's _token endpoint_, which verifies the gateway JWT and returns
its own service auth token; that second token is what reaches the tool endpoint. **Tool endpoints
never receive the gateway JWT.** So a captured gateway token cannot be replayed against the tool,
and the backend keeps control of its own credential lifetime.

For our first-party connectors the equivalent is simpler — the broker resolves the Pipes token at
point of use (Phase 7) and never returns it upward — but the principle holds: _the credential goes
down and outward, never up._

**There is no public execution endpoint.** In Xyne, tool execution is reachable only internally
after an agent selects a registered tool. Ours must be the same: the broker's execute route is not
routable from the internet.

### Approval is declared metadata, not inferred — and it is signed

Two decisions, both taken from Xyne.

**1. `requiresApproval` is explicit registration metadata on the tool.** Their comment states the
reason exactly: _HTTP method is transport shape only: POST can be read-only search, and GET can
still be sensitive._ So each connector tool declares `requiresApproval` (falling back to
`isWriteTool`, defaulting false). Never infer from verb, name, or heuristic.

**2. The pending action is cryptographically signed.** The runtime calls
`POST /sessions/:id/actions/sign` on the broker and receives a signed blob; _that_ is what the
approve/decline card carries. On approval the broker verifies the signature before executing.

Without signing, an approval card is only a UI claim about what is pending — nothing binds the
user's click to the exact payload that runs. With it, the parameters that execute are provably the
ones the user saw.

**The rule for which tools carry the flag** (also Xyne's, and better than a danger heuristic):
**identity, not danger.** Acting _as the bot_ is autonomous. Acting _as you_ — anything using the
invoker's Pipes credential — needs the invoker's click. This falls straight out of the per-user
credential model in Phase 7.

**Approval is a run status** (`awaiting_approval`) that syncs like any other row, so the card
renders in the room through the shape clients already subscribe to. Only the invoker may approve.

### Callback origin allowlist

Xyne hard-checks that every caller-supplied callback or progress URL matches claw-auth's own exact
origin, _explicitly so that a leaked S2S key cannot turn the callback into an SSRF primitive against
cloud metadata or internal services._

That attack is real and cheap: leak the shared key, submit a run whose `callbackUrl` points at the
metadata endpoint, receive cloud credentials in the response. **Implement the same allowlist**
(scheme must be http/https, origin must be in an explicit set) on every URL the broker or runtime
will fetch — and note it is the same discipline as the webview URL allowlist in Phase 10
(invariant 13).

### The queue is Postgres, not a queue product

`SELECT ... FOR UPDATE SKIP LOCKED` against the `runs` table. It atomically hands each row to
exactly one worker and lets other workers skip past locked rows instead of blocking.

**Why this and not SQS/Redis:** the run row _is_ the queue entry, so status changes reach the client
through the shape they already subscribe to. No second system, no sync between them.

Polling every second is fine. `LISTEN`/`NOTIFY` can cut latency later; poll stays the reliable
fallback.

**Upgrade path:** River, if this pattern is wanted with retries and scheduling prebuilt. Still
Postgres, so not a migration.

### The agent service pulls; it does not receive run requests

Otherwise a burst of invocations becomes a burst of unbounded concurrent pi instances.

### Subagents are modelled as runs spawning runs

Pi has no subagent support out of the box (a community `pi-subagents` extension exists). But a
subagent's purpose is _context isolation_ — spawn a child, give it a narrow task, discard its
transcript, keep the summary. **A run already is that.**

So: runs spawn runs, with `parent_run_id` on the row. The trace stays **visible**, which is the
product — a hidden subagent inside one run is exactly what the trace UI exists to avoid. Cost stays
attributable per run, and it reuses the batching and storage already designed.

_Revisit the extension route only if_ subagents are needed **within a single conversational turn** —
the model delegating mid-thought without a new room entry.

### Concurrency caps live in the claim query

Per-room and per-user limits enforced at claim time is what stops one user's fan-out starving
everyone else, and it is the defence against runaway spawned runs (H5).

## Steps

1. `runs` gains status, `claimed_at`, `worker_id`, `heartbeat_at`, `retry_count`, `priority`,
   `parent_run_id`.
2. Claim query with per-room and per-user concurrency caps **inside the query**.
3. Heartbeat loop in the worker; sweeper resetting stale `running` rows.
4. Dead-letter status after N retries.
5. Stub worker that writes a few fake `run_events` and finishes.
6. Trace rendering in the UI from synced `run_events`.

## Nuances

- **Caps in the claim query from the first version** (H5). Adding them later means finding every
  code path that claims.
- **Crash recovery is the part that needs care.** A worker holding a run can die mid-flight, so the
  sweeper resets stale rows — which means **runs must be safe to retry, and they aren't naturally**.
  An agent that already opened a PR shouldn't open a second one (H6). Required: retry count with a
  dead-letter status, and idempotency keys on external side effects.
- **Decide retry semantics before any real side effects exist.** Once the agent opens PRs,
  retrofitting idempotency is archaeology.
- The sweeper interval and heartbeat interval need a sane ratio — a sweeper firing at 2× the
  heartbeat will steal live runs under load.
- **Run status transitions only.** Resist writing progress percentages.
- Add the **priority** column now: interactive runs (someone is watching) jump ahead of scheduled
  ones.

## Decided: agent identity (was Q6)

**An agent is a resource, not a principal.** No agent rows in `users`, no room-scoped agent
credentials, no second identity system.

The agent service authenticates to the write endpoint **as a service**. Each write is authorised by
the `runs` row it references — which already carries `invoked_by`, `workspace_id` and
`organization_id`. The proxy checks that the run exists, is `running`, and that its workspace
matches the write target.

This falls out of the tenancy schema in Phase 0 and needs no extra machinery.

## Questions to settle

- None blocking. Confirm the service-auth mechanism (per-org API keys are available in WorkOS's
  resource set) before Phase 6.

## Done when

Enqueue 100 stub runs, kill a worker mid-flight, and every run reaches a terminal state exactly
once.

---

# Phase 6 — pi Embedding

**Goal:** a real agent runs, with no connectors and no sandbox.

## Decisions

### Harness: pi, SDK embedding mode

Repo is `earendil-works/pi` (moved from `badlogic/pi-mono`); packages renamed `@mariozechner/*` →
`@earendil-works/*`.

- `pi-agent-core` — agent runtime, tool calling, state management. **The one to embed.**
- `pi-ai` — unified multi-provider LLM API; works with any OpenAI-compatible endpoint including
  self-hosted vLLM.
- Four modes: interactive, print/JSON, RPC, **SDK for embedding** ← ours. One runtime instance per
  run.

**Extension shape:**

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

`pi.on("tool_call", ...)` confirms the **trace-label hook is a first-class event**, not something
to scrape.

**Package manifest:**

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

**Dependency rules that will bite (H9):**

- Core packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) →
  `peerDependencies` with `"*"`, **never bundled**.
- Other pi packages → **both `dependencies` and `bundledDependencies`**, referenced via
  `node_modules/` paths, to keep module roots isolated.

**Pi ships no permission system** — no filesystem, process, network or credential restrictions. It
runs with the permissions of whatever launched it. Containerisation is a prerequisite, not a
hardening task.

**This is exactly why pi runs in the credential-free runtime tier** (Phase 5). Pi has no way to
restrict itself, so the restriction is the process boundary: the runtime holds no tokens, has no
shell, and gets only path-scoped filesystem tools. Everything else is a call to the broker.

### Reference implementation: `juspay/xyne-spaces`

Apache-2.0, TypeScript, running **pi 0.75.5** in production (`pi-agent-core`, `pi-ai`,
`pi-coding-agent`). Read `apps/xyne-claw` and `apps/xyne-claw-auth` before writing this phase — the
comments document failures they already paid for. Specifically worth lifting:

- **Tool budgets nudge, never block.** Their stated owner decision: the budget never blocks tool
  calls — agent autonomy wins — it only steers. First convergence warning at ~120 calls, repeat
  nudge every ~100 after. Implemented as a `beforeToolCall` wrapper calling `agent.steer()` with a
  system-tagged user message. **Better than the hard ceilings previously proposed here**: a hard
  stop kills legitimate long investigations, a nudge costs nothing when the agent is on track.
- **Dual-cap tool output with spill-to-file.** Bulk tools get a small inline cap (~32KB); **search
  and retrieval tools get a much larger one (~128KB)**, because retrieval results are the evidence
  the model must reason over — spilling those behind a small preview makes the model answer from
  the preview alone, which they call the single biggest grounding leak. Over-cap output goes to
  `.context/tool-results/` with a preview plus path.
- **Spilled files must be line-structured.** pi's `read` paginates by line with a ~50KB per-line
  cap and `grep` is line-oriented, so minified JSON on one physical line can never be paged or
  grepped. Reflow to JSON-Lines before writing.
- **Prefetch before the first turn.** Emitting any tool call ends the assistant turn, so
  deterministic lookups (whoami, name→id) each cost a full round trip. Resolve them with one cheap
  model call plus parallel tool calls and inject the digest into the first user message. Their four
  rules: never fail the run, resolve don't decide (attach all matches), bounded digest only, and
  label it unverified so the model re-checks rather than anchoring.
- **Version-guard any reach into pi internals.** They patch a real pi 0.75 gap (compaction runs
  after an assistant message but ignores the tool_result that just landed and will be in the next
  prompt). The discipline: isolate the coupling to one interface, assert every private exists, and
  **fail loudly with a metric** degrading to pi-native rather than breaking silently weeks later.
- **The bootstrap contract** (see Phase 0) — idempotent phases, port checks, `set-me` placeholders.
- **Sessions are a cache, not the record.** Flush to object storage before releasing the
  conversation lock; restore on resume from any worker. Archive failure is **strict** — if upload
  fails for any reason the local copy is not deleted. They shipped a 7-day local TTL, hit ENOSPC,
  and cut it to hours.

### DeepSeek Harness / Cordis — evaluated, not adopted

Cordis gives _temporal composability_ (every effect registers its inverse) and _spatial
composability_ (dependencies declared reactively; a provider disappearing unloads its dependents).
Sound engineering, but aimed at long-lived processes with runtime plugin swapping. A run is
short-lived, and process boundaries already give us that cleanup for free and more reliably.

DeepSeek Harness itself is at **rc.5 developer preview**, a few weeks old, from a single lab — thin
ground for a load-bearing dependency in a product where colleagues share rooms.

**What we borrowed:** the effect-with-inverse discipline, applied to the subscription manager in
Phase 2. Worth re-reading Cordis's sandbox and storage plugin boundaries as _design input_ for
Phase 8 without adopting the dependency.

### Run trace transport: Postgres Sync, no streaming

Execute tool → batch similar tools → write one DB row. A few hundred milliseconds of latency is
invisible for a trace label, and this buys one data path instead of two plus free offline
scrollback.

Only **tool-call labels** reach the UI ("grepped useAuth", "read FileName.tsx"). Never token
streaming. Tool payloads never reach the UI.

**Batching — buffer and write ONCE** (H4). Flush on: tool kind changes, count reaches ~10, or ~1s
elapsed.

## Steps

1. **Split `packages/agent` into `runtime` and `broker`** per Phase 5. The runtime gets no
   credential env vars at all — enforce by config, not convention.
2. `packages/agent/runtime` with pi SDK embedding, peer/bundled layout per above.
3. Short-lived per-run session token minted by the broker; runtime sends it plus the service key.
4. Callback origin allowlist on both sides (invariant 13).
5. One runtime instance per run.
6. `pi-ai` pointed at the self-hosted OpenAI-compatible endpoint.
7. `events.ts` — `pi.on("tool_call")` → batched trace labels.
8. Pi session state → object storage blob keyed by run.
9. Full tool inputs/outputs → object storage keyed `run_id/seq`; only `blob_key` in Postgres.

## Nuances

- **Verify the peer/bundled dependency layout before building on it** (H9). A duplicate pi runtime
  manifests as bizarre state bugs, not import errors.
- The batching flush rules are easy to implement wrong in a way that _looks_ fine — assert in tests
  that N tool calls produce fewer than N rows.
- **Keep the two histories separate.** The temptation to render pi's session tree in the UI will
  appear; resist it.
- At this phase the agent runs with the service's permissions — acceptable only because there are
  no connectors and no untrusted code yet. **Do not ship this configuration to users.**

## Done when

A user invokes an agent in a room, and everyone sees batched trace labels appear.

---

# Phase 7 — Credentials and the GitHub Connector

**Goal:** one connector working end to end. This phase proves the model.

## Decisions

### WorkOS Pipes for third-party credentials

`workos.pipes.getAccessToken({ provider, userId, organizationId })` returns a valid token, always.
Pipes handles expiry, refresh and concurrency; credentials are encrypted in Vault; revocation is a
single call. **It works with no signed-in session**, which matches webhook- and queue-triggered runs.

**The long tail is covered both ways:**

- **Custom OAuth providers** — Dashboard → Pipes → Connect provider → Add a custom provider.
- **API-key providers are first-class** — the user pastes a key, WorkOS stores it encrypted, and it
  is retrieved **through the same flow as OAuth access tokens**. Nearly zero configuration; the
  only optional field is a description shown in the widget.

### Credential rules

1. **Tokens are scoped per USER, not per agent.** The token belongs to whoever _invoked_ the run,
   not whoever authored the agent — otherwise creating an agent silently lends your GitHub access
   to everyone. An agent is a recipe; credentials attach at invocation.
2. **Connections are global per user _and_ per organization.** Someone's personal GitHub must not be
   usable by an agent in their employer's workspace. `getAccessToken` takes both IDs — use both.
   Invocation is an intersection check between the agent's declared providers and the user's
   connected providers.
3. **Prompt only when the agent needs a scope the connection doesn't already have.** If write is
   already granted, a second agent needing write grants nothing new. Most users hit one prompt ever.
4. **Preflight before spending compute.** No connection → write a run row with status `needs_auth`
   and the required provider, sync it, render a connect prompt inline. Never discover this 40s in
   after a checkout. The prompt is **private to the invoker**; others see something neutral
   ("waiting on Harsh"). `needs_auth` runs are **non-blocking** for the room.
5. **Fetch tokens at point of use, not once at run start.** A 10-minute PR task can outlive a
   short-lived token. Re-fetch on 401 and retry. If a user disconnects mid-run, fail cleanly with a
   clear reason.
6. **Store `credential_ref` on the RUN**: `{agent_id, invoked_by, credential_ref}`. Answers "whose
   access did this use" when a commit appears under someone's name.
7. **One per-agent consent stays:** the first time you run _someone else's_ agent. That is a trust
   decision, not a credential one — acknowledged once, then never again. A lightweight inline line
   in the trace naming which credential it runs as beats a modal.

### The known gap: Pipes secures storage, not scope

**GitHub OAuth grants are per GitHub account, not per workspace.** If both workspaces connect the
same GitHub account, you get two credential records with identical access — and people commonly use
one GitHub account for personal and work repos.

The real boundary is **scopes and installation**. For enterprises, use a **GitHub App installed on
the organization's repos**, so access is bounded by installation rather than by the individual's
full account reach. That is a different integration path from the personal case, and it must exist.

### The credential never enters the runtime

**Resolved by the Phase 5 split.** Previously this phase carried a known gap: no sandbox exists
yet, so injection in issue text or PR comments could drive destructive API calls with a live token
sitting in the agent process.

With the broker/runtime split, the GitHub token is resolved and used **inside the broker**. The pi
runtime asks for `github.create_issue` with parameters and receives a result. Injection reaching
the runtime finds no token to abuse — it can only request tools, and write tools require the
invoker's signed approval.

**Token scoping is still required, not optional** — it bounds what an _approved_ call can do.
Fine-grained, per-repo, read-only unless the task needs writes.

### The connector package shape

**A connector = extension + skills + prompts** — pi's package format, structurally the same idea as
a Codex plugin bundle.

- **Extension** = capability. `registerTool` per operation; token fetched from Pipes at call time.
  Also registers the `tool_call` handler mapping calls to trace labels, so **each connector owns its
  own labels** and there is no central mapping table to maintain.
- **Skills** = the knowledge that stops the agent flailing. Provider tool descriptions are written
  for a generic consumer; they say what a tool does, not that in _your_ product one call beats
  three, or that a field is always required in practice.
- **Prompts** = templates for recurring tasks.

## Steps

1. WorkOS Pipes setup. Widget in the client.
2. Provider listing endpoint as the **preflight check** — its `connected_account` field shows
   per-user connection status, so we don't track connection state ourselves.
3. `needs_auth` status + private inline connect prompt; neutral state for others.
4. `getAccessToken({ provider, userId, organizationId })` — **both IDs, always**.
5. `credential_ref` written on the run row.
6. GitHub connector package: extension + skills + prompts, using `gh` or the REST API.
7. Token fetched at point of use; re-fetch and retry on 401.
8. First-run-of-someone-else's-agent consent as an inline trace line.

## Nuances

- **Namespace tool names (`github.create_issue`) from the first connector, not the second.**
- Build the **GitHub App** path alongside personal OAuth. Enterprises will not accept the
  personal-account model.
- Per-tenant rate limiting: five agents on one user's token should throttle the user, not us.

## Questions to settle

- **Q5:** Pipes pricing, and whether scope subsetting is possible at token-fetch time vs connect
  time.
- **Q8:** team/service-account agent mode — a shared service account, admin-configured, explicitly
  flagged. There is a legitimate want for this, but it must be **two clearly separate modes, never
  an ambiguous default.** Decide whether it lands here or post-launch.

## Done when

A user with no GitHub connection invokes a GitHub agent, gets a private connect prompt, connects,
and the run proceeds — with the trace naming which credential it ran as.

---

# Phase 8 — Sandbox

**Goal:** shell-requiring tasks work, cheaply.

## Decisions

### Pi stays on our server; the sandbox is a dumb remote filesystem and shell

Pi holds the loop and the model credentials. The sandbox executes read/write/grep/edit
instructions. Pi does **not** run inside it. (Matches `packages/coding-agent/docs/
containerization.md` — the Gondolin pattern.)

**Why a sandbox at all:** not only to contain generated code, but to protect the **GitHub credential
and other tenants' code** from prompt injection in issue text, PR comments and repo files.

### The sandbox is a tool of last resort, created lazily

Not provisioned at run start — created on the first tool call that needs a shell.

**The line is whether the task needs a working tree:**

| No sandbox (API only)       | Sandbox required       |
| --------------------------- | ---------------------- |
| Edit a PR description       | Install dependencies   |
| Comment, label              | Run tests              |
| Read issue text             | Build, lint            |
| Read a file at a known path | Broad exploratory work |

Middle case: GitHub's search API can replace ripgrep for "where is this function defined."

**If ~70% of runs are API-only, the sandbox bill drops 70% before any pause optimisation** — a
bigger lever than vendor choice. The Phase 9 authorship tiering compounds this: text-tier agents
never need a VM at all.

### Pause per turn, never per tool call

A run is mostly idle waiting on inference; holding a VM for the whole run means paying twice for
wall clock already paid for in GPU. Idle suspend alone is a **~7× cost reduction**.

But at 2 GiB, pausing costs ~8s — so pausing between two rapid tool calls **actively loses**.

### Checkout time often dominates

Cloning a large repo takes tens of seconds at full rate every run, frequently more billable time
than the agent loop. **Cache a warm template per repo** with the clone baked in; fetch the delta on
resume.

### Two templates, because you cannot resize a running sandbox

CPU/RAM are baked in at template build time (`e2b template build --cpu-count --memory-mb`). Keep a
small default and a large relaunch target.

### Narrow, explicit sandbox tools — never raw shell to the model

Xyne exposes a fixed set (`sandbox-create`, `sandbox-run`, `sandbox-write-file`,
`sandbox-read-file`, `sandbox-copy-in`, `sandbox-repo-setup`, `sandbox-deliver-files`,
`sandbox-pw-*` for Playwright) rather than handing the model a shell.

**Two details worth copying:**

**Reading and delivering are separate tools.** `sandbox-read-file` lets the agent inspect a file
privately; `sandbox-deliver-files` is what surfaces it to the user. Their tool result literally
says _"visible to you only — call sandbox-deliver-files to send it to the user."_ Egress to the
user becomes an explicit model decision rather than an accident.

**Sandbox unavailability is a first-class deferred state**, with its own error type and a
`sandbox_unavailable` retry signal — not a generic failure that looks like a broken run.

### Egress-closed is the stronger position

Xyne's microVM has **egress closed — no network, no gateway credentials — safe by isolation rather
than by permission.** Anything needing the network is driven by the gateway through `sandbox-*`
control-plane calls.

Ours currently assumes the sandbox has network for `git`. Closing egress and proxying git through
the broker removes the exfiltration path entirely. **Decide this in Phase 8**; it is much cheaper
to design in than to retrofit.

_Note on their isolation choice:_ Kata + **Firecracker**, one kernel per pod, on a dedicated Ubuntu
node pool — KVM is blocked on GKE's Container-Optimized OS. That is real operational weight and is
the argument for staying on managed E2B/Northflank until forced off.

### Vendor: Cloudflare Sandboxes — DECIDED

Previously open between E2B, Daytona and Northflank, with egress control as the tiebreaker.
**Both E2B and Cloudflare now ship dynamic egress control**, so the tiebreaker collapsed and the
decision moved to cost and platform fit.

**Egress control, verified on both:**

- **E2B** — `allowInternetAccess: false` for a hard block, or
  `network: { denyOut: [allTraffic], allowOut: [...] }` with IPs, CIDRs or domains.
  `updateNetwork()` changes rules on a _running_ sandbox. Note it **replaces rather than merges** —
  calling it with `{}` clears everything.
- **Cloudflare** — **Outbound Workers**: a programmable egress proxy running _outside_ the sandbox.
  Deny overrides allow; a non-empty allowlist means every request must match. `setOutboundHandler`
  is callable any time, before or after start, **even while connections are open**, and connections
  pick up the new entrypoint without breaking. Also does credential injection (the agent never sees
  the value — it is bound only to outbound requests matching the target host), TLS interception and
  VPC routing. `wrangler dev` mirrors it locally via a `proxy-everything` sidecar.

Cloudflare's documented example is exactly our case: **boot, fetch dependencies via npm and GitHub,
then lock down egress** — open network for as little time as possible.

**Cost at 2 vCPU / 2 GiB, ~30% of runs needing a shell, ~13s billable (₹88/USD):**

| Provider        | Basis                   | ₹/run  | 1K DAU                       | 10K DAU     |
| --------------- | ----------------------- | ------ | ---------------------------- | ----------- |
| **Cloudflare**  | $0.072 active-CPU-hr    | ₹0.023 | **₹2,000**                   | **₹20,000** |
| E2B / Daytona   | ~₹11.7/hr, manual pause | ₹0.042 | ₹3,800                       | ₹38,000     |
| Northflank BYOC | ~₹1/hr, wall clock      | ₹0.025 | ₹2,250                       | ₹22,500     |
| Northflank PaaS | ~₹4/hr, wall clock      | ₹0.10  | ₹9,000                       | ₹90,000     |
| Vercel          | active-CPU              | —      | region-locked (iad1), 5h cap | —           |

Note the convergence: **cheap-rate-with-wall-clock ≈ expensive-rate-with-active-CPU.** Northflank
BYOC costs about the same as Cloudflare but requires running a Kubernetes cluster — no saving, real
ops. E2B also carries a ~₹13,000/month Pro floor.

**Why Cloudflare wins here:** active-CPU billing (time waiting on model inference is not billed)
removes the pause-management engineering entirely; snapshots cover the warm-repo-template case;
egress control is the most capable of the set; and it is the same platform as the shape proxy and
broker.

**Confirmed capabilities** (Sandbox SDK docs):

- `gitCheckout(url, { branch, depth: 1, targetDir })` — shallow clone is their own recommendation
  for large repos, and is our checkout-time lever
- Shell execution with streaming stdout/stderr, file read/write, background processes
- `exposePort()` → preview URL, with a **stable token** so the URL survives container restarts
- Snapshots (backup/restore), PTY terminals, filesystem watching
- **Mount S3-compatible object storage as a local filesystem** → the sandbox writes artifacts
  straight to R2
- Standard container images with our own dependencies

**Screenshots and video: keep the browser OUT of the sandbox.** Do not bake Chromium into the
image — it is heavy and paid for on every cold start. Instead the sandbox runs the dev server,
`exposePort()` gives it a URL, and **Cloudflare Browser Rendering** (`@cloudflare/playwright`
binding: `launch()`, `page.screenshot()`, full `trace.zip`) visits that URL. Browser time is then
billed at browser-hour rates, not sandbox CPU.

**Raising a PR: the broker does it, not the sandbox.** A `git push` needs a credential, which the
sandbox must not hold (invariant 12). The sandbox produces the diff, delivers it, and the broker
creates the branch and PR via the GitHub API with the Pipes token — which also routes it through
the approval gate naturally, since it acts _as the user_. _Fallback if the git operation must
happen inside:_ Cloudflare's credential-injection guide covers routing sandbox requests through a
Worker proxy that injects auth at request time, so the token never enters the container.

### Accepted risks

**SDK maturity.** Sandbox SDK is at **1.0 preview**; Cloudflare recommends new projects start on
`@cloudflare/sandbox@next`. HTTP and WebSocket transports are already deprecated in favour of RPC.
**Pin versions and keep the sandbox behind a thin interface** — this is the layer most likely to
move.

**Containers, not micro-VMs.** E2B and Vercel give each sandbox its own kernel; Cloudflare
Sandboxes run on Containers. With egress closed and no credentials inside, this is an acceptable
trade — but **an enterprise security review will ask**, so have the answer ready. If per-kernel
isolation becomes a contractual requirement, E2B is the move.

**Vendor concentration (H13).** Proxy, sandbox, storage and possibly browser all on Cloudflare.
Accepted because each piece is individually replaceable — R2 is S3-compatible, the sandbox sits
behind our interface, the proxy is stateless. The genuinely hard-to-move dependencies are Postgres,
Electric and pi, and none are Cloudflare.

**Operational notes:** Docker must be running locally for `wrangler deploy`, and the container
image takes several minutes to provision after first deploy.

## Steps

1. Cloudflare Sandbox SDK (`@cloudflare/sandbox@next`), pinned, behind a thin interface.
2. Lazy creation on the first tool call needing a shell.
3. Route pi's file/shell tools into the sandbox via the broker; the runtime holds nothing.
4. Egress: open to GitHub + package registries during setup, `setOutboundHandler` to lock down
   after — Cloudflare's own documented pattern.
5. `gitCheckout` with `depth: 1`; snapshot per repo as the warm-template equivalent.
6. Mount R2 so artifacts are written directly, never through the broker.
7. `exposePort()` with a stable token for dev servers; Browser Rendering visits that URL for
   screenshots and traces.
8. Diff out → broker raises the PR via the GitHub API.
9. Per-tenant rate limiting.

## Nuances

- **Measure the API-only vs sandbox split early.** If it isn't near 70/30, the cost model is wrong
  and the connector design needs revisiting before scaling.
- **Instrument checkout time separately from agent loop time.** Checkout frequently dominates and is
  what the warm template fixes.
- Remote sandbox means a network round trip per tool call (~80ms vs 20ms). Fine — but it's why
  pausing granularity matters.

## Questions to settle

- **Q4:** one sandbox per PR task, torn down at end — or one long-lived sandbox per user per repo?
  _Narrowed:_ Cloudflare snapshots make per-task cheaper than it was, since a snapshot restores a
  warm workspace without repeating setup. Lean per-task; confirm against measured restore time.
- **Q13:** does active-CPU billing hold up under a checkout-heavy workload? Cloning is real CPU and
  I/O, so it bills. Measure checkout separately from loop time before trusting the cost model.

## Done when

A PR-raising run completes, and billed sandbox time is under ~90s.

---

# Phase 9 — MCP Extension and Remaining Connectors

**Goal:** Linear, Slack, Notion — and a path to the wider ecosystem.

## Decisions

### Pi has NO native MCP support, by design

The README states: _"No MCP. Build CLI tools with READMEs (see Skills), or build an extension that
adds MCP support."_ No MCP configuration, CLI flags, or stdio server compatibility exists in the
codebase.

**We build the MCP client extension anyway.** The Skills-over-CLI path is genuinely cheaper — no
server process per user per run, no tool-schema bloat in context, no namespace collisions, and a
CLI call is just another shell command in the sandbox we already have. But most SaaS has no CLI
(Figma being the obvious case), and for a platform where **users author agents**, MCP is the only
way to consume the growing ecosystem.

**Rule: MCP where a solid official server exists; thin CLI + skill where it doesn't.** A ~50-line
REST wrapper plus a README is a legitimate connector and stays on pi's intended path.

### Prioritise remote MCP servers over stdio

Claude Code "connectors" are mostly **remote** MCP servers — an HTTP endpoint hosted by the vendor,
with **OAuth built into the protocol**. That means no subprocess, no token injection, no per-user
process pool. The extension becomes an HTTP client with OAuth handling rather than a stdio process
manager.

**Note the overlap:** a remote server with its own OAuth doesn't need Pipes to store the token.
**Pick one path per provider, not both.** Caveat for a shared workspace: a third-party-hosted
endpoint holds the user's provider access.

### Two-tier agent authorship

| Tier       | Content                              | Runs untrusted code? | Gating                    |
| ---------- | ------------------------------------ | -------------------- | ------------------------- |
| Self-serve | Skills + prompt templates (**text**) | No                   | None                      |
| Privileged | TypeScript extensions (**code**)     | Yes                  | Review or enterprise plan |

**An agent = a set of packages + skills + a prompt.** Composition, not code, for the self-serve
tier. Extensions need a micro-VM, per-tenant resource limits and egress control; text does not.

This is also the tiering that removes ~90% of sandbox cost.

### Progressive tool disclosure — solves tool-count degradation

Four connectors plus MCP plus browser plus search puts us well past ten tools, where selection
quality degrades noticeably.

Xyne's answer: two **meta-tools**, `search-tools` and `load-tools`, over a tool catalog with a
`maxActiveTools` ceiling. The system prompt carries a one-line index per tool; the agent searches
and loads what it needs. Catalog entries carry a provenance label and a user-facing catalog
grouping that the meta-tools filter on.

They also scope by connection: _a connector only appears for a user once they have connected it, so
an agent's available tools are a function of that user's own integrations — and tool sets are
scoped per agent rather than handing every run the full catalogue._ That is exactly the
declared-providers ∩ connected-providers intersection from Phase 7.

### One adapter interface for trace labels

Tool call → `{human label, blob key}`, at the pi extension level, keyed by server + tool name, so
labels stay consistent across connectors.

## Steps

1. MCP client extension for pi. **Remote/HTTP first**, stdio later or never.
2. OAuth handling for remote servers; one path per provider.
3. Tool discovery → `registerTool`, namespaced.
4. The adapter interface above.
5. Linear, Slack, Notion connector packages — each extension + skills + prompts.
6. Self-serve authorship UI for skills and prompts; gating for extensions.

## Nuances

- **The skills are the differentiator, not the tools.** Budget real time for writing them, and let
  users layer their own — a team wanting better Figma guidance for their conventions should not need
  code review.
- **Notion needs the most skill content of the four.** Pages vs databases, blocks as a nested tree,
  per-database property schemas: search before you read, page IDs come from search results,
  appending blocks needs a parent, don't set properties on a page that isn't in a database.
- A third-party-hosted remote MCP endpoint holds the user's provider access. Note that in the
  connector description; it may be unacceptable for some enterprises.
- Per-tenant rate limiting matters here. _(If Strava is ever added: its limit is ~200 requests per
  15 min **per application**, shared across all users — an agent looping over a year of activities
  exhausts it for everyone.)_

## Questions to settle

- **Q9:** per-event trace visibility. In a shared room everyone currently sees "grepped useAuth in
  acme/billing" even for repos they can't access. If guests or external collaborators are in rooms,
  this needs solving — a natural FGA use case.

## Done when

The four launch connectors work, and a non-privileged user can author an agent by composing
packages, skills and a prompt.

---

# Phase 10 — Webview Panel and Claims

**Goal:** the product thesis, working.

## Decisions

### Electron, not Tauri

Tauri wins on bundle size and idle memory. It loses on the thing that **is** our product: it uses
the **system webview** — WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux. The embedded
Notion/Google Docs preview would render in a different engine per platform, which is inconsistent
behaviour in the load-bearing feature of a product whose thesis is "everyone sees the same
document." WebKitGTK is the weakest and where heavy web apps misbehave.

Electron bundles Chromium: one engine, tested once. Its `<webview>` and session partitioning are
mature; Tauri's multi-webview support is newer.

_Accepted costs:_ ~100MB+ bundles, signing and notarisation, auto-update infrastructure, and prompt
Electron security patching because we ship a browser.

### The agent emits only a URL

What syncs is tiny: `{room_id, url, opened_by, at}`. No content sync, no caching, no staleness
questions, no SSRF surface, no fetch cost, no tokens to manage. Each user logs in with their own
session.

Server-side fetch-and-render was considered first, to dodge `X-Frame-Options`/CSP blocking that
defeats naive iframes. Electron makes it unnecessary — **this retroactively justifies Electron over
a browser tab.**

**Explicitly declined by product:** shared scroll position, shared highlighting. Each person has
their own login and may view different parts.

**Panel opening is offered, not forced** — a dismissible banner ("Harsh's agent opened X"), one
click to join, so layouts don't yank sideways mid-typing.

### Webview hardening — required, not optional

- Dedicated `partition` so agent-opened pages can't touch app cookies/storage
- `nodeIntegration` off, `contextIsolation` on
- `<webview>` over `BrowserView` (out-of-process)
- Allowlist navigation via `will-navigate` and `setWindowOpenHandler`
- **Block `file://`, non-http schemes, localhost and internal IPs** (H10) — the desktop app sits
  inside the user's network, so an internal URL is a genuine pivot

### Chrome cookie import — investigated and rejected

Chrome's cookie store is encrypted; on macOS the key sits in the login Keychain, on Windows it's
DPAPI-wrapped in Local State. Since ~Chrome 127, **App-Bound Encryption ties the key to Chrome's
binary on Windows specifically to stop this** — so it's a macOS-only convenience needing a good
fallback anyway. It also copies _every_ session (bank, email), is indistinguishable from infostealer
behaviour, will trip endpoint security, and will fail customer security review.

**Codex's frictionless experience is architectural, not a clever decrypt.** They ship a **Chrome
extension** running inside the user's active Chrome profile, inheriting authenticated state — it
never needed the credentials. That route breaks the split-panel premise anyway: tabs in a separate
Chrome window are not a shared panel in the room.

**Instead:** accept one-time login per provider (Electron persists partition cookies, so genuinely
once ever, and most support Google SSO). Add `shell.openExternal` "open in Chrome" as an escape
hatch. If a webview load lands on a login page, detect it and surface a "sign in to Linear" button
running OAuth **inside** the partition.

### Collaboration model: claims, not locks

The app does not merge. **Notion owns the merge. The app owns legibility.**

So: **intent broadcast, not mutual exclusion.** My agent announces "editing the Configuration
section," yours announces "editing Deployment," everyone sees both, nobody is blocked. Only when two
agents target the same section does anything intervene — and even then a visible warning may beat a
queue.

**Two-stage claim.** Claim **coarsely** up front from the prose intent, then narrow to block IDs
once the agent has read the doc and resolved them. Without this, the claim only appears after the
agent has read, reasoned and decided — potentially a minute in, during which another agent works the
same section unaware.

**Explicitly out of scope:** a human editing a block mid-run and getting a surprising result. That
is user error, not a software defect — Notion's own multiplayer has the same property with two
humans in one block. Trace visibility makes it diagnosable for free; nothing further is built.

**Known divergence to surface honestly:** the agent uses Pipes credentials and may have access a
given human doesn't. Someone without access sees a login wall in the panel while the agent works
fine. Show that clearly rather than looking broken.

## Steps

1. Electron `<webview>` with a dedicated `partition`.
2. Full hardening list above.
3. Agent emits a URL; `{room_id, url, opened_by, at}` syncs.
4. Dismissible join banner for other members.
5. `claims` table + two-stage claim.
6. Claims rendered in the room.
7. Login-page detection → "sign in to X" running OAuth inside the partition.
8. `shell.openExternal` escape hatch.

## Nuances

- **Internal IP blocking is not optional** (H10).
- A single-stage claim is nearly useless — build both stages.

## Questions to settle

- **Q7:** what happens when someone navigates away? Does revisiting the room restore the original
  URL or their last one?

## Done when

Two people watch two agents work different sections of the same Notion page, with both claims
visible.

---

# Phase 11 — Electron Packaging and Updates

**Goal:** shippable.

## Decisions

`electron-updater` with a static feed. The app checks on launch and periodically, downloads in the
background, and applies on next restart.

**Signing is mandatory, not optional.** macOS requires signing and notarisation or Gatekeeper
rejects the update — updates specifically validate the signature. Windows needs a code-signing
certificate; without one, users get SmartScreen warnings.

**Staged rollout.** A bad desktop release is not a bad web deploy you roll back in thirty seconds —
clients that already updated **stay updated**.

**Version floor.** The server tells an old client it must update, because a client six versions
behind may not parse the current shape at all (ties to Phase 4's schema versioning).

## Steps

1. macOS signing + notarisation. Apple Developer account.
2. Windows code-signing certificate.
3. `electron-updater` with a static feed.
4. Staged rollout.
5. Update-then-rebuild sequencing with a visible non-blocking indicator.
6. Server-side minimum-supported-version check.

## Nuances

- **Start the Windows certificate early** — it's the slow one to obtain.
- **Sequence carefully:** update applies → local schema rebuild runs → app usable. A frozen window
  during rebuild is the worst possible first impression of a new version.

## Done when

A signed update ships to a staged cohort and applies cleanly with a schema change.

---

# Phase 12 — Browser Surface

**Goal:** the second surface, degraded gracefully.

## Decisions

Electric being transport- and storage-agnostic is what makes this cheap: the same sync layer serves
both surfaces, and everything above the persister is identical.

**What the browser loses is the webview panel**, and that's unavoidable — iframes get blocked by
most of the sites we care about. That's one feature degrading, not the product failing.

**Positioning:** browser = join a room, read the trace, invoke an agent. Desktop = full, with shared
document preview. A legible product distinction, not a compromise to apologise for.

## Steps

1. `packages/persist-idb` — check first whether an IndexedDB adapter exists upstream by then;
   `tanstack-dexie-db-collection` (community, Dexie) is the fallback reference.
2. `apps/web` wiring it.
3. Webview panel resolves to unavailable via `platform.ts`.
4. Positioning and marketing copy reflecting the distinction.

## Nuances

- If Phases 2–10 kept everything above the persister platform-agnostic, this is small. If they
  didn't, this is where you find out.
- The panel's absence should be a **clear, explained state**, not a missing button.

---

# Appendix A — Open Questions Index

| #       | Question                                                                                                     | Phase            |
| ------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| Q1      | Consumer or B2B first? Determines SSO spend and enterprise sequencing (no longer affects tenancy)            | 1                |
| Q2      | Electric Cloud egress IPs / region, for the Supabase allowlist                                               | 2                |
| Q3      | Does Electric's replication connection count as "activity" for free-tier pause?                              | 2                |
| Q4      | One sandbox per task vs long-lived per user per repo                                                         | 8                |
| Q5      | Pipes pricing; scope subsetting at fetch time vs connect time                                                | 7                |
| ~~Q6~~  | ~~Agent identity~~ — **RESOLVED**: agent is a resource, not a principal; writes authorised by the `runs` row | 5                |
| Q11     | Does the Admin Portal cover enough of the org-admin surface, or is a custom UI needed sooner?                | 1                |
| ~~Q12~~ | ~~Projects: grouping or access boundary?~~ — **RESOLVED**: pure grouping. See Phase 0                        | —                |
| Q7      | Webview navigate-away behaviour                                                                              | 10               |
| Q8      | Team/service-account agent mode as an explicit second mode                                                   | 7 or post-launch |
| Q9      | Per-event trace visibility for guests                                                                        | 9                |
| Q10     | Docs as a route in marketing, or its own app                                                                 | 0                |
| Q13     | Does active-CPU billing hold up under checkout-heavy workloads?                                              | 8                |

---

# Appendix B — Deferred, With Reasons

| Item                                          | Why deferred                                                                                                                                                                                                | Revisit when                                                                                                                                                              |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PowerSync / Zero                              | Read-path economics favour Electric; Electron weakens but doesn't overturn the case. Weakened further now that TanStack DB ships first-class SQLite persistence — the main thing PowerSync offered for free | Unlikely to revisit                                                                                                                                                       |
| DeepSeek Harness / Cordis                     | rc.5 preview; our design is shaped around pi's event and package model                                                                                                                                      | If pi stalls, or Cordis's sandbox/storage interfaces prove worth copying                                                                                                  |
| Cordis on the frontend                        | React already provides both composability properties                                                                                                                                                        | Never — the pattern is borrowed for subscriptions only                                                                                                                    |
| `pi-subagents` extension                      | Runs-spawning-runs gives the same isolation with visible traces                                                                                                                                             | If mid-turn delegation without a room entry becomes necessary                                                                                                             |
| WorkOS FGA                                    | Workspace roles live in a `role` column at launch; FGA replaces the evaluation, not the storage                                                                                                             | **Guests.** A guest in one room but not the workspace breaks a simple membership check — that is the trigger                                                              |
| WorkOS MCP Auth                               | We're the MCP client, not the server                                                                                                                                                                        | If we expose the workspace as an MCP server                                                                                                                               |
| WorkOS Directory Sync / Admin Portal          | Sales-driven                                                                                                                                                                                                | First enterprise deal                                                                                                                                                     |
| Typesense / Meilisearch / Quickwit / pgvector | SQLite FTS5 locally + Postgres FTS server-side covers v1                                                                                                                                                    | When ranking quality is the complaint, or semantic search over Notion is wanted                                                                                           |
| Chrome cookie import                          | macOS-only, security-hostile, architecturally unnecessary                                                                                                                                                   | Never                                                                                                                                                                     |
| Self-hosted Kata/Firecracker                  | Dedicated node pool, KVM blocked on GKE COS — real ops weight                                                                                                                                               | Above ~50 concurrent sandboxes, or if per-kernel isolation becomes contractual                                                                                            |
| E2B / Daytona / Northflank                    | Cloudflare wins on active-CPU billing + platform fit; E2B carries a ~₹13,000/mo floor                                                                                                                       | If micro-VM isolation is contractually required (→ E2B)                                                                                                                   |
| Cloudflare Stream                             | R2 + MP4 + range requests covers 1–3 min agent clips                                                                                                                                                        | Long video, adaptive bitrate, or many concurrent viewers                                                                                                                  |
| Kernel / Browserbase                          | Local Electron CDP path is free and covers the interactive case; Browser Use Cloud (~₹5.3/browser-hr) covers background                                                                                     | If bot detection blocks the simpler paths. _Kernel per-hour pricing unverified — get a quote. Note their browser pools count toward concurrency whether acquired or not._ |
| Durable Streams for traces                    | Postgres Sync gives one data path and free offline scrollback                                                                                                                                               | If sub-100ms label latency becomes a requirement                                                                                                                          |

---

# Appendix C — Search (v1 decision, no dedicated phase)

Two surfaces, not one.

- **Local:** SQLite **FTS5**, which ships with SQLite. Instant, offline, no infrastructure, covers
  everything already synced — which is most of the value, since users search the rooms they work in.
  Lands naturally with Phase 4.
- **Server:** Postgres `tsvector` + GIN for what isn't local — old history, unjoined rooms. Free,
  already running.

Add a dedicated engine only when ranking quality becomes the complaint. **Quickwit** is the one to
look at first for `run_events` specifically: built for append-only log-shaped data on object
storage, which is exactly our events-plus-blobs pattern, and dramatically cheaper than Elastic for
that shape. **Vespa is over-specified** — it earns its complexity at hundreds of millions of
documents with ML ranking.
