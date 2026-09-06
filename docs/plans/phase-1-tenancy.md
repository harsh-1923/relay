# Phase 1 — tenancy: org, workspace, roles, invitations, switchers

> Working plan for the rest of Phase 1. `ARCHITECTURE.md` holds the decisions; this holds the
> breakdown, the order, and what is verified. Tick things off here. When a decision changes,
> amend `ARCHITECTURE.md` in its own turn and note it here.

**Exit criterion (from the doc):** signup creates org + default workspace in one flow, an
invited teammate lands in both, switching between two orgs re-issues the session, and no code
path reads a workspace from the session token.

**Scope: everything down to the workspace, and nothing below it.** Org, workspace, roles,
invitations to a workspace, and the two switchers. `rooms` is deliberately out — see the
bottom. Note the exit criterion above never mentions a room, and nothing in Phase 1 reads one.

## Where things stand

| #   | Phase 1 step                                                          | State                                                 |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | AuthKit, sealed session                                               | ✅ plus refresh, CSRF state, PKCE, desktop round trip |
| 2   | Webhook mirror (`users`, `organizations`, `organization_memberships`) | ✅ verified end to end through a tunnel               |
| 3   | **Signup path**                                                       | ✅ org, membership, workspace; race-guarded           |
| 4   | Session is org-only · **org switcher**                                | ✅ · ✅ built, untested in a browser                  |
| 5   | **Org roles** in WorkOS                                               | ✅ `owner, admin, member, guest` live                 |
| 6   | **Invitations**                                                       | ✅ send, list, revoke; role rides the invite          |
| 7   | `unsealSession()` shared                                              | ✅                                                    |
| 8   | **Account switcher** (desktop)                                        | ✅ built, untested with two real logins               |

## Order, and why

```
A. environment roles (dashboard)  ✅ done — owner, admin, member, guest
B. signup path                    ✅ done
C. invitations to a workspace     ✅ built
D. org switcher                   ✅ built — two orgs now exist to switch between
E. account switcher               ✅ built
```

**A is done**, so B is unblocked. C, D and E each need B and are otherwise independent of
each other.

---

## A. Environment roles — done

`owner`, `admin`, `member`, `guest` exist in the environment, confirmed at
`GET /authorization/roles`. Permissions deliberately empty — nothing reads one yet.

**Why the dashboard, not the API.** WorkOS has two kinds of role. **Environment roles** are
defined once per environment and apply to every organization — these four. The API's
`authorization.createOrganizationRole` makes **organization-scoped custom roles** whose slugs
must begin with `org-`; that is the mechanism for an enterprise customer's own roles later.

What each role means, and the guest model, are recorded in `ARCHITECTURE.md` — see
_What each org role means_ and _Guests are a union, not a graph_.

---

## B. Signup — the single path

**What.** `org → org membership (owner) → default workspace → workspace membership (admin)`.
One path for solo, startup and enterprise. The UI says **workspace** throughout and never
shows the org level — both rows are always created, the user sees one thing.

**No room.** The doc's signup sketch ends with a room called "general", and that is dropped
for now: the room schema is still moving with product decisions, and building against it now
means building it twice. Adding a room to this transaction later is one insert plus a backfill
of the orgs created in between — trivial at this scale, and cheaper than guessing the schema.

**Trigger.** A signed-in user with no `organization_id` (exactly the state today) sees
"Create a workspace". `POST /auth/signup { name }`.

**The sequencing problem, and the decision.** `workspaces.organization_id` is a foreign key
into `organizations`, which is a WorkOS mirror populated by webhook. `createOrganization`
returns before the webhook lands; locally, without a tunnel, it never lands. So the insert
would fail on the foreign key.

**Call: the signup handler upserts the org and membership mirror rows from the API response**,
using the same idempotent upsert the webhook uses, keyed on the WorkOS id. When the webhook
arrives it finds the row and is a no-op. This reads as bending invariant 4 — _never write
WorkOS-owned rows directly, they arrive by webhook_ — but the response **is** WorkOS's data;
the invariant's purpose is that we never _originate_ org state, and we don't. The webhook
stays authoritative for every later change. Record in `ARCHITECTURE.md`.

