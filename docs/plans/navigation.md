# Navigation — URLs, tabs, and the platform chrome

> Working plan. `ARCHITECTURE.md` is silent on client routing — nothing in its 2,200 lines
> and nothing in the 261-message design session names a URL shape, a router, a tab, or a tab
> strip. So, like `observability.md`, this document carries the decisions as well as the
> breakdown, each with its reasoning so it can be re-argued if circumstances change, not
> re-litigated by default. _Candidates for ARCHITECTURE.md_ at the bottom lists what belongs
> upstream when that file is next edited in its own turn.

**Done when:** every place in the app has a URL that survives a reload and can be pasted to
someone else; the desktop tab strip comes back intact after a quit; a link to a room in
another organization asks before switching and lands in that org's strip; and nothing above
the persister branches on which platform it is on.

**Scope:** the URL grammar and the one module that owns it, the desktop tab strip and its
storage, resolving a link across organizations, and the capability fields the window chrome
needs. Not the sidebar or room-list design, not panels (Phase 10), not multi-window.

**Not a phase.** This is groundwork Phase 2 needs on its first day — "render a room from
synced data" requires a room URL — but its storage waits on Phase 4 and its chrome on Phases
11–12. Steps below say what each waits on.

## Where things stand

| #   | Step                                                   | State                          |
| --- | ------------------------------------------------------ | ------------------------------ |
| 1   | URL grammar and the `paths` module                     | ✅                             |
| 2   | `/` redirects into the default workspace               | ✅                             |
| 3   | Platform chrome capabilities (`titleBarInset`, `tabs`) | ✅ verified in a live renderer |
| 4   | Cross-org link resolution                              | ✅ landing flow; 7 tests       |
| 5   | Tab reducer and tests                                  | ✅ 18 tests, mutated           |
| 6   | Tab storage in `sync/src/local/`                       | ✅ interface + stopgap         |
| 7   | Tab strip UI                                           | ✅ needs real destinations     |
| 8   | Desktop `relay://` room deep link                      | ✅ `relay://open/…`            |

## What already constrains this

Six settled decisions bound the design more than they first appear to. Quoted so the next
session does not re-derive them.

| Decision                                                                                                                               | Where            | What it forces                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| "Workspace is never in the session token… workspace is **navigation state** validated per request"                                     | Invariant 3      | Workspace lives somewhere navigational. Only the URL survives a reload _and_ can be shared   |
| "The shape proxy authorises on every request and **must never join**"                                                                  | Invariant 2      | The sync layer needs `workspace_id` as an explicit parameter, never derived                  |
| "The desktop renderer runs on a local origin (`app://`)"                                                                               | Phase 4 (l. 758) | History-mode routing works on desktop. One routing mode across browser, dev and packaged app |
| "Retrofitting the assumption 'org lives in the session' after code has read it from a URL param is a wide refactor"                    | Phase 1          | Org is never read from the URL                                                               |
| "What is open is shared; how it is arranged is local" — pane sizes and focus "live in `packages/sync/src/local/` with real migrations" | Phase 10         | Per-device UI state already has a home, and a migration story                                |
| Cordis under React rejected: "running two lifecycle systems side by side. That's a real class of bug and it buys you nothing"          | design session   | The recorded reasoning against a second state system on the client                           |

## Decisions

### D1 — Path is identity; query is view state

The path says **what** you are looking at; the query says **how**. `/w/:workspaceId/r/:roomId`
is a place. `?at=<messageId>` is a permalink into that place — dropping it does not move you.
A path segment is never optional and a query parameter always is; that is the test.

**Panels are never in the URL.** A panel is shared room state — the doc's own words: what
syncs is `{room_id, url, opened_by, at}`, "one row, and everyone's client opens its own
webview against it." Put it in the URL and two people in the same room hold different URLs
for the same thing, which is the premise of the panel inverted.

### D2 — IDs in the path, never slugs; org never in the path

**Not a taste call — the schema decides it.** `rooms` is `uuid primary key` with no slug
column. `workspaces.slug` is `unique (organization_id, slug)`, so it only identifies a
workspace _within_ an org, which would drag the org into the path — exactly what Phase 1
warns against. `organizations` has no slug at all. IDs also survive renames; slugs need a
redirect table the day someone renames a workspace.

