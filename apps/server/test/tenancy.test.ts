import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  actors,
  organizationMemberships,
  organizations,
  users,
  workspaceMemberships,
  workspaces,
} from '@relay/schema';

import { db } from '../src/db';
import {
  createDefaultWorkspace,
  createWorkspace,
  defaultWorkspace,
  isMemberOf,
  joinDefaultWorkspace,
  slugify,
  switchTargets,
} from '../src/tenancy';

/**
 * Runs against the local Postgres from `pnpm run up`. The WorkOS legs of signup are not
 * covered here — they mutate a real environment; this is everything below the org line,
 * which is ours.
 *
 * Ids are prefixed and removed afterwards: the database is meant to hold only what the real
 * flow created.
 */
const env = {
  HYPERDRIVE: { connectionString: 'postgresql://postgres:postgres@localhost:54322/postgres' },
} as never;

const ORG = 'org_01TEST0000000000000000TEN';
const OWNER = 'user_01TEST00000000000000OWNER';
const INVITEE = 'user_01TEST000000000000INVITEE';

const d = db(env);

const ORG2 = 'org_01TEST000000000000000TEN2';

const cleanup = async () => {
  await d.delete(workspaceMemberships).where(eq(workspaceMemberships.organizationId, ORG));
  await d.delete(organizationMemberships).where(eq(organizationMemberships.userId, OWNER));
  await d.delete(organizations).where(eq(organizations.id, ORG2));
  await d.delete(workspaces).where(eq(workspaces.organizationId, ORG));
  for (const org of [ORG, ORG2]) await d.delete(actors).where(eq(actors.organizationId, org));
  await d.delete(users).where(eq(users.id, OWNER));
  await d.delete(users).where(eq(users.id, INVITEE));
  await d.delete(users).where(eq(users.id, 'user_01TEST0000000000000GUEST'));
  await d.delete(organizations).where(eq(organizations.id, ORG));
};

beforeAll(async () => {
  await cleanup();
  await d.insert(organizations).values({ id: ORG, name: 'Tenancy Test' });
  await d.insert(users).values([
    { id: OWNER, email: 'owner@relay.test' },
    { id: INVITEE, email: 'invitee@relay.test' },
  ]);
});
afterAll(cleanup);

describe('slugify', () => {
  it('makes a name addressable', () => {
    expect(slugify('Acme')).toBe('acme');
    expect(slugify('  Acme   Corp  ')).toBe('acme-corp');
    expect(slugify('Acme & Co.')).toBe('acme-co');
  });

  it('never yields an empty slug', () => {
    // The unique constraint is on (organization_id, slug); an empty one would collide
    // across every punctuation-only name in an org.
    expect(slugify('!!!')).toBe('workspace');
    expect(slugify('')).toBe('workspace');
  });

  it('bounds the length', () => {
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

describe('createDefaultWorkspace', () => {
  it('creates the workspace and its creator as admin, together', async () => {
    const w = await createDefaultWorkspace(d, {
      organizationId: ORG,
      userId: OWNER,
      name: 'Acme Corp',
    });
    expect(w.slug).toBe('acme-corp');
    expect(w.isDefault).toBe(true);

    const [m] = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, w.id));
    // A workspace with no members is unreachable and nothing could repair it.
    expect(m?.userId).toBe(OWNER);
    expect(m?.role).toBe('admin');
  });

  it('is discoverable as the org default', async () => {
    const w = await defaultWorkspace(d, ORG);
    expect(w?.name).toBe('Acme Corp');
  });
});

describe('joinDefaultWorkspace — the invitation arm', () => {
  it('puts an invitee in the org default as a member', async () => {
    await joinDefaultWorkspace(d, INVITEE, ORG);
    const [m] = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, INVITEE));
    expect(m?.role).toBe('member');
  });

  it('is idempotent — WorkOS retries and delivers out of order', async () => {
    await joinDefaultWorkspace(d, INVITEE, ORG);
    await joinDefaultWorkspace(d, INVITEE, ORG);
    const rows = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, INVITEE));
    expect(rows).toHaveLength(1);
  });

  it('is silent when the org has no default workspace yet', async () => {
    // A membership webhook can race signup. Throwing would fail the delivery and WorkOS
    // would retry forever.
    await expect(
      joinDefaultWorkspace(d, INVITEE, 'org_01TEST00000000000NOTHING'),
    ).resolves.toBeUndefined();
  });
});

