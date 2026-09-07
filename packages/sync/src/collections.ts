import { createCollection } from '@tanstack/db';
import { powerSyncCollectionOptions } from '@tanstack/powersync-db-collection';

import { AppSchema, rowSchemas } from './schema';
import type { Database } from './database';

/**
 * TanStack DB collections over the local SQLite database.
 *
 * **One collection per table**, which is the shape that replaces Electric's factory-and-cache.
 * There, a shape was a query — `messages` for one conversation was a different shape, and so a
 * different collection, from `messages` for another — which is why that module had to mint and
 * cache instances per parameterisation and why a registry existed to own their lifetimes.
 *
 * Here a table is just a table. Filtering is a live query, the set of collections is fixed and
 * known at module load, and the registry, the cache and the retain/release discipline all go
 * away with it.
 *
 * **`syncMode: 'eager'`, not `'on-demand'`.** The two decide how much of the local database is
 * also held in memory — sync streams already put every room the actor belongs to on disk
 * whether or not it is on screen (requirement 5), and this is downstream of that. On-demand
 * hydrates only rows matching an active live query, which is the better answer in principle.
 *
 * It is not usable yet: `runOnDemandSync` calls `database.logger.error`, and `@powersync/web`
 * 2.3 exposes no such method, so every collection threw `database.logger.error is not a
 * function` on mount and the live query reported `Initial subset load failed`. Same version
 * skew as the `columnMap` problem the Zod schemas work around (P1).
 *
 * Eager is a real cost — every message in every joined room sits in the JS heap — and it is
 * also what cross-room features want anyway: unread badges and notifications span all rooms,
 * and those live queries would hydrate everything regardless. Revisit when the alpha settles.
 *
 * Writes go straight through to SQLite and ride PowerSync's own upload queue, so there is no
 * second optimistic layer to reconcile — `insert()` here is the same write the connector later
 * uploads.
 */
export function createCollections(db: Database) {
  /**
   * Each table is passed with its Zod schema, which is what fixes the row types — see
   * `rowSchemas`. Without it every column resolves to nothing and a live query can only see
   * `id`, because the alpha collection package reads a `columnMap` shape this version of
   * `@powersync/common` does not expose.
   */
  const opts = { database: db, syncMode: 'on-demand' } as const;
  const onDeserializationError = (error: unknown) => {
    /**
     * Fatal by their own documentation: a row that fails validation is dropped, so the
     * collection quietly disagrees with SQLite. It is logged rather than thrown because
     * taking the app down mid-sync would be worse than one missing row, and the log is what
     * says which column drifted.
     */
    console.error('[relay:sync] a synced row failed validation:', error);
  };

  return {
    actors: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.actors,
        schema: rowSchemas.actors,
        onDeserializationError,
      }),
    ),
    rooms: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.rooms,
        schema: rowSchemas.rooms,
        onDeserializationError,
      }),
    ),
    roomMembers: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.room_members,
        schema: rowSchemas.room_members,
        onDeserializationError,
      }),
    ),
    conversations: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.conversations,
        schema: rowSchemas.conversations,
        onDeserializationError,
      }),
    ),
    conversationMembers: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.conversation_members,
        schema: rowSchemas.conversation_members,
        onDeserializationError,
      }),
    ),
    messages: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.messages,
        schema: rowSchemas.messages,
        onDeserializationError,
      }),
    ),
    panels: createCollection(
      powerSyncCollectionOptions({
        ...opts,
        table: AppSchema.props.panels,
        schema: rowSchemas.panels,
        onDeserializationError,
      }),
    ),
  };
}

export type Collections = ReturnType<typeof createCollections>;
