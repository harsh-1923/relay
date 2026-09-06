import { and, eq } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  actors,
  conversationMembers,
  organizationMemberships,
  organizations,
  roomMembers,
  workspaceMemberships,
  workspaces,
} from '@relay/schema';

/** A connection or a transaction — every helper here works inside a caller's transaction. */
type Db = PostgresJsDatabase<Record<string, unknown>> | PgTransaction<never, never, never>;

/**
 * Ours — everything below the org line. WorkOS has no concept of a workspace, so nothing
 * here is mirrored and nothing here arrives by webhook.
 */

/**
 * A URL-safe slug, unique per organization by the `workspaces_org_slug_key` constraint.
 * Falls back to `workspace` so a name of only punctuation still yields something addressable.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'workspace';
}

/** The org's default workspace, or null before one exists. */
export async function defaultWorkspace(d: Db, organizationId: string) {
  const [row] = await d
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.organizationId, organizationId), eq(workspaces.isDefault, true)))
    .limit(1);
  return row ?? null;
}

/**
 * Puts a user in the org's default workspace. Used on invitation acceptance, where the org
 * membership arrives by webhook and the workspace membership is ours to add.
 *
 * Silent when there is no default workspace: an org can exist without one for as long as it
 * takes signup to finish, and a webhook that raced it should not fail the delivery — WorkOS
 * would retry forever.
 */
export async function joinDefaultWorkspace(
  d: Db,
  userId: string,
  organizationId: string,
  role: 'admin' | 'member' = 'member',
): Promise<void> {
  const workspace = await defaultWorkspace(d, organizationId);
  if (!workspace) return;

  await d
    .insert(workspaceMemberships)
    .values({ workspaceId: workspace.id, userId, organizationId, role })
    .onConflictDoNothing();
}

/**
 * The workspace half of signup: the default workspace and its creator's membership.
 *
 * Takes the caller's transaction rather than opening one — a workspace with no members is
 * unreachable and there is no UI that could repair it, so the two inserts must share
 * whatever transaction the caller is already holding the signup lock in.
 */
export async function createDefaultWorkspace(
  d: Db,
  { organizationId, userId, name }: { organizationId: string; userId: string; name: string },
) {
  const [workspace] = await d
    .insert(workspaces)
    .values({ organizationId, name, slug: slugify(name), isDefault: true })
    .returning();

  await d
    .insert(workspaceMemberships)
    .values({ workspaceId: workspace!.id, userId, organizationId, role: 'admin' })
    .onConflictDoNothing();

  return workspace!;
}

/**
 * A slug free within the organization.
 *
 * `workspaces_org_slug_key` is unique per organization, and two workspaces called "Design" is
 * an ordinary thing to want rather than an error worth showing anyone — so the second becomes
 * `design-2`. Bounded, because a loop against a unique constraint is otherwise unbounded when
 * something else is wrong.
 */
async function freeSlug(d: Db, organizationId: string, name: string): Promise<string> {
  const base = slugify(name);
  const taken = await d
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId));
  const used = new Set(taken.map((r) => r.slug));
  if (!used.has(base)) return base;
  for (let n = 2; n <= 50; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * An additional workspace in an organization that already has one.
 *
 * The creator joins it as `admin`, which is the only membership it starts with: a workspace is
 * not visible to the rest of the organization by being created, it is visible to whoever is a
 * member. That is invariant 5 read literally — access is decided at workspace and room level,
 * never inherited from the tenant above.
 *
 * `is_default` stays false. Exactly one workspace per organization is the default — the one
 * signup made, and the one an invited member is dropped into.
 */
export async function createWorkspace(
  d: Db,
  { organizationId, userId, name }: { organizationId: string; userId: string; name: string },
) {
  return d.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        organizationId,
        name,
        slug: await freeSlug(tx, organizationId, name),
        isDefault: false,
      })
      .returning();

    await tx
      .insert(workspaceMemberships)
      .values({ workspaceId: workspace!.id, userId, organizationId, role: 'admin' })
      .onConflictDoNothing();

    return workspace!;
  });
}

/**
 * One workspace the user can open.
 *
 * `name`: the workspace's name — what the user sees, and still never the word "organization".
 * `organizationName`: only for disambiguating two workspaces that share a name across
 *   organizations. Not a label the UI leads with.
 * `workspaceId`: never null now that a row exists per workspace membership rather than per
 *   organization.
 * `roles`: organization roles, which decide who may invite or create — not who may open this,
 *   which the membership itself already answered.
 */
export interface SwitchTarget {
  organizationId: string;
  organizationName: string;
  name: string;
  workspaceId: string;
  isDefault: boolean;
  roles: string[];
}

/**
 * Every org this user can switch into, labelled by that org's default workspace.
 *
 * Read from the mirror rather than WorkOS: it is the same data, it is already local, and
 * this is on the path of a menu that opens often. `left join` because an org can briefly
 * exist without a workspace — a signup that died between the two, or an invitation whose
 * org we mirrored before its workspace was made.
 */
/**
 * Every workspace this user can open — one row per workspace, not per organization.
 *
 * Driven by `workspace_memberships`, because that is what access actually means below the
 * tenant: being in the organization is not being in the workspace (invariant 5). An
 * organization the user belongs to but has no workspace membership in contributes nothing,
 * which is correct — there is nothing there to open.
 *
 * The organization still rides along on every row. The client needs it to know whether
 * opening a workspace is a navigation or a session re-issue: switching *within* an
 * organization needs no re-auth, switching across one does.
 */
export async function switchTargets(d: Db, userId: string): Promise<SwitchTarget[]> {
  const rows = await d
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      isDefault: workspaces.isDefault,
      roles: organizationMemberships.roles,
    })
    .from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.userId, workspaceMemberships.userId),
        eq(organizationMemberships.organizationId, workspaces.organizationId),
      ),
    )
    .where(
      and(eq(workspaceMemberships.userId, userId), eq(organizationMemberships.status, 'active')),
    )
    .orderBy(organizations.name, workspaces.name);

  return rows.map((r) => ({
    organizationId: r.organizationId,
    organizationName: r.organizationName,
    name: r.workspaceName,
    workspaceId: r.workspaceId,
    isDefault: r.isDefault,
    roles: r.roles,
  }));
}

/**
 * Everything a departing member was granted, in one organization.
 *
 * Called when an organization membership is deleted. Their session dies with the membership,
 * so this is not what stops them reading — it is what stops the grants outliving the person,
 * which matters the day they are invited back and silently find themselves in rooms nobody
 * remembers adding them to.
 *
 * **The actor row is deliberately left behind.** Their messages reference it, and a departed
 * colleague's name should still render on what they wrote; deleting it would either fail
 * against `messages.author_id` or erase authorship. An actor with no memberships is inert.
 */
export async function revokeRoomGrants(
  d: Db,
  userId: string,
  organizationId: string,
): Promise<void> {
  const [actor] = await d
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.organizationId, organizationId), eq(actors.userId, userId)))
    .limit(1);

  if (actor) {
    await d
      .delete(roomMembers)
      .where(
        and(eq(roomMembers.actorId, actor.id), eq(roomMembers.organizationId, organizationId)),
      );
    await d
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.actorId, actor.id),
          eq(conversationMembers.organizationId, organizationId),
        ),
      );
  }

  await d
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.organizationId, organizationId),
      ),
    );
}

/** Whether the user actually belongs to the org they are asking to switch into. */
export async function isMemberOf(d: Db, userId: string, organizationId: string): Promise<boolean> {
  const [row] = await d
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.status, 'active'),
      ),
    )
    .limit(1);
  return !!row;
}
