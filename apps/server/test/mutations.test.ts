import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  actors,
  conversationMembers,
  conversations,
  messages,
  organizationMemberships,
  organizations,
  panels,
  roomMembers,
  rooms,
  users,
  workspaceMemberships,
  workspaces,
} from '@relay/schema';

import { actorFor, ensureActor } from '../src/actors';
import { db } from '../src/db';
import { applyMutations, type Mutation } from '../src/powersync/mutations';
import { addRoomMember, createRoom } from '../src/rooms';
import type { Session } from '../src/auth/session';
import type { Env } from '../src/powersync/mutations';

/**
 * The write path is the only gate in front of Postgres, so it is tested against a real
 * database and the real `access.ts` — a mock that agreed with itself would prove nothing
 * about the thing this file exists to stop.
 *
 * Runs against the local stack from `pnpm run up`.
 */

const CONN = 'postgresql://postgres:postgres@localhost:54322/postgres';
const ORG = 'org_01TEST0000000000000MUTATE';
const AUTHOR = 'user_01TEST00000000MUTATEAUTH';
const OTHER = 'user_01TEST0000000MUTATEOTHER';
const OUTSIDER = 'user_01TEST00000MUTATEOUTSIDE';
const ALL = [AUTHOR, OTHER, OUTSIDER];

const env = { HYPERDRIVE: { connectionString: CONN } } as unknown as Env;
const d = db(env);

const actorIds: Record<string, string> = {};
let workspaceId: string;
let publicConversation: string;
let privateConversation: string;

const session = (userId: string): Session => ({
  userId,
  organizationId: ORG,
  sessionId: 's',
  email: `${userId}@mutate.test`,
});

const uuidv7 = async (): Promise<string> => {
  const [row] = await d.execute<{ id: string }>('select uuidv7() as id');
  return row!.id;
};

const cleanup = async () => {
  await d.delete(panels).where(eq(panels.organizationId, ORG));
  await d.delete(messages).where(eq(messages.organizationId, ORG));
  await d.delete(conversationMembers).where(eq(conversationMembers.organizationId, ORG));
  await d.delete(conversations).where(eq(conversations.organizationId, ORG));
  await d.delete(roomMembers).where(eq(roomMembers.organizationId, ORG));
  await d.delete(rooms).where(eq(rooms.organizationId, ORG));
  await d.delete(actors).where(eq(actors.organizationId, ORG));
  await d.delete(workspaceMemberships).where(eq(workspaceMemberships.organizationId, ORG));
  await d.delete(workspaces).where(eq(workspaces.organizationId, ORG));
  await d.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, ORG));
  for (const u of ALL) await d.delete(users).where(eq(users.id, u));
  await d.delete(organizations).where(eq(organizations.id, ORG));
};

beforeAll(async () => {
  await cleanup();
  await d.insert(organizations).values({ id: ORG, name: 'Mutations Test' });
  await d.insert(users).values(ALL.map((id) => ({ id, email: `${id}@mutate.test` })));
  await d.insert(organizationMemberships).values(
    ALL.map((userId, i) => ({
      id: `om_01TEST000000000000MUTATE${i}`,
      userId,
      organizationId: ORG,
      roles: ['member'],
      status: 'active',
    })),
  );

  const [ws] = await d
    .insert(workspaces)
    .values({ organizationId: ORG, name: 'Mutate', slug: 'mutate-test', isDefault: true })
    .returning();
  workspaceId = ws!.id;
  await d
    .insert(workspaceMemberships)
    .values(ALL.map((userId) => ({ workspaceId, userId, organizationId: ORG, role: 'member' })));

  for (const userId of ALL) {
    await ensureActor(d, { userId, organizationId: ORG });
    actorIds[userId] = (await actorFor(d, { userId, organizationId: ORG }))!;
  }

  const pub = await createRoom(d, {
    workspaceId,
    organizationId: ORG,
    name: 'Public',
    createdBy: actorIds[AUTHOR]!,
  });
  publicConversation = pub.conversation.id;

  // Private, and the outsider is deliberately never added.
  const priv = await createRoom(d, {
    workspaceId,
    organizationId: ORG,
    name: 'Private',
    createdBy: actorIds[AUTHOR]!,
    isPrivate: true,
  });
  privateConversation = priv.conversation.id;
  await addRoomMember(d, { roomId: priv.room.id, actorId: actorIds[OTHER]! });
});

afterAll(cleanup);

const post = (conversationId: string, text: string, extra: Record<string, unknown> = {}) =>
  ({
    op: 'PUT',
    table: 'messages',
    id: '',
    data: { conversation_id: conversationId, body: JSON.stringify({ text }), ...extra },
  }) as Mutation;

const run = async (userId: string, batch: Mutation[]) => {
  const result = await applyMutations(env, session(userId), batch);
  if ('error' in result) throw new Error(result.error);
  return result;
};

