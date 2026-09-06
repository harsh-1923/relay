// createElectronSQLitePersistence({ database }) over better-sqlite3, wrapping
// @tanstack/db-sqlite-persistence-core. Separate package so the native module can never
// end up in a browser bundle — enforced by construction, not discipline. Phase 4.

export {};
