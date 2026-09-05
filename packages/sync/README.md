# @relay/sync

TanStack DB collections over Electric shape logs, plus the client-side joins Electric
can't do (a shape covers one table).

Two things here are easy to add now and painful to retrofit:

- **`subscriptions.ts`** — the effect-with-inverse registry. Subscriptions for all active
  rooms stay open regardless of what is on screen, so switching rooms is a local query with
  no fetch and no spinner. Bound it two ways: how many stay live, and how much history each
  carries.
- **`persister.ts`** — the interface and offset contract. Get the derived/local-only split
  right here: derived data rebuilds on a `schemaVersion` bump, local-only data (drafts,
  unsent mutations, UI state) gets **real migrations and is never dropped**.

Shapes are scoped by room, never per user (invariant 1, H3).
