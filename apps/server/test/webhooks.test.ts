import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { organizationMemberships, organizations, users } from '@relay/schema';

import { db } from '../src/db';
import { applyEvent, type Env } from '../src/webhooks/workos';

/**
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
  await d.delete(organizationMemberships).where(eq(organizationMemberships.id, MEMBERSHIP));
  await d.delete(users).where(eq(users.id, USER));
  await d.delete(organizations).where(eq(organizations.id, ORG));
};

beforeAll(cleanup);
afterAll(cleanup);

describe('workos webhook → postgres mirror', () => {
  it('creates a user', async () => {
    await applyEvent(
      { event: 'user.created', data: { id: USER, email: 'probe@relay.test', first_name: 'Probe' } },
      env,
    );
    const [row] = await d.select().from(users).where(eq(users.id, USER));
    expect(row?.email).toBe('probe@relay.test');
    expect(row?.firstName).toBe('Probe');
  });

  it('is idempotent — WorkOS retries, and events arrive out of order', async () => {
    const event = {
      event: 'user.created',
      data: { id: USER, email: 'probe@relay.test', first_name: 'Probe' },
    };
    await applyEvent(event, env);
    await applyEvent(event, env);
    const rows = await d.select().from(users).where(eq(users.id, USER));
    expect(rows).toHaveLength(1);
  });

  it('updates in place rather than duplicating', async () => {
    await applyEvent(
      { event: 'user.updated', data: { id: USER, email: 'renamed@relay.test', last_name: 'Two' } },
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
          user_id: USER,
          organization_id: ORG,
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
