import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { actors } from './actors';
import { conversations } from './conversations';
import { createdAt, uuidPk } from './columns';
import { organizations } from './organizations';
import { workspaces } from './workspaces';

/**
 * Ours, and the highest-volume table in the product.
 *
 * **No `room_id`, deliberately.** Invariant 2 wants `organization_id` and `workspace_id`, not
 * `room_id`, and adding one would be the expensive kind of harmless: promoting a private
 * thread into a room would rewrite every message row — O(N) synced writes and every
 * subscriber's cache invalidated for a change that moved nothing. Placement lives on the
 * conversation, so a promotion touches two rows and no message at all. `workspace_id` stays
 * correct because a conversation never crosses workspaces.
 *
 * `body` is a versioned block list rather than a string, because "extensible" in practice
 * means approval cards, run references and attachments — not conventions grown into prose.
 * Invariant 13 still applies to it: labels here, payloads in object storage. A block holding
 * an agent's tool output is that invariant broken on the busiest table there is.
 *
 * **A running agent's message is a reference to a run**, not a row being updated. The trace
 * renders from `run_events`, batched at ~1s. Streaming tokens into `body` would be H4
 * exactly: twelve updates costing what twelve inserts cost.
 *
 * `search_text` is a flat projection of `body` for the server's `tsvector`. Clients derive
 * their own from the blocks, so it is excluded from every shape.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuidPk(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    authorId: uuid('author_id').references(() => actors.id, { onDelete: 'restrict' }),
    parentMessageId: uuid('parent_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'cascade',
    }),
    runId: uuid('run_id'), // Phase 5; no FK until `runs` exists
    kind: text('kind').notNull().default('message'), // message | system
    body: jsonb('body').notNull(),
    searchText: text('search_text').notNull().default(''),
    createdAt: createdAt(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('messages_kind_check', sql`${t.kind} in ('message', 'system')`),
    // Only a system message may be unattributed — "Priya is not in this chat" had no author.
    check('messages_author_check', sql`${t.kind} <> 'message' or ${t.authorId} is not null`),
    // v7 ids sort chronologically, so this serves reads, keyset paging and the sync floor.
    index('messages_conversation_idx').on(t.conversationId, t.id.desc()),
    index('messages_thread_idx')
      .on(t.parentMessageId)
      .where(sql`${t.parentMessageId} is not null`),
  ],
);