**Org comes from the session, only.** Workspace UUIDs are globally unique, so `workspaceId`
alone names the tenant. When a link's workspace is not in the current session's org, the
client already holds what it needs: `/auth/workspaces` returns `{organizationId, workspaceId}`
for every org the user can reach. See D12.

### D3 — History-mode routing on all three targets

Browser, `pnpm dev`, and the packaged app all use real paths. No fragment routing. The one
reason to use `#/…` — a host that cannot serve `index.html` for arbitrary paths, or `file://`
— does not arise, because the desktop renderer runs on `app://`, a scheme the shell owns and
can make serve the bundle for any path. Fragment routing would also break something already
built: the server's `303 → /sign-in?error=…` cannot target a fragment.

### D4 — One module knows the grammar

`apps/client/src/lib/paths.ts` is the only place a route string is spelled. Everything else
calls `paths.room(w, r)`. Change the grammar, change one file. There is deliberately no
`NavigationService`: a service is stateful by construction, and the state it grows — current
workspace, history, "where is the user" — is state the router already owns. Two things that
claim to know where the user is, is the Cordis bug class.

### D5 — Building a link and going somewhere are different jobs

`paths.room(w, r)` is pure and needs nothing. `useOpenRoom()` needs the session: is this
workspace in my org, do I ask before switching, does it open here or in a new tab. Keeping the
first pure is what makes it trivially testable and impossible to couple to the router.

### D6a — A workspace is never a tab

The strip holds **focus points inside a workspace** — rooms, settings, profile — not the
workspace itself. A workspace is the container they live in: the sidebar belongs to it, and
the tabs are the several things you are looking at within it. Docking one would put the
container inside its own contents.

Two states follow, and both are ordinary rather than errors:

- **The strip can be empty.** Nothing docked means the workspace root is on screen. Closing
  the last tab therefore leaves you there instead of inventing a replacement tab.
- **`activeId` can be null while tabs remain.** Navigating to the workspace root deactivates
  without undocking, so what you had open is still there when you come back.

`isFocus()` in `apps/client/src/lib/tabs.ts` is the only place that decides, and
`packages/sync/local` stays grammar-agnostic: it is handed a `focus` that is already resolved,
or null.

### D6 — A tab holds a location, not a room

A tab can point at `/settings`, `/profile`, a room, anything the router serves. Stored as the
resolved path string. **No in-tab history:** going "back" from a settings tab is `/w/…/r/…`,
which is a navigation, not a history pop. Per-tab back/forward would mean N router instances
or a hand-rolled stack per tab, and nothing needs it yet.

### D7 — The strip is scoped to `(account, organization)`; workspace is free inside it

The scope key is exactly what the session pins, and nothing else. This is invariant 3 read
forward: workspace is not in the session, so it is not in the key.

| Boundary  | Cost of crossing                    | Two live at once?         |
| --------- | ----------------------------------- | ------------------------- |
| Account   | Swap the seal — a different person  | No, one active seal       |
| Org       | Re-issue the session, possibly SSO  | No, the session holds one |
| Workspace | Membership check, local, no re-auth | **Yes**                   |

**Not by workspace.** Workspace switching was made cheap on purpose, and the data model
already crosses it: "rooms you can see = rooms in workspaces you belong to ∪ rooms you are
explicitly a member of" — a guest is a room member with no workspace membership, and under a
workspace-scoped strip their tab has no strip to live in. Subscriptions already stay open for
every active room regardless of workspace. And today the dimension has cardinality one.

**By org, because org is different in kind.** A tab in another org cannot open without a
network round trip. A strip mixing orgs is a strip where half the tabs raise a modal first.

### D8 — The strip is not an access boundary

A tab is a cached path string. Revoking someone's access to a room must fail **at the sync
and API layer** when the tab is opened — never be prevented by the strip. If the strip
enforced anything, revocation would not close anyone's tab, and the check would apply only to
people who happen to reload. Stale tabs pointing at deleted or revoked rooms are normal and
resolve to "this room is gone."

