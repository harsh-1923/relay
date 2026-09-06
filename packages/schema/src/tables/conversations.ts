import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { actors } from './actors';
import { createdAt, uuidPk } from './columns';
import { organizations } from './organizations';
import { rooms } from './rooms';
import { workspaces } from './workspaces';

/**
 * Ours, and the reason chat is not owned by a room. A conversation can be a room's central
 * shared chat, a private chat inside a panel, or a direct message, and it **moves between
 * those places** — a private research thread is promoted into the room by changing one
 * column, not by rewriting a single message.
 *
 * It is also the sync and auth unit for messages. Everyone in a shared conversation
 * subscribes to the same shape and shares the same cache entry, so scoping by conversation
 * protects CDN hit rate exactly as scoping by room does — while making privacy structural:
 * a private conversation is a *different shape* that non-members never request, rather than
 * rows a filter has to remember to exclude.
 *
 * One table covers channels, panel chats and DMs because Slack shipped those as separate
 * constructs and spent 2017 converging them. Their mistake was `is_im` — a boolean
 * conflating type with visibility. `kind` says what this *is* and never changes;
 * `visibility` says who may read it and is the only thing a promotion touches.
 *
 * `sync_floor` is read by nothing here. It bounds the message shape, because an Electric
 * where clause cannot call `now()` and has no LIMIT — see `docs/plans/local-first.md` D3.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuidPk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(), // main | panel | direct
    visibility: text('visibility').notNull(), // shared | private
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    syncFloor: uuid('sync_floor'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check('conversations_kind_check', sql`${t.kind} in ('main', 'panel', 'direct')`),
    check('conversations_visibility_check', sql`${t.visibility} in ('shared', 'private')`),
    check('conversations_direct_check', sql`(${t.kind} = 'direct') = (${t.roomId} is null)`),
    check(
      'conversations_main_shared_check',
      sql`${t.kind} <> 'main' or ${t.visibility} = 'shared'`,
    ),
    check(
      'conversations_direct_private_check',
      sql`${t.kind} <> 'direct' or ${t.visibility} = 'private'`,
    ),
    // A room has exactly one central shared chat. A partial unique index says that and
    // cannot drift the way an `is_default` boolean would.
    uniqueIndex('conversations_room_main_key')
      .on(t.roomId)
      .where(sql`${t.kind} = 'main'`),
  ],
);