**The new org needs a session.** After signup the user's session still says
`organization_id: null`. Re-issue it for the new org (that is workstream D's mechanism, used
once here), so the response carries the fresh seal — cookie for browser, body for desktop.

- [x] `POST /auth/signup` in `apps/server`, bearer-or-cookie via `unsealSession()`
- [x] ~~idempotency key~~ → **advisory lock**. The SDK's `idempotencyKey` only guards its own internal retry of one call: two requests carrying the same `Idempotency-Key` produced two organizations against the live API. Replaced with `pg_advisory_xact_lock` on the user plus a re-check of their memberships — verified with two concurrent signups producing one org
- [x] `createOrganizationMembership({ userId, organizationId, roleSlug: 'owner' })` — the option is `roleSlug`, not `role`, and the response's assigned role is what gets mirrored
- [x] `src/mirror.ts` — `applyOrganization` / `applyMembership` / `applyUser`, shared by signup and the webhook
- [x] Workspace and its admin membership in the same transaction as the lock
- [x] `reissueForOrganization()` — `session.refresh({ organizationId })`. Also D's mechanism
- [x] Client: `organization_id: none` → "Create a workspace" → into the app
- [x] 19 server tests; concurrency verified against the live API and cleaned up

**Verified when** a fresh WorkOS user signs in, creates a workspace, and `pnpm health` shows
1 org and 1 workspace with memberships aligned upstream.

---

## C. Invitations — to a workspace

**What.** An org member invites an email. WorkOS sends the mail and owns the invitation; on
acceptance the invitee lands in the org **and** in the default workspace.

**Two kinds, one flow.** WorkOS has no concept below the org, so every invitation is an org
invitation and what differs is what _we_ do on acceptance:

| Invite as          | On acceptance                                                             |
| ------------------ | ------------------------------------------------------------------------- |
| `member` / `admin` | insert `workspace_memberships` for the default workspace                  |
| `guest`            | insert `room_members` for the invited rooms — **no** workspace membership |

**Build the handler to branch on role now**, even though the guest arm has no rooms to point
at yet. The branch is three lines; retrofitting it means revisiting the one piece of code that
is hard to test locally.

The guest arm needs to know _which rooms_, and a WorkOS invitation has no field for it — so
that is a pending-invite row of ours keyed on the invitation id. Defer the row until rooms
exist; design the branch now.

**How it composes with what exists.**

1. `userManagement.sendInvitation({ email, organizationId, inviterUserId, expiresInDays })`.
   The invitation object carries `role_slug`; confirm the SDK option name at implementation —
   the documented options are `email, organizationId, expiresInDays, inviterUserId` only.
2. WorkOS emails an `accept_invitation_url` carrying an `invitation_token`.
3. **AuthKit's hosted flow accepts the invitation as part of sign-in** when `invitation_token`
   is on the authorize URL. So `/auth/login` forwards `invitation_token` from its own query
   string into `getAuthorizationUrl({ invitationToken })`.
4. Acceptance creates the org membership upstream → `organization_membership.created` fires →
   **the existing webhook handler** receives it.
5. That handler gains one step: on a _created_ membership, insert a `workspace_memberships`
   row (`member`) for that org's default workspace.

**Why the webhook rather than a direct write like signup's.** Acceptance happens in WorkOS's
UI, not ours — there is no request of ours to hook. The webhook is the only place we learn of
it, which also means **invitations do not work locally without the tunnel**. Acceptable; the
handler is unit-testable with a synthetic `organization_membership.created`.

- [x] `/auth/invitations` — `POST` to send, `GET` to list pending, `DELETE` to revoke. Sending and revoking require `owner` or `admin`, read from the mirror
- [x] `roleSlug` rides the invitation, so acceptance carries the role into the membership event and the branch needs no extra state
- [x] `invitation_token` forwarded through `/auth/login` to the authorize URL — desktop included, same URL
- [x] Webhook branch: `member`/`admin` → default workspace; `guest` → nothing. Idempotent
- [x] `/auth/session` reports `canInvite`, read from the mirror rather than the seal, so a role change is not stuck until the next refresh
- [x] Client: invite form on Home, **TanStack Form + Query** — the first code following the rule in `CLAUDE.md`
- [x] Live probe: sent `member` and `guest` invitations, listed both, revoked both. Nothing left pending
- [x] **Accepted end to end** — `harsh.sharma.001@juspay.in` invited, accepted, and landed in both the org and the default workspace
- [x] Fixed by that run: workspace membership was granted on `organization_membership.created` regardless of status, but WorkOS creates that row as `pending` the moment an invite is _sent_. A merely-invited address held workspace access. Now gated on `status === 'active'`, checked on created **and** updated since acceptance may arrive as either

