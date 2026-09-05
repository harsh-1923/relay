import { and, eq } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  organizationMemberships,
  organizations,
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

/** `name`: what the user sees. The UI never says "organization". */
export interface SwitchTarget {
  organizationId: string;
  name: string;
  workspaceId: string | null;
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
export async function switchTargets(d: Db, userId: string): Promise<SwitchTarget[]> {
  const rows = await d
    .select({
      organizationId: organizations.id,
      orgName: organizations.name,
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      roles: organizationMemberships.roles,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .leftJoin(
      workspaces,
      and(eq(workspaces.organizationId, organizations.id), eq(workspaces.isDefault, true)),
    )
    .where(
      and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.status, 'active')),
    );

  return rows.map((r) => ({
    organizationId: r.organizationId,
    name: r.workspaceName ?? r.orgName,
    workspaceId: r.workspaceId,
    roles: r.roles,
  }));
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