describe('the write path — what it accepts', () => {
  it('applies a message from someone who may read the conversation', async () => {
    const id = await uuidv7();
    const result = await run(AUTHOR, [{ ...post(publicConversation, 'hello'), id }]);
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);

    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row?.body).toEqual({ text: 'hello' });
    // Derived, not accepted: the payload never carried either.
    expect(row?.workspaceId).toBe(workspaceId);
    expect(row?.organizationId).toBe(ORG);
    expect(row?.searchText).toBe('hello');
  });

  it('is idempotent, because a retried batch re-sends what already applied', async () => {
    const id = await uuidv7();
    const batch = [{ ...post(publicConversation, 'once'), id }];
    await run(AUTHOR, batch);
    await run(AUTHOR, batch);
    const rows = await d.select().from(messages).where(eq(messages.id, id));
    expect(rows).toHaveLength(1);
  });

  it('lets the author edit their own message', async () => {
    const id = await uuidv7();
    await run(AUTHOR, [{ ...post(publicConversation, 'draft'), id }]);
    await run(AUTHOR, [
      { op: 'PATCH', table: 'messages', id, data: { body: JSON.stringify({ text: 'final' }) } },
    ]);
    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row?.body).toEqual({ text: 'final' });
    expect(row?.editedAt).not.toBeNull();
  });

  it('deletes as a tombstone, so replies do not cascade away with it', async () => {
    const id = await uuidv7();
    await run(AUTHOR, [{ ...post(publicConversation, 'regrettable'), id }]);
    await run(AUTHOR, [{ op: 'DELETE', table: 'messages', id }]);
    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row).toBeDefined();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.body).toEqual({});
  });
});

describe('the write path — what it refuses', () => {
  it('refuses a conversation the writer may not read', async () => {
    const id = await uuidv7();
    const result = await run(OUTSIDER, [{ ...post(privateConversation, 'let me in'), id }]);
    expect(result.applied).toBe(0);
    expect(result.rejected[0]?.reason).toBe('forbidden_conversation');
    expect(await d.select().from(messages).where(eq(messages.id, id))).toHaveLength(0);
  });

  it('refuses a table that is not client-writable', async () => {
    const result = await run(AUTHOR, [
      { op: 'PUT', table: 'rooms', id: crypto.randomUUID(), data: { name: 'mine now' } },
    ]);
    expect(result.rejected[0]?.reason).toBe('table_not_writable:rooms');
  });

  it('ignores a forged author — the writer is always the session', async () => {
    const id = await uuidv7();
    await run(AUTHOR, [
      { ...post(publicConversation, 'not from them'), id, data: undefined } as Mutation,
    ]).catch(() => undefined);

    const forged = await uuidv7();
    await run(AUTHOR, [
      {
        ...post(publicConversation, 'signed by someone else', { author_id: actorIds[OTHER] }),
        id: forged,
      },
    ]);
    const [row] = await d.select().from(messages).where(eq(messages.id, forged));
    expect(row?.authorId).toBe(actorIds[AUTHOR]);
  });

  it('ignores forged tenancy — org and workspace come from the conversation', async () => {
    const id = await uuidv7();
    await run(AUTHOR, [
      {
        ...post(publicConversation, 'wrong tenant', {
          organization_id: 'org_01ATTACKER',
          workspace_id: crypto.randomUUID(),
        }),
        id,
      },
    ]);
    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row?.organizationId).toBe(ORG);
    expect(row?.workspaceId).toBe(workspaceId);
  });

  it('refuses a client-claimed system message', async () => {
    const id = await uuidv7();
    await run(AUTHOR, [
      { ...post(publicConversation, 'the server says so', { kind: 'system' }), id },
    ]);
    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row?.kind).toBe('message');
  });

  it("refuses editing another person's message", async () => {
    const id = await uuidv7();
    await run(AUTHOR, [{ ...post(privateConversation, 'mine'), id }]);
    const result = await run(OTHER, [
      { op: 'PATCH', table: 'messages', id, data: { body: JSON.stringify({ text: 'theirs' }) } },
    ]);
    expect(result.rejected[0]?.reason).toBe('not_the_author');
    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row?.body).toEqual({ text: 'mine' });
  });

  it('refuses a body that is not an object', async () => {
    const id = await uuidv7();
    const result = await run(AUTHOR, [
      {
        op: 'PUT',
        table: 'messages',
        id,
        data: { conversation_id: publicConversation, body: '"just a string"' },
      },
    ]);
    expect(result.rejected[0]?.reason).toBe('invalid_body');
  });

  it('reports rejections per operation rather than failing the whole upload', async () => {
    // A batch mixing one legitimate write with two that must not land. The device's queue has
    // to drain either way, or a single bad row wedges it forever.
    const good = await uuidv7();
    const bad = await uuidv7();
    const result = await run(AUTHOR, [
      { ...post(publicConversation, 'fine'), id: good },
      { op: 'PUT', table: 'agents', id: crypto.randomUUID(), data: {} },
      { op: 'PATCH', table: 'messages', id: bad, data: { body: '{}' } },
    ]);
    expect(result.applied).toBe(1);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'table_not_writable:agents',
      'unknown_message',
    ]);
    expect(await d.select().from(messages).where(eq(messages.id, good))).toHaveLength(1);
  });
});