### D9 — Strip state is local-only and survives everything; starred rooms sync; "active" is derived

Three things that look alike and must not be conflated:

| Thing              | Scope                    | Storage                             |
| ------------------ | ------------------------ | ----------------------------------- |
| Open tabs          | This device, this window | `sync/src/local/` — real migrations |
| Starred rooms      | This user, everywhere    | Synced row                          |
| "Active" sync tier | Derived                  | starred ∪ recently touched          |

The doc already gave "active rooms" the third meaning — a subscription tier, "recently-touched
or starred rooms stay live; the rest sync on entry then go idle." Tabs are pure view and
**must never drive subscription lifecycle**; switching tabs is "a local query against data
already present — no fetch, no spinner."

Tabs survive quit, crash and reload, on the same footing as drafts. The other strips — other
accounts, other orgs — persist untouched while you are away.

### D10 — No state-machine library

A strip is a list with an active index and six operations. Its complexity is invariants —
closing the active tab lands on a neighbour, pinned sort first, never empty — which is a
reducer with tests, the shape `apps/desktop/main/accounts.ts` already uses. The recorded
argument against Cordis transfers to xstate whole: a second lifecycle system under React
"buys you nothing." What _was_ kept from Cordis is the principle — the subscription registry
is "fifty lines you own, not a framework." Same call here.

### D11 — Platform chrome is a measured capability, reactive where it must be

Invariant 10 fixes the mechanism: extend `Platform`, never `if (isElectron)`. But extend it
with **numbers, not platform booleans**. `titleBarInset: number` is the pixels the renderer
must leave for the traffic lights: ~78 on macOS with `hiddenInset` (already set in the
shell), 0 in the browser, 0 on Windows and Linux where the window has a native title bar. An
`isMac` flag would get Windows wrong the day `titleBarOverlay` is enabled there.

Traffic lights vanish in macOS fullscreen, so the inset is **reactive**: the static
capability answers "does this exist," an event over the bridge answers "how much right now."

This makes the surfaces differ in four ways, not the "exactly two" Phase 12 records
(persister, panel). That is fine, and it is an amendment — see _Candidates_.

### D12 — A link into another org asks before switching; the switch and the strip swap are one event

Open a link whose workspace resolves (via `keys.workspaces`) to another org → prompt "Switch
to Acme to open this?" → on accept, `/auth/switch` re-issues the session → the strip re-keys
to the new org → the room opens as a new tab there. Not in any reachable org → "You don't
have access." Auto-switching would re-issue the session under someone with an unsent draft.

### D13 — On boot, the URL wins unless it is the root

Reload on a specific URL — a deep link, a refresh mid-room — must land there, so the URL is
authoritative: activate the tab already at that location, or open one. Only when the URL is
the root (`/`, `app://relay/`) does the stored active tab decide. Cold launch is the second
case; a pasted link is the first.

### D14 — Opening a location already in the strip activates that tab

Not a duplicate. Chrome duplicates; every workspace app focuses. A room is a place, not a
document, and two tabs on one room is never what anyone meant.

## The URL grammar

| Route                                     | Meaning                                    |
| ----------------------------------------- | ------------------------------------------ |
| `/w/:workspaceId`                         | A workspace, no room selected              |
| `/w/:workspaceId/r/:roomId`               | A room                                     |
| `/w/:workspaceId/r/:roomId?at=:messageId` | A message permalink — still the room       |
| `/settings`                               | Org settings — members, invitations, roles |
| `/sign-in`                                | Unchanged; the server redirects here       |
| `/`                                       | Redirects to the default workspace         |

```ts
// apps/client/src/lib/paths.ts — the only module that knows the grammar.

export const paths = {
  workspace: (workspaceId: string) => `/w/${workspaceId}`,
  room: (workspaceId: string, roomId: string) => `/w/${workspaceId}/r/${roomId}`,
  message: (workspaceId: string, roomId: string, messageId: string) =>
    `${paths.room(workspaceId, roomId)}?at=${messageId}`,
  settings: () => '/settings',
  signIn: () => '/sign-in',
};

/** Route patterns for the router, kept beside the builders so they cannot drift. */
export const patterns = {
  workspace: '/w/:workspaceId',
  room: '/w/:workspaceId/r/:roomId',
};
```

