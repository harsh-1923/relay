import { pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from './columns';

/**
 * WorkOS mirror — read-only in application code. SSO, domains and Directory Sync attach
 * here, which is what forces WorkOS Organization to map to ours: an enterprise wants one
 * Okta connection company-wide, not one per workspace.
 *
 * The tenant root. Nothing above it, so it carries no `organization_id` of its own.
 */
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(), // WorkOS org_...
  name: text('name').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
