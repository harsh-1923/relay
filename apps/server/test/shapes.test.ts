import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  actors,
  conversationMembers,
  conversations,
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
import { addRoomMember, createRoom } from '../src/rooms';
import type * as SessionModule from '../src/auth/session';
import { handleShape, type Env } from '../src/shapes/index';

/**
 * Runs against the local stack from `pnpm run up` — real Postgres *and* real Electric. That is
 * the point: a passing test here means the where clause was accepted by Electric and the shape
 * actually streamed, not that a mock agreed with itself.
 *
 * `unsealSession` is stubbed, because minting a WorkOS seal needs a browser round trip. What is
 * under test is authorisation and the upstream request, not the seal.
 */
vi.mock('../src/auth/session', async (orig) => ({
  ...(await orig<typeof SessionModule>()),
  unsealSession: async (_req: Request, env: { __session?: unknown }) =>
    env.__session ? { session: env.__session, refreshed: null } : null,
}));

const CONN = 'postgresql://postgres:postgres@localhost:54322/postgres';
const ELECTRIC = 'http://localhost:54330';
const SECRET = 'local-dev-only-not-a-secret';

const ORG = 'org_01TEST00000000000000SHAPES';
const OWNER = 'user_01TEST000000000SHAPEOWNER';
const MEMBER = 'user_01TEST00000000SHAPEMEMBR';
const GUEST = 'user_01TEST0000000000SHAPEGST';
const ALL = [OWNER, MEMBER, GUEST];

const d = db({ HYPERDRIVE: { connectionString: CONN } } as never);

let workspaceId: string;
let publicRoom: string, privateRoom: string, sharedConversation: string;
const actorIds: Record<string, string> = {};

const asUser = (who: string | null) =>
  ({
    HYPERDRIVE: { connectionString: CONN },
    ELECTRIC_URL: ELECTRIC,
    ELECTRIC_SECRET: SECRET,
    __session: who ? { userId: who, organizationId: ORG, sessionId: 's' } : null,
  }) as unknown as Env;

const call = (who: string | null, name: string, qs = '') => {
  // `offset=-1` means "from the start of the log". Electric requires it on every request, so a
  // real client always sends one; defaulting it here keeps each test about its own subject.
  const sep = qs ? '&' : '?';
  const url = `http://localhost:8787/shapes/${name}${qs}${qs.includes('offset=') ? '' : `${sep}offset=-1`}`;
  return handleShape(new Request(url), asUser(who), name);
};

const cleanup = async () => {
  await d.delete(panels).where(eq(panels.organizationId, ORG));
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
  await d.insert(organizations).values({ id: ORG, name: 'Shapes Test' });
  await d.insert(users).values(ALL.map((id) => ({ id, email: `${id}@shapes.test` })));
  await d.insert(organizationMemberships).values(
    ALL.map((userId, i) => ({
      id: `om_01TEST0000000000000SHAPE${i}`,
      userId,
      organizationId: ORG,
      roles: [userId === GUEST ? 'guest' : 'member'],
      status: 'active',
    })),
  );
  const [ws] = await d
    .insert(workspaces)
    .values({ organizationId: ORG, name: 'Shapes', slug: 'shapes-test', isDefault: true })
    .returning();
  workspaceId = ws!.id;

  // The guest gets no workspace membership. That is the whole guest model.
  await d.insert(workspaceMemberships).values(
    [OWNER, MEMBER].map((userId) => ({
      workspaceId,
      userId,
      organizationId: ORG,
      role: 'member',
    })),
  );
  for (const userId of ALL) {
    await ensureActor(d, { userId, organizationId: ORG });
    actorIds[userId] = (await actorFor(d, { userId, organizationId: ORG }))!;
  }

  const pub = await createRoom(d, {
    workspaceId,
    organizationId: ORG,
    name: 'General',
    createdBy: actorIds[OWNER]!,
  });
  publicRoom = pub.room.id;
  sharedConversation = pub.conversation.id;

  const priv = await createRoom(d, {
    workspaceId,
    organizationId: ORG,
    name: 'Founders',
    createdBy: actorIds[OWNER]!,
    isPrivate: true,
  });
  privateRoom = priv.room.id;
});

afterAll(cleanup);