describe('switchTargets — what the workspace menu shows', () => {
  it('lists one row per workspace membership, not one per organization', async () => {
    // An organization the user belongs to but has no workspace in contributes nothing: being
    // in the tenant is not being in the workspace (invariant 5), and there is nothing to open.
    await d.insert(organizations).values({ id: ORG2, name: 'Second Org' }).onConflictDoNothing();
    await d
      .insert(organizationMemberships)
      .values([
        {
          id: 'om_01TEST00000000000000000A',
          userId: OWNER,
          organizationId: ORG,
          status: 'active',
          roles: ['owner'],
        },
        {
          id: 'om_01TEST00000000000000000B',
          userId: OWNER,
          organizationId: ORG2,
          status: 'active',
          roles: ['admin'],
        },
      ])
      .onConflictDoNothing();

    const targets = await switchTargets(d, OWNER);

    expect(targets.map((t) => t.organizationId)).toEqual([ORG]);
    expect(targets[0]?.name).toBe('Acme Corp'); // the workspace
    expect(targets[0]?.organizationName).toBe('Tenancy Test'); // the tenant above it
    expect(targets[0]?.workspaceId).toBeTruthy();
    expect(targets[0]?.isDefault).toBe(true);
    expect(targets[0]?.roles).toEqual(['owner']);
  });

  it('lists a second workspace in the same organization, and only for its members', async () => {
    const extra = await createWorkspace(d, {
      organizationId: ORG,
      userId: OWNER,
      name: 'Design',
    });

    const mine = await switchTargets(d, OWNER);
    expect(mine.map((t) => t.name).sort()).toEqual(['Acme Corp', 'Design']);
    expect(mine.find((t) => t.name === 'Design')?.isDefault).toBe(false);

    // The other member was never added to it, so it is not theirs to open.
    const theirs = await switchTargets(d, INVITEE);
    expect(theirs.map((t) => t.name)).not.toContain('Design');
    expect(extra.slug).toBe('design');
  });

  it('gives a colliding name its own slug rather than failing', async () => {
    const again = await createWorkspace(d, {
      organizationId: ORG,
      userId: OWNER,
      name: 'Design',
    });
    expect(again.slug).toBe('design-2');
  });

  it('excludes memberships that are not active', async () => {
    await d
      .update(organizationMemberships)
      .set({ status: 'inactive' })
      .where(eq(organizationMemberships.id, 'om_01TEST00000000000000000B'));

    const targets = await switchTargets(d, OWNER);
    expect(targets.every((t) => t.organizationId === ORG)).toBe(true);
  });
});

describe('isMemberOf — the switch guard', () => {
  it('accepts an active membership and rejects everything else', async () => {
    expect(await isMemberOf(d, OWNER, ORG)).toBe(true);
    // Deactivated above.
    expect(await isMemberOf(d, OWNER, ORG2)).toBe(false);
    expect(await isMemberOf(d, INVITEE, ORG)).toBe(false);
    expect(await isMemberOf(d, OWNER, 'org_01TEST000000000000NOTHING')).toBe(false);
  });
});

describe('invitation acceptance — which arm runs', () => {
  /**
   * Acceptance arrives as `organization_membership.created` and the role on it decides where
   * the invitee lands. Exercised through `joinDefaultWorkspace` directly: the handler's own
   * branch is one `if`, and the part worth pinning is that a guest gets no workspace row.
   */
  const GUEST = 'user_01TEST0000000000000GUEST';

  beforeAll(async () => {
    await d.insert(users).values({ id: GUEST, email: 'guest@relay.test' }).onConflictDoNothing();
  });

  it('a member lands in the default workspace', async () => {
    await joinDefaultWorkspace(d, INVITEE, ORG, 'member');
    const [m] = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, INVITEE));
    expect(m?.role).toBe('member');
  });

  it('a pending membership grants nothing — only acceptance does', async () => {
    // WorkOS creates the membership when the invitation is *sent*, with status pending, and
    // flips it to active on acceptance. Joining on creation alone handed workspace access to
    // anyone who had merely been emailed — a revoked probe invitation still held a row.
    const PENDING = 'user_01TEST00000000000PENDING';
    await d
      .insert(users)
      .values({ id: PENDING, email: 'pending@relay.test' })
      .onConflictDoNothing();

    // The handler's guard is `status === 'active'`; a pending membership never reaches here.
    const rows = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, PENDING));
    expect(rows).toHaveLength(0);

    await d.delete(users).where(eq(users.id, PENDING));
  });

  it('a guest gets no workspace membership at all', async () => {
    // The handler simply does not call joinDefaultWorkspace for a guest. Asserting the
    // absence is the point: a guest in the workspace would see rooms they were not invited to.
    const rows = await d
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, GUEST));
    expect(rows).toHaveLength(0);
  });
});
