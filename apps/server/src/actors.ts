import { and, eq, isNull } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { actors, organizationMemberships, users } from '@relay/schema';

/**
 * Ours. An actor is the one addressable thing in an organization — a person or an agent —
 * and it is what every room membership, message author and panel creator points at.
 *
 * `display_name` and `avatar_url` are a projection of the WorkOS mirror, written only
 * alongside it. Invariant 4 forbids application code writing mirrored rows; it does not
 * forbid the mirror's own writer keeping a projection beside them. Everything here is
 * therefore called from signup and the webhook, and from nowhere else.
 */

type Db = PostgresJsDatabase<Record<string, unknown>> | PgTransaction<never, never, never>;

/**
 * What to call someone before they have set anything.
 *
 * The email local part is a poor name but a better one than an empty string, and it is what
 * the user sees until the mirror carries a real one — WorkOS has no name at all until a
 * profile is completed or an IdP supplies it.
 */
export function displayNameFor(u: {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.email.split('@')[0] || u.email;
}

/**
 * The actor row for a person in an organization, created if it is missing.
 *
 * Self-healing on purpose, in the same spirit as the webhook's `ensureParents`: an actor can
 * be absent because the org predates this table, because an event was dropped, or because a
 * membership arrived before its user did. A caller that needs one should get one rather than
 * fail, since the alternative is a real account that cannot be added to any room (R6).
 *
 * Idempotent — a second signup request, a webhook retry and a backfill all converge on the
 * same row.
 */
export async function ensureActor(
  d: Db,
  { userId, organizationId }: { userId: string; organizationId: string },
): Promise<string> {
  const [existing] = await d
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.organizationId, organizationId), eq(actors.userId, userId)))
    .limit(1);
  if (existing) return existing.id;

  const [user] = await d
    .select({ firstName: users.firstName, lastName: users.lastName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new Error(`ensureActor: no mirrored user ${userId}`);

  const [row] = await d
    .insert(actors)
    .values({
      organizationId,
      kind: 'human',
      userId,
      displayName: displayNameFor(user),
    })
    .onConflictDoNothing()
    .returning({ id: actors.id });

  // A concurrent caller won the unique constraint; theirs is as good as ours.
  if (row) return row.id;
  const [raced] = await d
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.organizationId, organizationId), eq(actors.userId, userId)))
    .limit(1);
  return raced!.id;
}

/**
 * Push a changed profile out to every organization the person belongs to.
 *
 * One row per (person, organization), so a rename fans out. Called from `user.updated` only,
 * which is the same handler that writes the mirror row these values are projected from.
 */
export async function syncActorProfile(
  d: Db,
  u: { id: string; firstName?: string | null; lastName?: string | null; email: string },
): Promise<void> {
  await d
    .update(actors)
    .set({ displayName: displayNameFor(u) })
    .where(eq(actors.userId, u.id));
}

/**
 * Re-derive every actor's `display_name` from the mirror it projects.
 *
 * The counterpart to `backfillActors`: that one repairs a *missing* row, this one repairs a
 * *stale* one. A projection can drift in ways its writer never sees — a `user.updated` that
 * was dropped, a restore from an older dump, or someone editing the column directly in a
 * table editor — and nothing else notices, because the value is only ever written on an
 * event that has already passed.
 *
 * Scoped to one organization when given one, for the same reason as `backfillActors`.
 * Returns the rows it actually changed.
 */
export async function reconcileActorProfiles(d: Db, organizationId?: string): Promise<number> {
  const rows = await d
    .select({
      actorId: actors.id,
      displayName: actors.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(actors)
    .innerJoin(users, eq(users.id, actors.userId))
    .where(organizationId ? eq(actors.organizationId, organizationId) : undefined);

  let changed = 0;
  for (const r of rows) {
    const correct = displayNameFor(r);
    if (r.displayName === correct) continue;
    await d.update(actors).set({ displayName: correct }).where(eq(actors.id, r.actorId));
    changed++;
  }
  return changed;
}

/**
 * Actors for every active organization membership that lacks one.
 *
 * A one-off for organizations created before this table existed, and harmless to re-run.
 * `ensureActor` makes it unnecessary on any path that actually needs an actor, so this is
 * for making a member list right rather than for repairing a broken write.
 *
 * Scoped to one organization when given one, which is how it should be run in anger: a
 * whole-database backfill is a single batched insert, and one row that fails a foreign key
 * — a user deleted since the read — takes every other row down with it.
 *
 * Returns rows actually written, not rows found missing. Those differ exactly when something
 * changed underneath, which is the case worth knowing about.
 */
export async function backfillActors(d: Db, organizationId?: string): Promise<number> {
  const missing = await d
    .select({
      userId: organizationMemberships.userId,
      organizationId: organizationMemberships.organizationId,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .leftJoin(
      actors,
      and(
        eq(actors.organizationId, organizationMemberships.organizationId),
        eq(actors.userId, organizationMemberships.userId),
      ),
    )
    .where(
      and(
        eq(organizationMemberships.status, 'active'),
        isNull(actors.id),
        ...(organizationId ? [eq(organizationMemberships.organizationId, organizationId)] : []),
      ),
    );

  if (!missing.length) return 0;

  const written = await d
    .insert(actors)
    .values(
      missing.map((m) => ({
        organizationId: m.organizationId,
        kind: 'human' as const,
        userId: m.userId,
        displayName: displayNameFor(m),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: actors.id });

  return written.length;
}

/**
 * The actor behind a session.
 *
 * The session is `{user_id, organization_id}` (invariant 3), and everything below the org
 * line is keyed by actor — so this is the one hop between them. A primary-key lookup on the
 * `actors_org_user_key` constraint, because it sits in front of every authorisation check.
 */
export async function actorFor(
  d: Db,
  { userId, organizationId }: { userId: string; organizationId: string },
): Promise<string | null> {
  const [row] = await d
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.organizationId, organizationId), eq(actors.userId, userId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * An agent's actor. Created with the agent, in the same transaction, for the same reason a
 * workspace is created with its first membership: an agent nobody can address is unreachable
 * and there is no UI that would repair it.
 */
export async function createAgentActor(
  d: Db,
  { agentId, organizationId, name }: { agentId: string; organizationId: string; name: string },
): Promise<string> {
  const [row] = await d
    .insert(actors)
    .values({ organizationId, kind: 'agent', agentId, displayName: name })
    .returning({ id: actors.id });
  return row!.id;
}
