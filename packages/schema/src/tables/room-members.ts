import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { actors } from './actors';
import { createdAt, uuidPk } from './columns';
import { organizations } from './organizations';
import { rooms } from './rooms';
import { workspaces } from './workspaces';

/**
 * Ours. Who is in a room — people and agents alike, which is why it keys on `actor_id` and
 * not `user_id`.
 *
 * It means two things depending on the room, and the difference matters. In a **private**
 * room it is the read grant, and the proxy's primary-key lookup. In a **public** room it is
 * participation only: anyone in the workspace may read without a row here.
 *
 * An agent's row makes it **invokable** in this room — checked where runs are enqueued, not
 * where shapes are served. So removing an agent from a room stops future invocations without
 * touching a credential, and the row still grants no read access of its own.
 */
export const roomMembers = pgTable(
  'room_members',
  {
    id: uuidPk(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }), // denorm, invariant 2
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }), // denorm
    addedBy: uuid('added_by').references(() => actors.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    /**
     * `(room_id, actor_id)` was the primary key and is now a unique constraint beside a
     * surrogate `id`. The pair is still the real identity and still one indexed lookup — a
     * unique constraint builds the same index a composite primary key did — so the hot path
     * is unchanged.
     *
     * The surrogate exists because the sync engine addresses every synced row by a single
     * column named `id`. A join table with no such column cannot be synced at all, and this
     * table has to be: it is what renders a room's member list.
     */
    unique('room_members_room_actor_key').on(t.roomId, t.actorId),
    // The reverse: this actor's rooms — the membership directory, and a real synced shape.
    index('room_members_actor_idx').on(t.actorId, t.workspaceId),
  ],
);