A `useRoomParams()` beside it decodes and types the params; no route component reads
`useParams()` raw.

**ID length.** A UUID is 36 characters in hex-with-dashes; the same 128 bits are 22 in
base64url and 26 in Crockford base32. The design session already settled client-generated
UUIDv7/ULID ids for optimistic writes, and ULID's canonical form _is_ 26-char Crockford
base32 — if rooms get ULIDs the URL is short by construction and `paths` needs no encoding
layer. Settle the ID type when the `rooms` DDL is written, not here. Either way the URL is
invisible in Electron; length matters only for pasted links and the browser surface.

## The tab strip

### Schema

```sql
-- packages/sync/src/local/migrations/001_tabs.sql
create table tabs (
  id              text primary key,        -- ULID, minted client-side
  account_id      text not null,           -- desktop holds several signed-in accounts
  organization_id text not null,           -- the strip is scoped to what the session pins
  position        integer not null,
  pinned          integer not null default 0,
  location        text not null,           -- '/w/<id>/r/<id>', '/settings'
  title           text not null,           -- cached label, so the strip paints before sync
  opened_at       integer not null
);
create index tabs_strip on tabs (account_id, organization_id, pinned desc, position);

create table ui_state (                    -- activeTabId now; window bounds later
  account_id      text not null,
  organization_id text not null,
  key             text not null,
  value           text not null,
  primary key (account_id, organization_id, key)
);
```

Three columns are load-bearing:

- **`organization_id` is stored, not derived.** The clinching case is not performance, it is
  `/settings`: a settings tab has no room to join through, so there is nothing to derive the
  org _from_. Same instinct as invariant 2, for the same reason.
- **`title` is a cache.** After a quit the strip has to paint before Electric has synced
  anything, or it is a row of blank tabs for a second. Refreshed on every `navigate`.
- **`location` is an opaque path**, because a tab can hold anything (D6). The honest cost:
  the grammar now lives in persisted rows, so changing it is a data migration. Mitigation:
  the migration imports `paths` rather than re-deriving it (hazard N1).

`position` is a plain integer, rewritten on reorder. Fractional indexing earns its keep on
collaborative or large lists; a strip is tens of rows on one device.

### Reducer

`packages/sync/src/local/tabs.ts`. Pure transitions, tested standalone like
`apps/desktop/test/accounts.test.ts`, no library.

```ts
export interface Tab {
  id: string;
  location: string;
  title: string;
  pinned: boolean;
}

/** `tabs` is display order: pinned first, then insertion order. The transitions keep both
 *  invariants; readers never sort. */
export interface Strip {
  tabs: Tab[];
  activeId: string | null;
}

/** Index of the pinned/unpinned boundary — where a newly pinned or unpinned tab lands. */
const boundary = (tabs: Tab[]) => {
  const i = tabs.findIndex((t) => !t.pinned);
  return i === -1 ? tabs.length : i;
};

export const transitions = {
  open: (s: Strip, tab: Tab): Strip => ({ tabs: [...s.tabs, tab], activeId: tab.id }),

  activate: (s: Strip, id: string): Strip =>
    s.tabs.some((t) => t.id === id) ? { ...s, activeId: id } : s,

  /**
   * Closing the tab you are looking at lands on its right neighbour, the way every browser
   * does it, falling back left when it was the last. Never leaves the strip empty — a window
   * with no tabs has nothing to render and no way back — so the caller supplies the fallback.
   */
  close: (s: Strip, id: string, fallback: () => Tab): Strip => {
    const i = s.tabs.findIndex((t) => t.id === id);
    if (i === -1) return s;
    const tabs = s.tabs.filter((t) => t.id !== id);
    if (!tabs.length) return transitions.open({ tabs: [], activeId: null }, fallback());
    return { tabs, activeId: s.activeId === id ? (tabs[i] ?? tabs[i - 1]!).id : s.activeId };
  },

  /** The router is the authority on where the active tab points; this only records it. */
  navigate: (s: Strip, location: string, title: string): Strip => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, location, title } : t)),
  }),

  /** Pinning moves the tab to the end of the pinned run; unpinning to the start of the
   *  unpinned run. Both are the same index, which is why one transition serves both. */
  setPinned: (s: Strip, id: string, pinned: boolean): Strip => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab || tab.pinned === pinned) return s;
    const rest = s.tabs.filter((t) => t.id !== id);
    const at = boundary(rest);
    return { ...s, tabs: [...rest.slice(0, at), { ...tab, pinned }, ...rest.slice(at)] };
  },
};
```

