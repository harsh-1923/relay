import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt } from './columns';
import { organizations } from './organizations';
import { users } from './users';
import { workspaces } from './workspaces';

/**
 * Ours. WorkOS roles cannot express workspace-level roles — "admin of workspace A, member
 * of workspace B" is not representable in an org membership, and neither are workspace
 * invitations. Storing the role locally is fine at launch; FGA later replaces the
 * *evaluation*, not the storage. The trigger for that phase is guests.
 *
 * `organization_id` is denormalised on purpose (invariant 2). The shape proxy authorises on
 * every request and must never join to do it.
 *
 * `role` does carry a CHECK, unlike the mirror's `status`: we define these values, so
 * constraining them costs nothing and catches a typo at write time.
 */
export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    role: text('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    // Exactly the proxy's hot-path lookup: is this user in this workspace.
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check('workspace_memberships_role_check', sql`${t.role} in ('admin', 'member', 'guest')`),
    // The reverse: list a user's workspaces, for the switcher.
    index('workspace_memberships_user_idx').on(t.userId),
  ],
);
