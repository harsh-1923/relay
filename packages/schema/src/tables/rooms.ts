import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { actors } from './actors';
import { createdAt, uuidPk } from './columns';
import { organizations } from './organizations';
import { workspaces } from './workspaces';

/**
 * Ours. The third tenancy level and the lowest auth boundary — access is decided at
 * workspace and room level only, and a room has membership rather than roles.
 *
 * `is_private` decides which of two read paths applies, and both are primary-key lookups so
 * the shape proxy never joins: a public room is readable by anyone in the workspace
 * (`workspace_memberships`), a private one only by its members (`room_members`). A public
 * room's `room_members` row therefore means *joined*, not *permitted* — it drives the
 * sidebar, ˀnot the grant. Workspace admins get no override; that would put a role check back
 * into the path this design exists to keep clear.
 *
 * `created_by` grants exactly one right: archiving. That is deliberately the smallest
 * privileged act — reversible, destroying nothing, needing no role table. Any member may add
 * another member. Archiving cascades: one transaction stamps `archived_at` here, on every
 * conversation in the room, and on every panel.
 *
 * `project_id` is nullable and nothing reads it. Projects group; they never gate.
 */
export const rooms = pgTable(
  'rooms',
  {
    id: uuidPk(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }), // denorm, invariant 2
    projectId: uuid('project_id'), // until projects ship; no FK, nothing reads it
    name: text('name').notNull(),
    isPrivate: boolean('is_private').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => actors.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // Slack's rule: a room is referred to by name, so two `#design` rooms in one workspace
    // make that reference ambiguous. Renames need no redirect — the URL is by id.
    uniqueIndex('rooms_workspace_name_key').on(t.workspaceId, sql`lower(${t.name})`),
  ],
);
