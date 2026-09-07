// The local database, its connector, and the TanStack DB collections over it.
//
// `platform` stays a separate entry point: it is imported by code that runs before any of
// this exists, and pulling the sync engine in behind it would defeat that.

export * from './collections';
export * from './database';
export * from './schema';