describe('shape proxy — authorisation', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await call(null, 'actors')).status).toBe(401);
  });

  it('refuses a shape that is not in the registry', async () => {
    expect((await call(OWNER, 'pg_shadow')).status).toBe(404);
    expect((await call(OWNER, 'users')).status).toBe(404);
  });

  it('serves a public room to any workspace member, joined or not', async () => {
    const res = await call(MEMBER, 'room', `?roomId=${publicRoom}`);
    expect(res.status).toBe(200);
    const joined = await d
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, publicRoom), eq(roomMembers.actorId, actorIds[MEMBER]!)));
    expect(joined).toHaveLength(0);
  });

  it('refuses a public room to a guest, who has no workspace membership', async () => {
    expect((await call(GUEST, 'room', `?roomId=${publicRoom}`)).status).toBe(403);
  });

  it('refuses a private room to a workspace member who is not in it', async () => {
    expect((await call(MEMBER, 'room', `?roomId=${privateRoom}`)).status).toBe(403);
  });

  it('serves a private room to a guest who was added to it', async () => {
    await d.insert(roomMembers).values({
      roomId: privateRoom,
      actorId: actorIds[GUEST]!,
      workspaceId,
      organizationId: ORG,
    });
    expect((await call(GUEST, 'room', `?roomId=${privateRoom}`)).status).toBe(200);
  });

  it('refuses a room-scoped shape with no room', async () => {
    // 400 rather than 403: a missing parameter is a client bug, it never reaches the database,
    // and answering it as "forbidden" would imply a room was looked up.
    expect((await call(OWNER, 'room')).status).toBe(400);
  });

  it('refuses a conversation the viewer may not read', async () => {
    const [priv] = await d
      .insert(conversations)
      .values({
        workspaceId,
        organizationId: ORG,
        kind: 'panel',
        visibility: 'private',
        roomId: publicRoom,
        createdBy: actorIds[OWNER]!,
      })
      .returning();
    await d.insert(conversationMembers).values({
      conversationId: priv!.id,
      actorId: actorIds[OWNER]!,
      workspaceId,
      organizationId: ORG,
    });
    expect((await call(OWNER, 'messages', `?conversationId=${priv!.id}`)).status).toBe(200);
    expect((await call(MEMBER, 'messages', `?conversationId=${priv!.id}`)).status).toBe(403);
  });
});

describe('shape proxy — the upstream request', () => {
  it('streams a real shape from Electric, with its resume headers', async () => {
    const res = await call(OWNER, 'room', `?roomId=${publicRoom}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('electric-handle')).toBeTruthy();
    expect(res.headers.get('electric-offset')).toBeTruthy();
    const schema = JSON.parse(res.headers.get('electric-schema') ?? '{}');
    expect(Object.keys(schema)).toContain('is_private');
  });

  it('applies the column allow-list, so search_text never leaves the server', async () => {
    const res = await call(OWNER, 'messages', `?conversationId=${sharedConversation}`);
    expect(res.status).toBe(200);
    const schema = JSON.parse(res.headers.get('electric-schema') ?? '{}');
    expect(Object.keys(schema)).toContain('body');
    expect(Object.keys(schema)).not.toContain('search_text');
  });

  it('never lets a shared cache hold a response', async () => {
    const res = await call(OWNER, 'room', `?roomId=${publicRoom}`);
    expect(res.headers.get('cache-control')).toMatch(/^private/);
  });

  it('ignores a client-supplied table, where and secret', async () => {
    const res = await call(
      OWNER,
      'room',
      `?roomId=${publicRoom}&table=users&where=true&columns=email&secret=wrong`,
    );
    expect(res.status).toBe(200);
    const schema = JSON.parse(res.headers.get('electric-schema') ?? '{}');
    expect(Object.keys(schema)).not.toContain('email');
    expect(Object.keys(schema)).toContain('is_private');
  });

  it('rejects a parameter that is not an id rather than building a query from it', async () => {
    // 400, not 403: validation happens before authorisation, so a malformed id never reaches
    // the database and is reported as the client bug it is.
    expect((await call(OWNER, 'room', `?roomId=' OR 1=1 --`)).status).toBe(400);
    expect((await call(OWNER, 'room', `?roomId=${publicRoom}x`)).status).toBe(400);
  });
});

describe('shape proxy — the room directory', () => {
  const values = async (res: Response, key: string): Promise<unknown[]> =>
    ((await res.json()) as Array<{ value?: Record<string, unknown> }>)
      .filter((m) => m.value)
      .map((m) => m.value![key]);

  it('serves the public shape to any workspace member, listing only public rooms', async () => {
    const res = await call(MEMBER, 'rooms', `?workspaceId=${workspaceId}`);
    expect(res.status).toBe(200);
    const names = await values(res, 'name');
    expect(names).toContain('General');
    expect(names).not.toContain('Founders'); // private
  });

  it('refuses the public shape to a guest, who has no workspace membership', async () => {
    expect((await call(GUEST, 'rooms', `?workspaceId=${workspaceId}`)).status).toBe(403);
  });

  it('refuses the public shape for a workspace in another organization', async () => {
    expect((await call(OWNER, 'rooms', `?workspaceId=${crypto.randomUUID()}`)).status).toBe(403);
  });

  it('serves memberships to a guest, so their private rooms are findable without listing all public ones', async () => {
    // The guest was added to `privateRoom` by an earlier fixture in this file.
    const res = await call(GUEST, 'roomMemberships', `?workspaceId=${workspaceId}`);
    expect(res.status).toBe(200);
    expect(await values(res, 'room_id')).toContain(privateRoom);
  });

  it('carries no subquery — a fresh membership resolves within one request, no lag', async () => {
    const owner = await actorFor(d, { userId: OWNER, organizationId: ORG });
    const { room } = await createRoom(d, {
      workspaceId,
      organizationId: ORG,
      name: `Probe ${Date.now()}`,
      createdBy: owner!,
      isPrivate: true,
    });
    await addRoomMember(d, { roomId: room.id, actorId: owner! });

    const res = await call(OWNER, 'roomMemberships', `?workspaceId=${workspaceId}`);
    expect(await values(res, 'room_id')).toContain(room.id);
  });
});
