import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { actors } from './actors';
import { conversations } from './conversations';
import { createdAt, uuidPk } from './columns';
import { organizations } from './organizations';
import { rooms } from './rooms';
import { workspaces } from './workspaces';

/**
 * Ours. The surfaces tabbed beside a room's chat — a browser pane, a chat with an agent,
 * and later a sandbox preview, a terminal, a doc. `kind` plus a `config` jsonb takes those
 * without a migration each time.
 *
 * `created_by` is an actor, which is what makes "an agent opened a panel" and "a person
 * opened a panel" the same row.
 *
 * **Visibility is mirrored from the conversation for a chat panel, which is the one pair of
 * columns here that must never disagree.** The mirror is load-bearing rather than lazy: the
 * panels shape filters on visibility, and per invariant 2 the proxy cannot join to
 * `conversations` to find it — the same justification as the denormalised `organization_id`.
 * Promotion writes both in one transaction, and a promoted chat stays a panel: a room has
 * exactly one central shared chat.
 *
 * What is open syncs; how it is arranged does not. Pane sizes, split direction, focus and
 * the dismissal of an agent's "opened X" banner are per user, per device, and live in
 * `packages/sync/src/local/`.
 */
export const panels = pgTable(
  'panels',
  {
    id: uuidPk(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(), // browser | chat
    visibility: text('visibility').notNull().default('shared'), // mirrors the conversation when chat
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    config: jsonb('config').notNull().default({}), // kind-specific: { url } for browser
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('panels_kind_check', sql`${t.kind} in ('browser', 'chat')`),
    check('panels_visibility_check', sql`${t.visibility} in ('shared', 'private')`),
    check(
      'panels_chat_conversation_check',
      sql`(${t.kind} = 'chat') = (${t.conversationId} is not null)`,
    ),
    index('panels_room_idx').on(t.roomId, t.visibility),
  ],
);
