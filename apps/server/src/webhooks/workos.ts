import { eq } from 'drizzle-orm';

import { organizationMemberships, organizations, users } from '@relay/schema';

import { workos, type Env as AuthEnv } from '../auth/session';
import { db, type DbEnv } from '../db';

export type Env = AuthEnv & DbEnv & { WORKOS_WEBHOOK_SECRET: string };

interface WorkosEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * WorkOS is upstream, Postgres is a read replica (invariant 4). These rows arrive here and
 * nowhere else — a direct write from application code is silently overwritten by the next
 * event, so the mirror is only ever as correct as this handler.
 *
 * Every write is idempotent: WorkOS retries, and events can arrive out of order, so upserts
 * are keyed on the WorkOS id and deletes tolerate a row that is already gone.
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

export async function applyEvent(event: WorkosEvent, env: Env): Promise<void> {
  const d = db(env);

  switch (event.event) {
    case 'user.created':
    case 'user.updated': {
      const u = event.data as {
        id: string;
        email: string;
        first_name?: string | null;
        last_name?: string | null;
        profile_picture_url?: string | null;
      };
      const row = {
        id: u.id,
        email: u.email,
        firstName: u.first_name ?? null,
        lastName: u.last_name ?? null,
        profilePic: u.profile_picture_url ?? null,
        updatedAt: new Date(),
      };
      await d.insert(users).values(row).onConflictDoUpdate({ target: users.id, set: row });
      return;
    }

    case 'user.deleted':
      await d.delete(users).where(eq(users.id, (event.data as { id: string }).id));
      return;

    case 'organization.created':
    case 'organization.updated': {
      const o = event.data as { id: string; name: string };
      const row = { id: o.id, name: o.name, updatedAt: new Date() };
      await d
        .insert(organizations)
        .values(row)
        .onConflictDoUpdate({ target: organizations.id, set: row });
      return;
    }

    case 'organization.deleted':
      await d.delete(organizations).where(eq(organizations.id, (event.data as { id: string }).id));
      return;

    case 'organization_membership.created':
    case 'organization_membership.updated': {
      const m = event.data as {
        id: string;
        user_id: string;
        organization_id: string;
        status: string;
        role?: { slug?: string };
      };
      const row = {
        id: m.id,
        userId: m.user_id,
        organizationId: m.organization_id,
        roles: [m.role?.slug ?? 'member'],
        status: m.status,
        updatedAt: new Date(),
      };
      await d
        .insert(organizationMemberships)
        .values(row)
        .onConflictDoUpdate({ target: organizationMemberships.id, set: row });
      return;
    }

    case 'organization_membership.deleted':
      await d
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.id, (event.data as { id: string }).id));
      return;

    default:
      return;
  }
}
