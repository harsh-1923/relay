# Phase 1 — tenancy: org, roles, invitations, switchers

> Working plan for the rest of Phase 1. `ARCHITECTURE.md` holds the decisions; this holds
> the breakdown, the order, and what is verified. Tick things off here. When a decision
> changes, amend `ARCHITECTURE.md` in its own turn and note it here.

**Exit criterion (from the doc):** signup creates org + default workspace in one flow, an
invited teammate lands in both, switching between two orgs re-issues the session, and no code
path reads a workspace from the session token.

## Where things stand

| #   | Phase 1 step                                                          | State                                                 |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | AuthKit, sealed session                                               | ✅ plus refresh, CSRF state, PKCE, desktop round trip |
| 2   | Webhook mirror (`users`, `organizations`, `organization_memberships`) | ✅ verified end to end through a tunnel               |
| 3   | **Signup path**                                                       | ❌ blocked on `rooms`                                 |
| 4   | Session is org-only · **org switcher**                                | ✅ · ❌                                               |
| 5   | **Org roles** in WorkOS                                               | ❌ API reports none                                   |
| 6   | **Invitations**                                                       | ❌                                                    |
| 7   | `unsealSession()` shared                                              | ✅                                                    |
| 8   | **Account switcher** (desktop)                                        | ❌                                                    |

## Order, and why

```
A. rooms + room_members          ← signup ends in a room; nothing else can start
B. environment roles (dashboard)  ← signup assigns `owner`; must exist first        [you]
C. signup path                    ← turns organization_id: none into a tenant
D. invitations                    ← needs B (role on the invite) and C (a default workspace to land in)
E. org switcher                   ← needs two orgs to mean anything; C + the existing "Test Organization"
F. account switcher               ← needs two WorkOS users; desktop only
```

A → B → C are strictly sequential. D, E, F each depend on C and are otherwise independent.

---

## A. `rooms` and `room_members`

**What.** The last two tenancy tables. `rooms(id, workspace_id, organization_id, project_id,
name, is_private, created_at)` and `room_members(room_id, user_id, …)`.

**The one decision.** The doc's DDL gives `room_members` no `workspace_id`. Invariant 2 says
`workspace_id` sits on everything below the workspace line, _including where derivable by
join_, and calls violating it a design regression rather than a trade-off. The doc is
inconsistent with itself here, and the H7 guard will fail the table as the DDL writes it.

**Call: add `workspace_id`.** The shape proxy authorises on every request and must never join;
`room_members` is exactly the row it checks. Record the amendment in `ARCHITECTURE.md`.

- [ ] `packages/schema/src/tables/rooms.ts` — `project_id` nullable, **no FK**, nothing reads it
- [ ] `packages/schema/src/tables/room-members.ts` — PK `(room_id, user_id)`, `workspace_id` and `organization_id` denormalised, FKs restrict into mirrors, cascade from `rooms`
- [ ] Indexes: `rooms(workspace_id)`, `room_members(user_id)` — the proxy's two lookups
- [ ] `pnpm db:generate` → one migration; `pnpm db:reset`
- [ ] H7 guard passes with **no** new exemptions

**Verified when** `pnpm test` is green and `pnpm health` shows 7 tables.

---

## B. Environment roles — `owner`, `admin`, `member`, `guest`

**What.** The four org roles the doc specifies, created in the WorkOS dashboard.

**Why the dashboard, not the API.** WorkOS has two kinds of role. **Environment roles** are
defined once per environment and apply to every organization — that is what these four are.
The API's `authorization.createOrganizationRole` makes **organization-scoped custom roles**,
whose slugs must start with `org-`; that is the mechanism for an enterprise customer's own
roles later, not for these. Step 5 is a dashboard task and it is yours.

- [ ] Dashboard → Roles: create `owner`, `admin`, `member`, `guest` **[you]**
- [ ] Set `member` as the **default role**, so an accepted invitation without an explicit role lands as `member` **[you]**
- [ ] `curl /roles` shows four slugs; `pnpm health` gains a check for them

**Permissions.** Leave empty for now. Nothing in the app reads a permission yet — authorization
is workspace/room membership in Postgres (Phase 1 decision: FGA later, and never in the proxy's
hot path). Add permissions when something checks one.

---

## C. Signup — the single path

**What.** `org → org membership (owner) → default workspace → workspace membership (admin) →
room "general"`. One path for solo, startup and enterprise. The UI says **workspace**
throughout and never shows the org level — both rows are always created, the user sees one thing.

**Trigger.** A signed-in user with no `organization_id` (exactly the state today) sees
"Create a workspace". `POST /auth/signup { name }`.

