import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { check, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents';
import { createdAt, uuidPk } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Ours. The one addressable construct: everywhere the product points at somebody — a member
 * list, a message author, a mention, "who opened this panel" — it points here, whether that
 * somebody is a person or an agent. The alternative is a `(user_id, agent_id)` pair repeated
 * across six tables, with every query that renders a name branching on which one is set.
 *
 * Being addressable is not being authorised. An agent's `room_members` row puts it in the
 * member list and makes it invokable there; it is never the subject of a read check, and the
 * shape proxy only ever authorises humans. Making `actor_id` an authorization subject would
 * hand agents ambient access to rooms they were never invoked in.
 *
 * `display_name` and `avatar_url` are a **projection, not a second source of truth**: for a
 * human the `user.created` / `user.updated` webhook writes them alongside the `users` mirror
 * it already maintains, and application code never touches them. Invariant 4 forbids
 * application writes to mirrored rows; it does not forbid the mirror's own writer keeping a
 * projection. The projection is what lets this be the only table a client needs in order to
 * render anybody — `users` never has to sync, which matters because it has no
 * `organization_id` and an Electric shape covers one table.
 *
 * Org-scoped, not workspace-scoped: a human belongs to the org, a guest has an org
 * membership and no workspace membership, and one actor row per person per workspace would
 * fragment authorship. It therefore carries no `workspace_id` and is exempted in
 * `tenancy.ts`.
 *
 * **An actor outlives what it points at.** Both references are `set null`, and the two
 * checks are one-directional rather than biconditional, so a deleted user or agent leaves a
 * tombstone: `kind` intact, `display_name` intact, references gone. That is deliberate on
 * two counts. `messages.author_id` is `restrict`, so an actor that could be deleted could
 * not have written anything — and `user.deleted` is a WorkOS webhook, so a foreign key that
 * refuses it makes WorkOS retry a delivery that can never succeed. A departed colleague's
 * name still renders on what they wrote, which is what Slack does and what people expect.
 */
export const actors = pgTable(
  'actors',
  {
    id: uuidPk(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(), // human | agent
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    createdAt: createdAt(),
  },
  (t) => [
    check('actors_kind_check', sql`${t.kind} in ('human', 'agent')`),
    // One-directional: a reference implies its kind, but a kind does not require the
    // reference — that is what lets a tombstone exist. A human actor pointing at an agent
    // is still refused, which is the confusion these guard against.
    check('actors_human_check', sql`${t.userId} is null or ${t.kind} = 'human'`),
    check('actors_agent_check', sql`${t.agentId} is null or ${t.kind} = 'agent'`),
    // Nulls do not collide in a unique constraint, so agent rows are unaffected by the first.
    unique('actors_org_user_key').on(t.organizationId, t.userId),
    unique('actors_agent_key').on(t.agentId),
  ],
);