The doc mentions an `onboard-user` workflow that sends and assigns a role in one step. It did
not surface as an SDK method — likely an Admin Portal feature. `sendInvitation` covers what we
need; check `onboard-user` only if it does something `sendInvitation` cannot.

**Verified when** an invite sent from the app lands a new user in both the org and the default
workspace, with `pnpm health` showing the mirror aligned.

---

## D. Org switcher — same person, different org

**What.** One human belongs to two orgs. The session carries one `organization_id`; switching
**re-issues the session**, because the target org's authentication requirements may differ —
an SSO-enforced org must be entered through its IdP.

**Two distinct moments, two mechanisms.**

| When                                | WorkOS mechanism                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **At login**, user has several orgs | WorkOS returns `organization_selection_required` with a `pendingAuthenticationToken`; completed by `authenticateWithOrganizationSelection`. **AuthKit's hosted UI handles this** — verify it needs nothing from us |
| **Mid-session**                     | Refresh with a target `organizationId` → new seal. Confirm the exact SDK parameter (`session.refresh({ organizationId })` vs `authenticateWithRefreshToken`) at implementation                                     |

**The SSO wrinkle is the whole reason this re-issues.** If the target org enforces SSO and the
current session's method does not satisfy it, the refresh is rejected. Fall back to a full
round trip: `/auth/login?organization_id=…`, which AuthKit routes to that org's IdP. Build the
refresh path first and the fallback second — and test the fallback against a WorkOS test org
that enforces SSO, which the doc's nuances say to do early.

- [x] `POST /auth/switch { organizationId }` — membership checked against the mirror, not WorkOS: same data, already local, and a menu click must not become a network round trip
- [x] `GET /auth/workspaces` — every org the user can switch into, labelled by its default workspace, falling back to the org name when there is none
- [x] On rejection: `409 { reauth: '/auth/login?organization_id=…' }`, and `/auth/login` now forwards `organization_id` to the authorize URL
- [x] Client: the workspace menu, hidden below two entries
- [x] Desktop: the new seal rides `refreshedSession` → `auth.store()`; no shell change
- [x] 22 server tests including the menu query and the switch guard
- [ ] **Switch in a browser** — needs a real session; the data layer and guards are verified, the round trip is not
- [ ] ~~SSO-enforced fallback~~ — **deferred, not needed now.** Social login is the priority; enterprise SSO is not. The `409 { reauth }` path stays in the code because it costs nothing and is the correct answer if an org ever enforces an IdP, but it is untested and stays that way until one does

**Verified when** switching between two orgs re-issues the session and `/auth/session` follows
it — the doc's exit criterion, literally.

---

## E. Account switcher — different people, one desktop

