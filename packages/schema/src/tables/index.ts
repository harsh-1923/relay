/**
 * Every table lives in this directory and is re-exported here.
 *
 * This barrel is what `drizzle.config.ts` reads and what the H7 guard audits, so a table
 * that is not exported here appears in neither the migrations nor the tenancy check.
 *
 * Still to come: rooms, room_members (Phase 0), agents, connections (Phase 0),
 * messages (Phase 3), runs + run_events (Phase 5), claims (Phase 10).
 */

export * from './columns';
export * from './organization-memberships';
export * from './organizations';
export * from './users';
export * from './workspace-memberships';
export * from './workspaces';
