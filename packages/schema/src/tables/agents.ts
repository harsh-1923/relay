import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, uuidPk } from './columns';
import { actors } from './actors';
import { organizations } from './organizations';
import { workspaces } from './workspaces';

/**
 * Ours. An agent is a **resource, not a principal**: the agent service authenticates as a
 * service, and every write it makes is authorised by the `runs` row it references — which
 * carries `invoked_by`, `workspace_id` and `organization_id`. The credential is always the
 * invoking human's. Nothing here is ever the subject of an access check.
 *
 * Deliberately minimal. Phase 6 owns what an agent *is* — pi packages, prompt, declared
 * providers — and inventing that vocabulary before the harness is embedded would be
 * guessing. What exists here is what `actors` needs in order to name one.
 *
 * Workspace-scoped, unlike the humans beside it in `actors`: an agent is authored in a
 * workspace and adding it to a room in another one is refused at write time.
 */
export const agents = pgTable('agents', {
  id: uuidPk(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  createdBy: uuid('created_by')
    .notNull()
    .references((): AnyPgColumn => actors.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
});
