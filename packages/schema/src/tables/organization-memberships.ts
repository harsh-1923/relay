import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * WorkOS mirror — read-only in application code. Org membership and org roles are WorkOS's
 * by design: RBAC is org-scoped there, a membership can carry multiple roles, and
 * permissions are their union.
 *
 * `status` and `roles` carry no CHECK constraint on purpose. WorkOS owns those vocabularies,
 * and a value they add later would start failing webhook ingestion on a table whose whole
 * job is to accept whatever upstream says. Constraining a mirror against a vocabulary you
 * do not control turns someone else's product change into your outage.
 */
export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: text('id').primaryKey(), // WorkOS om_...
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    roles: text('roles').array().notNull().default(['member']), // WorkOS role slugs
    status: text('status').notNull(), // active | inactive | pending
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('organization_memberships_user_org_key').on(t.userId, t.organizationId),
    // The unique index covers (user_id, …); this serves "who is in this org".
    index('organization_memberships_org_idx').on(t.organizationId),
  ],
);
