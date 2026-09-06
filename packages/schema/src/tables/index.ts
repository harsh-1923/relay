/**
 * Every table lives in this directory and is re-exported here.
 *
 * This barrel is what `drizzle.config.ts` reads and what the H7 guard audits, so a table
 * that is not exported here appears in neither the migrations nor the tenancy check.
 *
 * Still to come: connections (Phase 7), runs + run_events (Phase 5), claims (Phase 10).
 */

export * from './actors';
export * from './agents';
export * from './columns';
export * from './conversation-members';
export * from './conversations';
export * from './messages';
export * from './organization-memberships';
export * from './organizations';
export * from './panels';
export * from './room-members';
export * from './rooms';
export * from './users';
export * from './workspace-memberships';
export * from './workspaces';