`reorder` is a splice within the pinned or unpinned run and is left to the implementation.

### Plumbing

- **Title.** Each route calls `useTabTitle(title)` — the room name from synced data,
  "Settings", and so on. The strip reads it; nothing writes `document.title` directly.
- **Write-through.** One `useEffect` on the router's location dispatches `navigate`. That
  fires on every route change, so its write is debounced (~300 ms). User actions — open,
  close, pin, reorder — write immediately. Both go through one `persist(strip)`.
- **Keying.** The strip hook is keyed on `(session.userId, session.organizationId)` from
  `keys.session`. When the key changes — account switch or org switch — load that strip.
  Nothing else to do: the new account's seal already carries its org, so `/auth/session`
  hands over the key.
- **Boot.** D13. Read the strip for the current key; apply the URL-wins rule.
- **Empty strip.** `close`'s fallback is `paths.workspace(defaultWorkspaceId)`.

### Storage, and when

`sync/src/local/` is a `.gitkeep` and `persist-sqlite` is a stub — the persister and the
migration runner are Phase 4. The reducer and its tests need neither and can land any time.
The strip UI waits on Phase 2 regardless: a tab bar over a single screen is scaffolding
holding nothing.

If Phase 2 renders rooms before Phase 4 lands, `localStorage` behind the same
`load(key) / persist(key, strip)` interface is the acceptable stopgap, swapped for the
persister without touching the reducer or the UI.

## The platform chrome

```ts
// packages/sync/src/platform.ts
export interface Platform {
  panels: boolean;
  persistence: 'sqlite' | 'indexeddb';
  session: 'cookie' | 'bearer';
  /** Draws its own tab strip. The browser has the browser's. */
  tabs: boolean;
  /** Pixels the renderer leaves top-left for the window controls. 0 where there are none. */
  titleBarInset: number;
}
```

The bridge gains `chrome.inset(): Promise<number>` and `chrome.onInsetChange(cb)`, fired on
`enter-full-screen` / `leave-full-screen`. `bridgeVersion` 5 → 6 — a bundle must be able to
say it needs them.

## Rejected

| Option                         | Why it lost                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Fragment routing (`#/…`)       | The server cannot see or redirect into a fragment; `app://` removes the only reason for it. Does not shorten anything   |
| Slugs in the path              | No room slug; the workspace slug is per-org, which drags the org into the path; renames need a redirect table           |
| Org in the path                | Phase 1 names the retrofit cost; the session owns org                                                                   |
| Panels in the URL              | Panel is shared room state, one synced row; a URL per viewer inverts the premise                                        |
| `NavigationService`            | Stateful by construction; grows a second "where is the user." Two pure functions do the job                             |
| xstate, or any state machine   | The Cordis reasoning. A strip is a reducer                                                                              |
| Strip in the main process      | Accounts live there because they hold **secrets**; tabs hold none. IPC on every navigation makes the router feel remote |
| Strip scoped by workspace      | Cheap-by-design boundary; guests have no workspace; subscriptions already cross it; cardinality one today               |
| One strip across orgs          | Half the tabs need a session re-issue before they open                                                                  |
| Short-code table (`/s/aB3xK9`) | A feature — revocable, expiring share links — not a fix for length. Build when someone asks for expiry                  |
| "Hashed" URLs                  | A hash is one-way; recovering the room needs a lookup table, which is the short-code table under another name           |
| Per-tab back/forward           | N router instances or a hand-rolled stack; user chose against it                                                        |