**What.** `harsh@personal.com` and `harsh@acme.com` are **two WorkOS users** (the Phase 0
identity rule: one row per WorkOS user, not per human, and no server-side linking — linking
would be a path around an enterprise's SSO enforcement). The doc's answer is client-side:
**Electron holds multiple sessions and the UI lists them.**

**Desktop only, by construction.** The browser has one cookie and therefore one session; a
browser "switch" is sign out, sign in. The desktop shell already holds the seal in
`safeStorage` — this generalises it from one to many.

**Shape.**

- Shell storage: `sessions/<userId>` (each seal already carries its own org) plus an `active`
  pointer. Today's single `session` file migrates to this on first read.
- `auth.signIn()` **adds** an account rather than replacing the active one.
- Bridge gains `accounts()`, `switchTo(userId)`, `remove(userId)`; `token()` returns the
  active seal.
- Refresh on `/auth/session` keeps working per seal — `auth.store()` writes to whichever
  account produced it.

**Shares one menu with D.** A row is `(account, org)` resolved to a default-workspace name.
Picking a row under the same account is an org switch (D, a refresh); picking one under a
different account is an account switch (E, a seal swap). The user sees one list; two
mechanisms sit behind it.

- [x] `main/accounts.ts` — every account in one `safeStorage`-encrypted file, with the pure transitions split out so the branching is testable without Electron
- [x] `/auth/exchange` returns the user alongside the seal. A seal is opaque to the shell, so only the server can say which account it belongs to
- [x] Migration from the single-seal file: asks `/auth/session` who it belongs to, then files it. Runs once; an unusable one is renamed aside rather than retried every launch
- [x] Bridge: `accounts()`, `switchAccount()`, `signOut(userId?)`; `bridgeVersion` 5
- [x] Client menu merges both switchers into one list — workspaces for the active account, then accounts, then "add another"
- [x] Signing out one account promotes another, and revokes upstream with **that account's** seal, not the active one
- [x] 11 desktop tests on the transitions
- [ ] **Two real logins on one machine** — needs signing in twice on desktop; the transitions are tested, the round trip is not

**Verified when** two accounts coexist in the shell, switching flips `/auth/session`'s
`userId`, and signing one out leaves the other intact.

---

## Not in this plan, on purpose

| Item                                | Why                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`rooms` and `room_members`**      | The schema is still moving with product decisions. Nothing in Phase 1 reads a room and the exit criterion does not mention one, so building now means building twice. Phase 2 needs them |
| **Room-level invitations** (guests) | Follows `rooms` — the invite flow and its role branch land in C; only the pending-invite row and the `room_members` insert wait                                                          |
| Room `workspace_id` / invariant 2   | Travels with `rooms`. The Phase 0 DDL omits it and invariant 2 requires it — settle it when the table is written, not before                                                             |
| SSO-enforced org test               | Needs an IdP and a WorkOS test org that enforces it. Do it as part of D's fallback                                                                                                       |
| Directory Sync                      | Sales-driven — first enterprise deal (Appendix B)                                                                                                                                        |
| Admin Portal (Q11)                  | Whether it covers enough of the org-admin surface is answered by _using_ it once A and C exist                                                                                           |
| FGA                                 | Trigger is guests; nothing here creates one                                                                                                                                              |
| Workspace switching UI              | One default workspace, hidden — unchanged                                                                                                                                                |

## Decisions this plan asks `ARCHITECTURE.md` to record

All recorded. ✅

1. ✅ Signup upserts the org and membership mirror rows from the API response; the webhook
   remains authoritative thereafter.
2. ✅ Signup does **not** create a room. Both signup sketches amended.
3. ✅ Environment roles are dashboard-created; the roles API is reserved for per-org custom roles.
4. ✅ The account switcher is desktop-only; the browser switches by re-authenticating.
5. ✅ Guests are a union over `room_members`, not an FGA case; FGA's trigger is per-event trace
   visibility. Three follow-on references corrected alongside it.
6. ✅ Creating an organization is **not idempotent**, and the SDK's `idempotencyKey` does not
   make it so. Signup serialises per user with a Postgres advisory lock.
7. ✅ The webhook mirror **fetches a missing parent** rather than failing.
8. ✅ Only an **active** membership grants workspace access — WorkOS creates it as `pending`
   when the invitation is sent.
9. ✅ Social login first, enterprise SSO on demand. Partly answers Q1.

## Social login

Already working, and it needed no code: both users authenticated with `GoogleOAuth`, which
AuthKit's hosted UI offers because the provider is enabled in the dashboard. Nothing in
`apps/server` is provider-aware — `/auth/login` asks for `provider: 'authkit'` and the hosted
page decides what to show.

Adding GitHub, Microsoft or Apple is therefore **dashboard configuration, not a code change**.

Worth not confusing with SSO: a social provider is not an SSO connection. `GET /connections`
returns none, which is correct — those are enterprise IdP connections, and we have deferred
them.

This also partly answers **Q1** (consumer or B2B first): social login first, enterprise SSO
when a customer asks, means the early spend is zero and Directory Sync stays deferred.
