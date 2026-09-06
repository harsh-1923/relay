import { ensureActor, syncActorProfile } from '../actors';
import { workos, type Env as AuthEnv } from '../auth/session';
import { db, type DbEnv } from '../db';
import {
  applyMembership,
  applyOrganization,
  applyUser,
  deleteMembership,
  deleteOrganization,
  deleteUser,
  type MirrorMembership,
  type MirrorOrganization,
  type MirrorUser,
} from '../mirror';
import { joinDefaultWorkspace, revokeRoomGrants } from '../tenancy';
import { eq } from 'drizzle-orm';
import { organizationMemberships, organizations, users } from '@relay/schema';

export type Env = AuthEnv & DbEnv & { WORKOS_WEBHOOK_SECRET: string };

interface WorkosEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * WorkOS is upstream, Postgres is a read replica (invariant 4). A direct write from
 * application code is silently overwritten by the next event, so the mirror is only ever as
 * correct as this handler.
 */
export async function handleWorkosWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get('workos-signature');
  if (!signature) return new Response('Missing signature', { status: 400 });

  const payload = await request.text();

  let event: WorkosEvent;
  try {
    event = (await workos(env).webhooks.constructEvent({
      payload: JSON.parse(payload) as Record<string, unknown>,
      sigHeader: signature,
      secret: env.WORKOS_WEBHOOK_SECRET,
    })) as unknown as WorkosEvent;
  } catch {
    // Never say why. A verification oracle is a gift to whoever is probing.
    return new Response('Invalid signature', { status: 401 });
  }

  await applyEvent(event, env);

  // 200 even for events we ignore — anything else makes WorkOS retry forever.
  return new Response(null, { status: 200 });
}

/**
 * `constructEvent` deserialises the payload, so fields arrive **camelCase** — `firstName`,
 * not `first_name`. Observed directly from a delivered `user.updated`:
 *
 *   ["object","id","email","emailVerified","name","firstName","profilePictureUrl",
 *    "lastName","lastSignInAt","locale","createdAt","updatedAt","externalId","metadata"]
 *
 * The first version of this file read snake_case and silently wrote nulls for every name.
 * The tests passed, because they asserted the same wrong shape. Only real delivery caught
 * it — which is why the fixtures are the observed payload, not an invented one.
 */
/**
 * A membership references a user and an organization by foreign key, and either may be
 * missing: the entity predates our webhook, its event was dropped, or delivery arrived out
 * of order — all of which WorkOS's at-least-once, unordered delivery permits.
 *
 * Without this the insert violates the constraint, the handler throws, and WorkOS retries a
 * delivery that can never succeed. Found exactly that way: an organization created before
 * this endpoint existed made every membership event for it fail forever, silently.
 *
 * Fetching the parent on demand makes the mirror self-healing rather than dependent on
 * having seen every prior event.
 */
async function ensureParents(
  d: ReturnType<typeof db>,
  env: Env,
  m: MirrorMembership,
): Promise<void> {
  const [org] = await d
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, m.organizationId))
    .limit(1);
  if (!org) {
    await applyOrganization(d, await workos(env).organizations.getOrganization(m.organizationId));
  }

  const [user] = await d
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, m.userId))
    .limit(1);
  if (!user) {
    await applyUser(d, await workos(env).userManagement.getUser(m.userId));
  }
}

export async function applyEvent(event: WorkosEvent, env: Env): Promise<void> {
  const d = db(env);

  switch (event.event) {
    case 'user.created':
    case 'user.updated': {
      const u = event.data as unknown as MirrorUser;
      await applyUser(d, u);
      /**
       * `actors.display_name` is a projection of this mirror row, so it is maintained by the
       * mirror's own writer and by nothing else. A rename in WorkOS fans out to every
       * organization the person belongs to — one actor row each.
       */
      await syncActorProfile(d, u);
      return;
    }

    case 'user.deleted': {
      const id = (event.data as { id: string }).id;
      /**
       * Clear what hangs off the user before removing it. `organization_memberships.user_id`
       * is `restrict`, so a user who still has one cannot be deleted — and delivery is
       * unordered and at-least-once, so "the membership event comes first" is an assumption
       * WorkOS does not owe us. Without this the delete throws, we answer non-200, and WorkOS
       * retries a delivery that can never succeed. Same failure the membership handler's
       * `ensureParents` exists to prevent, from the other direction.
       *
       * The actor is not deleted, only its `user_id` cleared by the foreign key — a tombstone
       * that keeps a departed person's name on the messages they wrote.
       */
      const memberships = await d
        .select({ organizationId: organizationMemberships.organizationId })
        .from(organizationMemberships)
        .where(eq(organizationMemberships.userId, id));
      for (const m of memberships) await revokeRoomGrants(d, id, m.organizationId);
      await d.delete(organizationMemberships).where(eq(organizationMemberships.userId, id));
      await deleteUser(d, id);
      return;
    }

    case 'organization.created':
    case 'organization.updated':
      return applyOrganization(d, event.data as unknown as MirrorOrganization);

    case 'organization.deleted':
      await deleteOrganization(d, (event.data as { id: string }).id);
      return;

    case 'organization_membership.created':
    case 'organization_membership.updated': {
      const m = event.data as unknown as MirrorMembership;
      await ensureParents(d, env, m);
      await applyMembership(d, m);

      /**
       * Acceptance of an invitation surfaces here and nowhere else — it happens in WorkOS's
       * UI, so there is no request of ours to hook. Which arm runs is decided by the role:
       *
       *   member / admin → the org's default workspace
       *   guest          → only the rooms they were invited to, and no workspace membership
       *
       * The guest arm is deliberately a no-op for now. Rooms do not exist yet, and neither
       * does the pending-invite row that would say *which* rooms. The branch is here because
       * retrofitting it means revisiting the one piece of code that cannot be exercised
       * locally without a tunnel.
       */
      /**
       * Only an *active* membership grants anything. WorkOS creates the membership the
       * moment an invitation is sent, with status `pending`, and flips it to `active` on
       * acceptance — so joining on creation alone hands workspace access to everyone who has
       * merely been emailed. Found exactly that way: a revoked probe invitation still held a
       * workspace_memberships row.
       *
       * Checked on both created and updated, because acceptance may arrive as either.
       */
      if (m.status === 'active') {
        /**
         * The actor comes before the workspace membership and applies to guests too — a
         * guest is addressable, appears in a member list and authors messages exactly like
         * anyone else. What a guest does not get is the workspace membership below.
         */
        await ensureActor(d, { userId: m.userId, organizationId: m.organizationId });

        const role = m.role?.slug ?? 'member';
        if (role !== 'guest') await joinDefaultWorkspace(d, m.userId, m.organizationId);
      }
      return;
    }

    case 'organization_membership.deleted': {
      const id = (event.data as { id: string }).id;
      /**
       * Read the membership before deleting it, because room and workspace grants are keyed
       * by the user and organization it names and there is no other way back to them.
       *
       * The **actor row stays**. Their messages reference it, and a departed colleague's name
       * should still render on what they wrote — deleting it would either fail against
       * `messages.author_id` or erase authorship. What goes is every grant: someone removed
       * from the organization keeps no room membership behind them.
       */
      const [m] = await d
        .select({
          userId: organizationMemberships.userId,
          organizationId: organizationMemberships.organizationId,
        })
        .from(organizationMemberships)
        .where(eq(organizationMemberships.id, id))
        .limit(1);
      if (m) await revokeRoomGrants(d, m.userId, m.organizationId);
      await deleteMembership(d, id);
      return;
    }

    default:
      return;
  }
}
