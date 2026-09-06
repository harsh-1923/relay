import { and, eq } from 'drizzle-orm';

import { organizationMemberships } from '@relay/schema';

import { db, type DbEnv } from '../db';
import { isMemberOf } from '../tenancy';
import { workos, type Env as AuthEnv } from './session';

export type Env = AuthEnv & DbEnv;

/**
 * Invitations to a workspace.
 *
 * WorkOS has no concept below the organization, so every invitation is an org invitation and
 * the difference is what our webhook handler does on acceptance:
 *
 *   member / admin → the org's default workspace
 *   guest          → only the rooms they were invited to, and no workspace membership
 *
 * The role rides on the invitation itself, so acceptance carries it into
 * `organization_membership.created` and the handler branches without extra state.
 */

/** Roles an invitation may carry. `owner` is not among them — it is held by whoever created the org. */
export const INVITABLE_ROLES = ['admin', 'member', 'guest'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Who may invite. Read from the mirror, so it costs no network call. */
export async function canInvite(
  env: Env,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const d = db(env);
  if (!(await isMemberOf(d, userId, organizationId))) return false;

  const [row] = await d
    .select({ roles: organizationMemberships.roles })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.organizationId, organizationId),
      ),
    )
    .limit(1);

  return !!row?.roles.some((r) => r === 'owner' || r === 'admin');
}

export interface SentInvitation {
  id: string;
  email: string;
  role: string | null;
  expiresAt: string;
}

export async function sendInvitation(
  env: Env,
  {
    email,
    organizationId,
    inviterUserId,
    role,
  }: { email: string; organizationId: string; inviterUserId: string; role: InvitableRole },
): Promise<SentInvitation> {
  const inv = await workos(env).userManagement.sendInvitation({
    email,
    organizationId,
    inviterUserId,
    roleSlug: role,
  });
  return {
    id: inv.id,
    email: inv.email,
    role,
    expiresAt: String(inv.expiresAt),
  };
}

/** Outstanding invitations for an org, so the UI can show who is expected. */
export async function pendingInvitations(env: Env, organizationId: string) {
  const { data } = await workos(env).userManagement.listInvitations({ organizationId, limit: 50 });
  return data
    .filter((i) => i.state === 'pending')
    .map((i) => ({ id: i.id, email: i.email, expiresAt: String(i.expiresAt) }));
}

export async function revokeInvitation(env: Env, id: string): Promise<void> {
  await workos(env).userManagement.revokeInvitation(id);
}