## Hazards

- **N1 — the grammar is in persisted rows.** `tabs.location` stores paths. A grammar change
  must ship a migration that imports `paths`; the day it is written by hand is the day two
  spellings exist.
- **N2 — stale tabs are normal.** Deleted room, revoked access, org you were removed from:
  the tab still exists and the shape request fails. The strip renders a "gone" state; it does
  not crash and does not silently drop the tab.
- **N3 — a static inset leaves a gap in fullscreen.** `titleBarInset` must be reactive or
  the top-left corner is dead space whenever the traffic lights are hidden.
- **N4 — `/settings` in a per-org strip appears to vanish on org switch.** That is correct
  for org settings (members, invitations, roles). An account-level surface — profile — must
  be a modal or a route present in every strip, or it looks like a bug.
- **N5 — `relay://` is auth-only and PKCE-gated today.** A room deep link (`relay://w/…`) is a
  separate handler in main; routing it through the auth handler means it is dropped "before
  any network call" by the verifier gate.
- **N6 — two accounts in one org.** The key is composite. Keying on org alone leaks one
  person's room titles into another's session.
- **N13 — the title bar's gutter is the sidebar's live width.** Laid out the way Linear does
  it: a gutter exactly as wide as the sidebar holds the window controls, the sidebar toggle
  and the navigation buttons (history, back, forward — placeholders for now), so the first tab
  begins where the content column does. It floors at `MIN_GUTTER` (216px) so the buttons keep a
  home when the sidebar collapses to nothing. The width is read by a `ResizeObserver` on a
  plain div of our own that fills the panel — **not** the panel's `onResize` (fired once at
  mount, never for a drag in v4) and **not** its `elementRef` (never delivered the element to a
  callback ref). A lesson worth keeping: two of the three "the library is broken" readings were
  actually Fast Refresh. Adding hooks forces a remount that resets the element state, and the
  callback ref does not re-fire on an already-mounted element, so the observer silently never
  attached under HMR. A hard reload proved the code correct. **Before blaming a library from
  inside a hot-reloaded dev session, reload.**
  The bar is also the window's drag region, the way a menu bar is: press on it and the
  window moves, double-click and macOS zooms it. The strip _inherits_ `drag`; only the things
  that need clicks opt out — each tab, the new-tab button, the gutter buttons. It was briefly
  the other way round (the whole strip `no-drag`), which left the bar draggable only in the
  pixels no tab happened to cover. Verified as a computed `-webkit-app-region` map: root,
  gutter spacer, strip, and the space after the last tab all `drag`; tabs and buttons `no-drag`.
- **N12 — the sidebar edge is `react-resizable-panels`, not a hand-rolled drag.** shadcn's
  `SidebarRail` is a click-to-toggle button wearing a `w-resize` cursor: the affordance lies.
  Rather than write a drag handler into it, the sidebar sits inside shadcn's `resizable`
  (`react-resizable-panels`) with `collapsible` and `collapsedSize={0}` — drag resizes, drag
  past `minSize` closes, and ⌘B / the toggle drive the panel's imperative handle. Two v4
  gotchas cost a round trip each: a bare `defaultSize`/`minSize`/`maxSize` number is
  **pixels**, not percent (percent is the string `"20%"`), and persistence is **not automatic**
  — `useDefaultLayout({ id, storage, panelIds })` supplies `defaultLayout` and
  `onLayoutChanged`, and the panels need matching `id`s. Width and collapsed state both survive
  a reload under `relay.sidebar`. This supersedes the earlier note about the upstream
  `sidebar_state` cookie: that cookie is still written (by the provider, whose `open` is pinned
  and inert), but nothing depends on it.
- **N10 — a switch is not done when the request returns, it is done when the session says so.**
  `/auth/switch` re-issues the session, but until the session query refetches, everything that
  reads it still names the organization you left. Navigating in that window sends you back:
  `/` resolves against the stale organization and redirects to its workspace, and the cross-org
  prompt then offers to switch to the organization you just left. So the switch mutation awaits
  its own invalidations, and only then is anyone allowed to navigate.