**The sequencing problem, and the decision.** `workspaces.organization_id` is a foreign key
into `organizations`, which is a WorkOS mirror populated by webhook. `createOrganization`
returns before the webhook lands; locally, without a tunnel, it never lands. So the insert
would fail on the FK.

**Call: the signup handler upserts the org and membership mirror rows from the API
response**, using the same idempotent upsert the webhook uses, keyed on the WorkOS id. When
the webhook arrives it finds the row and is a no-op. This reads as bending invariant 4 —
_never write WorkOS-owned rows directly, they arrive by webhook_ — but the response **is**
WorkOS's data; the invariant's purpose is that we never _originate_ org state, and we don't.
The webhook stays authoritative for every later change. Record in `ARCHITECTURE.md`.

**The org needs a session.** After signup the user's session still says
`organization_id: null`. Re-issue it for the new org (that is workstream E's mechanism, used
once here), so the response carries the fresh seal — cookie for browser, body for desktop.

- [ ] `POST /auth/signup` in `apps/server`, bearer-or-cookie via `unsealSession()`
- [ ] `organizations.createOrganization({ name })` with an **idempotency key** derived from the user, so a retried request cannot create two orgs
- [ ] `userManagement.createOrganizationMembership({ userId, organizationId, role: 'owner' })`
- [ ] Upsert `organizations` and `organization_memberships` from the responses (shared code with the webhook handler — one `applyOrganization`, one `applyMembership`)
- [ ] Insert `workspaces` (`is_default: true`, slug from name), `workspace_memberships` (`admin`), `rooms` ("general"), `room_members` — **one transaction**
- [ ] Re-issue the session for the new org; return it like `/auth/session` does
- [ ] Client: `organization_id: none` → "Create a workspace" form → into the app
- [ ] Test: run signup against local Postgres; a second call with the same idempotency key creates nothing

**Verified when** a fresh WorkOS user signs in, creates a workspace, and `pnpm health` shows
1 org, 1 workspace, 1 room, memberships aligned upstream.

---

## D. Invitations

**What.** An org member invites an email. WorkOS sends the mail and owns the invitation;
on acceptance the invitee lands in the org **and** the default workspace.

**How it composes with what exists.**

1. `userManagement.sendInvitation({ email, organizationId, inviterUserId, expiresInDays })`.
   The invitation object carries `role_slug`; confirm the SDK option name at implementation
   — the excerpt seen lists `email, organizationId, expiresInDays, inviterUserId` only.
2. WorkOS emails an `accept_invitation_url` carrying an `invitation_token`.
3. **AuthKit's hosted flow accepts the invitation as part of sign-in** when
   `invitation_token` is on the authorize URL. So `/auth/login` forwards `invitation_token`
   from its own query string into `getAuthorizationUrl({ invitationToken })`.
4. Acceptance creates the org membership upstream → `organization_membership.created` fires
   → **the existing webhook handler** receives it.
5. That handler gains one step: on a _created_ membership, insert a `workspace_memberships`
   row (`member`) for the org's default workspace. This is the line in the doc — _"our
   webhook handler adds the default workspace_membership on acceptance"_ — and it lands in
   code that already exists.

**Why the webhook and not the signup-style direct write.** Acceptance happens in WorkOS's
UI, not ours; there is no request of ours to hook. The webhook is the only place we learn
of it — which also means **invitations do not work locally without the tunnel**. Fine; the
handler is unit-testable with a synthetic `organization_membership.created`.

- [ ] `POST /auth/invitations { email }` — requires the caller's org membership to carry `owner` or `admin` (from `organization_memberships.roles`)
- [ ] Forward `invitation_token` through `/auth/login`; the desktop path too (it rides on the same authorize URL)
- [ ] Webhook: `organization_membership.created` → default-workspace membership. Idempotent (`on conflict do nothing`)
- [ ] Subscribe the endpoint to `invitation.*` only if we show pending invites; verify the event names then
- [ ] `pnpm tunnel` script: add the new events to the subscription list
- [ ] Test: synthetic membership event → workspace membership appears; repeated → still one row

The doc mentions an `onboard-user` workflow that sends and assigns a role in one step. It did
not surface as an SDK method — likely an Admin Portal feature. `sendInvitation` covers what we
need; verify `onboard-user` only if it does something `sendInvitation` cannot.

**Verified when** an invite sent from the app lands a new user in both the org and the
default workspace, with `pnpm health` showing the mirror aligned.

---

## E. Org switcher — same person, different org

**What.** `harsh@acme.com` belongs to two orgs. The session carries one `organization_id`;
switching **re-issues the session**, because the target org's authentication requirements may
differ (SSO-enforced orgs must be entered through their IdP).

