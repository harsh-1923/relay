import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { actors } from './actors';
import { createdAt, uuidPk } from './columns';
import { conversations } from './conversations';
import { organizations } from './organizations';
import { workspaces } from './workspaces';

/**
 * Ours. The same split as `room_members`, one level down: for a **private** conversation
 * this is the read grant and the proxy's lookup; for a **shared** one it is who is
 * participating, and read access comes from the room instead.
 *
 * Shared conversations deliberately do not get a row per room member. Materialising them
 * would break "join a public room without permission" and amplify writes on every join.
 *
 * This is also what the "@someone who is not in this chat" system message reads.
 */
export const conversationMembers = pgTable(
  'conversation_members',
  {
    id: uuidPk(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    // Surrogate `id` beside the real identity, for the same reason as `room_members`.
    unique('conversation_members_conversation_actor_key').on(t.conversationId, t.actorId),
    index('conversation_members_actor_idx').on(t.actorId, t.workspaceId),
  ],
);
