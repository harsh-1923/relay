import { boolean, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt } from './columns';
import { organizations } from './organizations';

/**
 * Ours. WorkOS has no such concept.
 *
 * This table exists from day one even though the UI never shows the level, and that is the
 * whole Slack lesson: they shipped workspaces first, routed every query to a shard keyed by
 * the workspace ID in the session token, then retrofitted "org" as a parent for Enterprise
 * Grid — and re-architected again for Unified Grid. Two re-architectures, because a
 * hierarchy level was added after data existed.
 *
 * Adding an auth boundary later is expensive: every existing row needs a correct access
 * decision and there is no safe default. That asymmetry is why this table exists now and
 * `projects` does not.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique('workspaces_org_slug_key').on(t.organizationId, t.slug)],
);