**Two distinct moments, two mechanisms.**

| When                                | WorkOS mechanism                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **At login**, user has several orgs | WorkOS returns `organization_selection_required` with a `pendingAuthenticationToken`; complete with `authenticateWithOrganizationSelection`. **AuthKit's hosted UI handles this itself** in the redirect flow — verify it needs nothing from us                                                        |
| **Mid-session**                     | Refresh with a target `organizationId` → new seal. The emulator documents this as _"only an explicit organization_id on a refresh moves a session between organizations"_; confirm the exact SDK parameter (`session.refresh({ organizationId })` vs `authenticateWithRefreshToken`) at implementation |

**The SSO wrinkle is the whole reason this re-issues.** If the target org enforces SSO and the
current session's method does not satisfy it, the refresh is rejected. Then fall back to a
full round trip: `/auth/login?organization_id=…`, which AuthKit routes to that org's IdP.
Build the refresh path first, the fallback second, and test the fallback with a WorkOS test
org that enforces SSO — the nuance says to do this early, and it needs an IdP to exist.

- [ ] `POST /auth/switch { organizationId }` — validates the caller holds a membership in the target (from `organization_memberships`), refreshes into it, returns the seal exactly as `/auth/session` does on refresh
- [ ] On rejection: respond with `{ reauth: '/auth/login?organization_id=…' }`; client follows it
- [ ] Client: the **workspace** menu. One entry per org membership, labelled by that org's **default workspace name** — the UI never says "organization"
- [ ] Desktop: the new seal goes back over `auth.store()`; no shell change needed
- [ ] Test: two orgs (the new one + the existing "Test Organization"); switch both ways; `/auth/session` reports the other `organization_id`

**Verified when** switching between two orgs re-issues the session and `/auth/session`
follows it — the doc's exit criterion, literally.

---

## F. Account switcher — different people, one desktop

**What.** `harsh@personal.com` and `harsh@acme.com` are **two WorkOS users** (the Phase 0
identity rule: one row per WorkOS user, not per human, and no server-side linking — linking
would be a path around an enterprise's SSO). The doc's answer is client-side: **Electron holds
multiple sessions and the UI lists them.**

**Desktop only, by construction.** The browser has one cookie and therefore one session; a
browser "switch" is sign out, sign in. The desktop shell already holds the seal in
`safeStorage` — this generalises it from one to many.

**Shape.**

- Shell storage: `sessions/<userId>` (each seal already carries its own org) plus an `active`
  pointer. Today's single `session` file migrates to this on first read.
- `auth.signIn()` **adds** an account rather than replacing the active one.
- Bridge gains `accounts()`, `switchTo(userId)`, `remove(userId)`; `token()` returns the
  active seal.
- Refresh on `/auth/session` continues to work per seal — `auth.store()` writes to whichever
  account produced it.

**Sits behind the same menu as E.** One "workspace" menu; a row is `(account, org)` resolved
to a default-workspace name. Picking a row under the same account is an org switch (E, a
refresh); picking one under a different account is an account switch (F, a seal swap). The
user sees one list. Two mechanisms.

- [ ] `main/auth.ts`: multi-seal storage + migration from the single file
- [ ] Bridge + `platform.ts` types; `bridgeVersion` bump
- [ ] `useSession()`: expose accounts; switching re-fetches `/auth/session`
- [ ] Client menu: rows from E's memberships × F's accounts
- [ ] Test: two WorkOS users on this machine; switch; `/auth/session` reports the other `userId`

**Verified when** two accounts coexist in the shell, switching flips `/auth/session`'s
`userId`, and signing one out leaves the other intact.

---

## Not in this plan, on purpose

|                        | Why                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| SSO-enforced org test  | Needs an IdP and a WorkOS test org that enforces it. Do it as part of E's fallback, not before |
| Directory Sync         | Sales-driven — first enterprise deal (Appendix B)                                              |
| Admin Portal (Q11)     | Whether it covers enough of the org-admin surface is answered by _using_ it once B and D exist |
| FGA                    | Trigger is guests; nothing here creates one                                                    |
| Workspace switching UI | One default workspace, hidden — unchanged                                                      |

## Decisions this plan asks `ARCHITECTURE.md` to record

1. `room_members` carries `workspace_id` (invariant 2 over the Phase 0 DDL).
2. Signup upserts the org and membership mirror rows from the API response; the webhook
   remains authoritative thereafter.
3. Environment roles are dashboard-created; the roles API is reserved for per-org custom roles.
4. The account switcher is desktop-only; the browser switches by re-authenticating.
