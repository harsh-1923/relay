/**
 * Single source of truth (invariant 14) — consumed by client, server and broker alike.
 * The runtime imports types only; it holds no database credential.
 *
 * tables/ Drizzle definitions, from which the migrations are generated
 * shapes/ shape defs — SERVER-SIDE ONLY
 * events/ run_event kinds and label types
 * validators/ drizzle-zod schemas, used by the write endpoint AND the client
 */

export * from './tables/index';
export * from './tenancy';