- **N11 — a strip must only be written back under the key it was read with.** During a switch
  the address moves before the session does, so for a moment the strip in memory belongs to the
  previous organization while the router is already elsewhere. Writing then points the old
  organization's remembered tab at the new one's workspace.
- **N8 — `useNavigate()` is not referentially stable.** It changes with the location, so an
  effect that lists it as a dependency re-runs on every navigation. In the strip's load effect
  that meant re-reading from disk each time, which silently turned "move this tab" into "open
  another one" — D6 inverted. Held in a ref. Any effect here that must run per _key_ rather
  than per _navigation_ has to do the same.
- **N9 — a deep link is "open this", not "go here".** Routed through `tabs.open` so a link to
  a room already on screen activates that tab instead of pointing a second one at it. A raw
  `navigate()` would move whichever tab happened to be active.
- **N7 — the strip key must escape its separator.** `encodeURIComponent` does not escape `.`,
  so a key joined on `.` maps `("a.b", "c")` and `("a", "b.c")` onto one strip. Joined on `:`,
  which it does escape. WorkOS ids contain neither, which is exactly why it would have gone
  unnoticed.

## Steps

**A. Grammar** — first; Phase 2 needs it on day one.

- [x] `apps/client/src/lib/paths.ts` — `paths`, `patterns`, `useWorkspaceParams()` / `useRoomParams()`
- [x] `main.tsx` route table reads `patterns`; no route string literal anywhere else.
      **Enforced as lint, not a test** — `no-restricted-syntax` in `eslint.config.mjs` scoped
      to `apps/client/src/**` with `paths.ts` exempt. It matches the three boundaries already
      enforced there, and needs no test runner in an app that has none. Probed both ways
- [x] `/` → `paths.workspace(defaultWorkspaceId)`, from `keys.workspaces`. `/sign-in` untouched.
      Needed `workspacesPending` on `SessionApi` to tell "not loaded yet" from "none", or the
      redirect hangs on a blank screen
- [x] `/settings` moves the Phase 1 invitations UI under its own route; `home.tsx` → `workspace.tsx`
- [ ] Decide the room ID type with the `rooms` DDL; add an encoder to `paths` only if UUID

**B. Chrome** — independent, small.

- [x] `Platform` gains `tabs`, `titleBarInset`; `detectPlatform()` fills them from the bridge
- [x] Bridge `chrome.inset()` / `chrome.onInsetChange()`; main listens for fullscreen events;
      `bridgeVersion` → 6 (covers `links` too — nothing has shipped at 6). **`inset` is a
      getter, not a number**: the preload holds the value and updates it from the event, so a
      synchronous read is always current. A number raced — the shell's push on
      `did-finish-load` can land before React has mounted an effect to hear it
- [x] Client reserves the inset and marks the region `-webkit-app-region: drag`. `TitleBar`
      wraps the routes so it does not remount on navigation, and is where the strip will live

**C. Cross-org links** — after A.

- [x] `resolveWorkspace()` — pure, 7 tests: same org → render; other org → prompt →
      `switchTo`; unknown → no-access; pending ≠ unknown. **Landing on a URL, not an
      imperative open**: with no room list there is nothing to click yet, and the live entry
      point is a pasted link. `useOpenRoom()` wraps the same resolution when Phase 2 gives it
      a caller
- [x] The prompt is a **panel, not a dialog**, for the landing case — arriving by URL means
      you have already left, so there is no context for a dialog to preserve. A dialog is
      right for the in-app click, and lands with it
- [x] Desktop: **`relay://open/<path>`**, not `relay://w/…` — the host names the _kind_ of
      link (the trust boundary), so the pathname is the renderer's own address verbatim and
      the shell never learns the URL grammar. `main/deep-links.ts` dispatches by host;
      `main/links.ts` holds the navigation handler beside, not inside, the auth one.
      `isInAppPath` rejects `//host` and backslashes. 10 tests across both

**D. Strip** — reducer any time; storage after Phase 4; UI after Phase 2.

