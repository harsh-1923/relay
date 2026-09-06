import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  actors,
  organizationMemberships,
  organizations,
  users,
  workspaceMemberships,
} from '@relay/schema';

import { db } from '../src/db';
import { applyEvent, type Env } from '../src/webhooks/workos';

/**
 * Payloads here are the shape `constructEvent` actually produces — camelCase, captured from
 * a delivered event. An earlier version of these tests invented snake_case fields and passed
 * against a handler that read the same wrong names, so every user's name silently mirrored
 * as null. Keep these aligned with observed payloads, not with the REST API's field names.
 *
 * Runs against the local Postgres from `pnpm run up`. WorkOS cannot deliver to localhost, so
 * this is what proves the mirror writes are correct without a tunnel.
 *
 * Ids are prefixed and removed afterwards: the database is meant to hold only what the real
 * flow created, so a test must not leave anything behind.
 */
const env = {
  HYPERDRIVE: { connectionString: 'postgresql://postgres:postgres@localhost:54322/postgres' },
} as Env;

const USER = 'user_01TEST0000000000000000000';
const ORG = 'org_01TEST00000000000000000000';
const MEMBERSHIP = 'om_01TEST000000000000000000000';

const d = db(env);
const cleanup = async () => {
  await d.delete(workspaceMemberships).where(eq(workspaceMemberships.organizationId, ORG));
  await d.delete(organizationMemberships).where(eq(organizationMemberships.id, MEMBERSHIP));
  // An active membership now brings an actor with it, and an actor outlives its user.
  await d.delete(actors).where(eq(actors.organizationId, ORG));
  await d.delete(users).where(eq(users.id, USER));
  await d.delete(organizations).where(eq(organizations.id, ORG));
};

beforeAll(cleanup);
afterAll(cleanup);

describe('workos webhook → postgres mirror', () => {
  it('creates a user', async () => {
    await applyEvent(
      { event: 'user.created', data: { id: USER, email: 'probe@relay.test', firstName: 'Probe' } },
      env,
    );
    const [row] = await d.select().from(users).where(eq(users.id, USER));
    expect(row?.email).toBe('probe@relay.test');
    expect(row?.firstName).toBe('Probe');
  });

  it('is idempotent — WorkOS retries, and events arrive out of order', async () => {
    const event = {
      event: 'user.created',
      data: { id: USER, email: 'probe@relay.test', firstName: 'Probe' },
    };
    await applyEvent(event, env);
    await applyEvent(event, env);
    const rows = await d.select().from(users).where(eq(users.id, USER));
    expect(rows).toHaveLength(1);
  });

  it('updates in place rather than duplicating', async () => {
    await applyEvent(
      { event: 'user.updated', data: { id: USER, email: 'renamed@relay.test', lastName: 'Two' } },
      env,
    );
    const [row] = await d.select().from(users).where(eq(users.id, USER));
    expect(row?.email).toBe('renamed@relay.test');
    expect(row?.lastName).toBe('Two');
  });

  it('mirrors an organization and a membership', async () => {
    await applyEvent({ event: 'organization.created', data: { id: ORG, name: 'Probe Org' } }, env);
    await applyEvent(
      {
        event: 'organization_membership.created',
        data: {
          id: MEMBERSHIP,
          userId: USER,
          organizationId: ORG,
          status: 'active',
          role: { slug: 'admin' },
        },
      },
      env,
    );
    const [m] = await d
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.id, MEMBERSHIP));
    expect(m?.roles).toEqual(['admin']);
    expect(m?.status).toBe('active');
  });

  it('tolerates deleting a row that is already gone', async () => {
    await applyEvent({ event: 'user.deleted', data: { id: 'user_01NOTHING' } }, env);
    expect(await d.select().from(users).where(eq(users.id, 'user_01NOTHING'))).toHaveLength(0);
  });

  it('ignores events it does not handle', async () => {
    await expect(applyEvent({ event: 'session.created', data: {} }, env)).resolves.toBeUndefined();
  });
});

/**
 * `actors.display_name` is a projection of the mirror, so the only writer is the handler that
 * maintains the mirror itself. These cover that it fans out, that a guest gets one, and that
 * the row survives everything the person's account can do — because `messages.author_id` is
 * `restrict`, and because a webhook a foreign key refuses is retried forever.
 */
describe('workos webhook → actors', () => {
  // Unlike the block above, these do not build on each other — each seeds what it needs.
  beforeEach(cleanup);

  const seed = async (role = 'member') => {
    await applyEvent(
      { event: 'user.created', data: { id: USER, email: 'probe@relay.test', firstName: 'Probe' } },
      env,
    );
    await applyEvent({ event: 'organization.created', data: { id: ORG, name: 'Probe Org' } }, env);
    await applyEvent(
      {
        event: 'organization_membership.created',
        data: {
          id: MEMBERSHIP,
          userId: USER,
          organizationId: ORG,
          status: 'active',
          role: { slug: role },
        },
      },
      env,
    );
  };

  it('creates one when a membership becomes active', async () => {
    await seed();
    const [a] = await d.select().from(actors).where(eq(actors.organizationId, ORG));
    expect(a?.kind).toBe('human');
    expect(a?.userId).toBe(USER);
    expect(a?.displayName).toBe('Probe');
  });

  it('creates one for a guest too — addressable without a workspace', async () => {
    await seed('guest');
    const [a] = await d.select().from(actors).where(eq(actors.organizationId, ORG));
    expect(a?.userId).toBe(USER);
    const ws = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, USER));
    expect(ws).toHaveLength(0);
  });

  it('does not create one for a merely invited person', async () => {
    await applyEvent({ event: 'user.created', data: { id: USER, email: 'probe@relay.test' } }, env);
    await applyEvent({ event: 'organization.created', data: { id: ORG, name: 'Probe Org' } }, env);
    await applyEvent(
      {
        event: 'organization_membership.created',
        data: { id: MEMBERSHIP, userId: USER, organizationId: ORG, status: 'pending' },
      },
      env,
    );
    expect(await d.select().from(actors).where(eq(actors.organizationId, ORG))).toHaveLength(0);
  });

  it('carries a rename out to the projection', async () => {
    await seed();
    await applyEvent(
      {
        event: 'user.updated',
        data: { id: USER, email: 'probe@relay.test', firstName: 'Renamed', lastName: 'Person' },
      },
      env,
    );
    const [a] = await d.select().from(actors).where(eq(actors.organizationId, ORG));
    expect(a?.displayName).toBe('Renamed Person');
  });

  it('leaves a tombstone when the user is deleted, rather than refusing the delivery', async () => {
    await seed();
    await expect(
      applyEvent({ event: 'user.deleted', data: { id: USER } }, env),
    ).resolves.toBeUndefined();

    expect(await d.select().from(users).where(eq(users.id, USER))).toHaveLength(0);
    const [a] = await d.select().from(actors).where(eq(actors.organizationId, ORG));
    expect(a?.userId).toBeNull();
    expect(a?.kind).toBe('human');
    expect(a?.displayName).toBe('Probe'); // still renders on whatever they wrote
  });

  it('revokes grants when a membership is deleted, and keeps the actor', async () => {
    await seed();
    const [a] = await d.select().from(actors).where(eq(actors.organizationId, ORG));
    await applyEvent({ event: 'organization_membership.deleted', data: { id: MEMBERSHIP } }, env);

    expect(
      await d.select().from(workspaceMemberships).where(eq(workspaceMemberships.userId, USER)),
    ).toHaveLength(0);
    const [still] = await d.select().from(actors).where(eq(actors.id, a!.id));
    expect(still?.id).toBe(a!.id);
  });
});
