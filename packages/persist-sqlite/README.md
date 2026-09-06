# @relay/persist-sqlite

`createElectronSQLitePersistence({ database })` over `better-sqlite3`, wrapping
`@tanstack/db-sqlite-persistence-core`.

A **separate package specifically so the native module can never end up in a browser
bundle** — enforced by construction rather than discipline, and by a lint rule in the root
config as a second line.

The dominant cost here is native-module packaging against Electron's Node ABI per
architecture, not persistence logic. Sort it before it collides with Phase 11 signing.

Still test offset resume explicitly (H11). It is upstream's job now, but the failure mode
is silent: everything works, you just pay for a full re-read on every launch.