- [x] `packages/sync/src/local/tabs.ts` — types, `transitions`, tests covering: close-active
      lands right then left; never empty; pin/unpin keep the boundary; navigate touches only
      the active tab; D14 activates rather than duplicates. 18 tests; vitest added to the
      package. Three invariants mutation-checked so the tests are known to bite
- [ ] `local/migrations/001_tabs.sql` — still waits on Phase 4's runner. The schema in this
      plan is what it will hold; nothing above `StripStore` changes when it lands
- [x] `StripStore` (`load` / `save`) with a `localStorage` and an in-memory implementation.
      `reviveStrip` validates on read — a stored strip is only as trustworthy as the disk it
      came from, so a bad tab is dropped rather than the whole strip refused, and both reducer
      invariants (pinned-first, `activeId` present) are re-established. The envelope carries a
      version, so a shape change becomes a migration rather than a silent loss. `createWriter`
      coalesces navigation writes, passes deliberate acts straight through, and flushes on
      demand — without which a quit loses the last navigation. `restore()` implements D13/D14.
      20 tests; four invariants mutation-checked
- [x] Titles are derived centrally by `titleFor()` rather than reported by each route via a
      `useTabTitle()` — the strip has to label tabs it is not rendering, which a per-route hook
      cannot do. Matched against `patterns`, so the grammar stays in one module
- [x] The `navigate` effect with debounce; immediate writes for user actions
- [x] Boot rule D13 (`bootTarget`, 4 tests); re-key on session change
- [x] Strip UI — built early rather than waiting, because the machinery was worth exercising
      before Phase 2 came to depend on it. Driven live against a placeholder room route:
      open, activate, pin, reorder, close, reload, quit and relaunch, and a deep link. That
      exercise found N8 and the boot bug behind `bootTarget`; the placeholder was then
      removed. `TabsProvider` is wired and is what a room list will read.
      **Open destinations are the workspace and `/settings` only** until Phase 2 routes
      `patterns.room` — the grammar and the title logic already handle rooms

## Deliberately not built

| Item                        | Why                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------- |
| In-tab history              | User decision; nothing needs it                                                    |
| Short-link table            | A feature with its own semantics (expiry, revocation); build when one is asked for |
| Slugs                       | Would need an org slug and a rename story; IDs are correct today                   |
| Multi-window                | `window_id` becomes a third key column when it arrives; nothing else changes       |
| Sidebar / room-list IA      | Undesigned anywhere; not a routing question                                        |
| Windows `titleBarOverlay`   | Needs a _right_ inset; only when that title bar style is adopted                   |
| Syncing tabs across devices | Tabs are arrangement, and "how it is arranged is local"                            |

## Questions to settle

- ~~**Room ID type** — UUID or ULID.~~ — **RESOLVED: UUIDv7** (`rooms.md` D11). Neither, in
  the end: RFC 9562's v7 gives ULID's ordering and index locality inside the native `uuid`
  type. 36 characters, so **`paths` gains no encoder** and the grammar is unchanged.
- **Account-level surfaces** — profile, notification preferences: modal, or a route every
  strip carries? (Hazard N4.)
- **Window bounds** — into `ui_state` under the same key, or shell-owned? Phase 11.
- **New tab on Cmd-click** — the browser does it natively; on desktop, does the strip honour
  the modifier the same way? Default yes.

## Candidates for ARCHITECTURE.md

To promote when that file is next edited in its own turn — not as a side effect of this work:

- **D1–D3 as the client's URL contract**, beside invariant 3: path is identity, IDs not
  slugs, org from the session, history-mode on every target.
- **D7 and D8 as an invariant-3 corollary** — the strip is scoped to what the session pins,
  and is never an access boundary.
- **D11 amends Phase 12.** "Exactly two things differ" between surfaces becomes four:
  persister, panel, tab strip, window chrome.
- **D10 into Appendix B** beside Cordis — no state-machine library on the client, same
  reasoning.
- **N5 into the Hazards Register** — `relay://` carries two kinds of link with different
  trust; they must never share a handler.
- **`deep links` under `apps/desktop/main/`** in the file tree currently has no design behind
  it. C's third step is that design.
