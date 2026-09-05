import { sql } from 'drizzle-orm';

import { db, type DbEnv } from '../db';
import { applyMembership, applyOrganization } from '../mirror';
import { createDefaultWorkspace, defaultWorkspace } from '../tenancy';
import { workos, type Env as AuthEnv } from './session';

export type Env = AuthEnv & DbEnv;

/**
 * The single signup path — solo, startup and enterprise alike. One code path, no branch.
 *
 *   org → org membership (owner) → default workspace → workspace membership (admin)
 *
 * The org and its default workspace share a name, and the UI only ever says "workspace".
 * Slack hides the org level until Enterprise Grid; so do we. Both rows always exist, so the
 * level can be revealed later without a migration.
 *
 * No room. The doc's sketch ends with one called "general"; the room schema is still moving,
 * and adding an insert here later is cheaper than guessing it now.
 */
export async function createOrganizationForUser(
  env: Env,
  { userId, name }: { userId: string; name: string },
) {
  const um = workos(env).userManagement;
  const d = db(env);

  /**
   * Serialise signup per user before touching WorkOS.
   *
   * A double-clicked button or a client retry sends two requests, and creating an
   * organization is not idempotent: the SDK's `idempotencyKey` only guards its *own*
   * internal retry of a single call — verified against the live API, where two requests
   * carrying the same `Idempotency-Key` produced two organizations. So the second request
   * waits here, then finds the membership the first one made and reuses its workspace.
   *
   * The lock is held across a network call, which is normally worth avoiding. Here it is
   * bounded by signup happening once per user and the alternative being a duplicate
   * organization, which nothing in the product can merge.
   */
  return d.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signup:${userId}`}))`);

    // Whoever held the lock first may already have done this.
    const existing = await um.listOrganizationMemberships({ userId, limit: 1 });
    const already = existing.data[0];
    if (already) {
      const workspace = await defaultWorkspace(tx, already.organizationId);
      if (workspace) {
        const organization = await workos(env).organizations.getOrganization(
          already.organizationId,
        );
        return { organization, workspace };
      }
      // Membership without a workspace: a previous attempt died mid-flight. Finish it.
      const organization = await workos(env).organizations.getOrganization(already.organizationId);
      return {
        organization,
        workspace: await createDefaultWorkspace(tx, {
          organizationId: organization.id,
          userId,
          name: organization.name,
        }),
      };
    }

    const organization = await workos(env).organizations.createOrganization({ name });
    const membership = await um.createOrganizationMembership({
      userId,
      organizationId: organization.id,
      roleSlug: 'owner',
    });

    /**
     * Mirror both from the API response rather than waiting for the webhook.
     * `workspaces.organization_id` is a foreign key into a webhook-populated table, and the
     * webhook arrives seconds later — or, locally without a tunnel, never. Same upsert the
     * webhook uses, so when it does arrive it changes nothing.
     */
    await applyOrganization(tx, organization);
    await applyMembership(tx, {
      id: membership.id,
      userId,
      organizationId: organization.id,
      status: membership.status,
      // What WorkOS actually assigned, not what we asked for — the environment's default
      // applies if `owner` does not exist, and the mirror should say which.
      role: { slug: membership.role?.slug ?? 'owner' },
    });

    return {
      organization,
      workspace: await createDefaultWorkspace(tx, {
        organizationId: organization.id,
        userId,
        name,
      }),
    };
  });
}
