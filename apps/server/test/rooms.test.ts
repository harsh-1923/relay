import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  actors,
  agents,
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

import {
  actorFor,
  backfillActors,
  createAgentActor,
  ensureActor,
  reconcileActorProfiles,
} from '../src/actors';
import { mayInvokeIn, mayReadConversation, mayReadRoom, type Viewer } from '../src/access';
import { db } from '../src/db';
import {
  RoomNameTakenError,
  addRoomMember,
  archiveRoom,
  createRoom,
  promoteConversation,
  removeRoomMember,
  unarchiveRoom,
} from '../src/rooms';
import { revokeRoomGrants } from '../src/tenancy';

/**
 * Runs against the local Postgres from `pnpm run up`.
 *
 * The cast is the point of this file: four people with deliberately different standing, so
 * the authorisation paths are exercised by the cases that actually differ rather than by one
 * happy member.
 *
 *   OWNER  — workspace member, creates the rooms
 *   MEMBER — workspace member, joins nothing
 *   GUEST  — org membership only, no workspace membership, added to one private room
 *   ADMIN  — workspace admin, to prove the role buys nothing below the workspace
 */
const env = {
  HYPERDRIVE: { connectionString: 'postgresql://postgres:postgres@localhost:54322/postgres' },
} as never;

const ORG = 'org_01TEST000000000000000ROOMS';
const OTHER_ORG = 'org_01TEST00000000000ROOMSALT';
const OWNER = 'user_01TEST0000000000ROOMOWNER';
const MEMBER = 'user_01TEST000000000ROOMMEMBR';
const GUEST = 'user_01TEST0000000000ROOMGUES';
const ADMIN = 'user_01TEST0000000000ROOMADMN';
const ALL_USERS = [OWNER, MEMBER, GUEST, ADMIN];

const d = db(env);

let workspaceId: string;
let owner: Viewer, member: Viewer, guest: Viewer, admin: Viewer;

const cleanup = async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await d.delete(messages).where(eq(messages.organizationId, org));
    await d.delete(panels).where(eq(panels.organizationId, org));
    await d.delete(conversationMembers).where(eq(conversationMembers.organizationId, org));
    await d.delete(conversations).where(eq(conversations.organizationId, org));
    await d.delete(roomMembers).where(eq(roomMembers.organizationId, org));
    await d.delete(rooms).where(eq(rooms.organizationId, org));
    await d.delete(agents).where(eq(agents.organizationId, org));
    await d.delete(actors).where(eq(actors.organizationId, org));
    await d.delete(workspaceMemberships).where(eq(workspaceMemberships.organizationId, org));
    await d.delete(workspaces).where(eq(workspaces.organizationId, org));
    await d.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, org));
  }
  for (const u of ALL_USERS) await d.delete(users).where(eq(users.id, u));
  for (const org of [ORG, OTHER_ORG])
    await d.delete(organizations).where(eq(organizations.id, org));
};

const viewerFor = async (userId: string): Promise<Viewer> => ({
  userId,
  organizationId: ORG,
  actorId: (await actorFor(d, { userId, organizationId: ORG }))!,
});

beforeAll(async () => {
  await cleanup();
  await d.insert(organizations).values([
    { id: ORG, name: 'Rooms Test' },
    { id: OTHER_ORG, name: 'Rooms Test Alt' },
  ]);
  await d.insert(users).values([
    { id: OWNER, email: 'owner@rooms.test', firstName: 'Ora', lastName: 'Owner' },
    { id: MEMBER, email: 'member@rooms.test', firstName: 'Mel' },
    { id: GUEST, email: 'guest@rooms.test' },
    { id: ADMIN, email: 'admin@rooms.test', firstName: 'Ada', lastName: 'Admin' },
  ]);
  await d.insert(organizationMemberships).values(
    ALL_USERS.map((userId, i) => ({
      id: `om_01TEST00000000000000ROOM${i}`,
      userId,
      organizationId: ORG,
      roles: [userId === GUEST ? 'guest' : 'member'],
      status: 'active',
    })),
  );

  const [ws] = await d
    .insert(workspaces)
    .values({ organizationId: ORG, name: 'Rooms', slug: 'rooms-test', isDefault: true })
    .returning();
  workspaceId = ws!.id;

  // Everyone but the guest is in the workspace. That is the whole guest model.
  await d.insert(workspaceMemberships).values([
    { workspaceId, userId: OWNER, organizationId: ORG, role: 'member' },
    { workspaceId, userId: MEMBER, organizationId: ORG, role: 'member' },
    { workspaceId, userId: ADMIN, organizationId: ORG, role: 'admin' },
  ]);

  for (const userId of ALL_USERS) await ensureActor(d, { userId, organizationId: ORG });
  [owner, member, guest, admin] = await Promise.all(ALL_USERS.map(viewerFor));
});

afterAll(cleanup);

beforeEach(async () => {
  await d.delete(panels).where(eq(panels.organizationId, ORG));
  await d.delete(conversationMembers).where(eq(conversationMembers.organizationId, ORG));
  await d.delete(conversations).where(eq(conversations.organizationId, ORG));
  await d.delete(roomMembers).where(eq(roomMembers.organizationId, ORG));
  await d.delete(rooms).where(eq(rooms.organizationId, ORG));
});

const newRoom = (name: string, isPrivate = false) =>
  createRoom(d, { workspaceId, organizationId: ORG, name, createdBy: owner.actorId, isPrivate });

describe('actors', () => {
  it('names a person from the mirror, falling back to the email local part', async () => {
    const [ora] = await d.select().from(actors).where(eq(actors.id, owner.actorId));
    const [g] = await d.select().from(actors).where(eq(actors.id, guest.actorId));
    expect(ora!.displayName).toBe('Ora Owner');
    expect(g!.displayName).toBe('guest'); // no name in the mirror yet
  });

  it('is idempotent — a retry finds the row rather than making a second', async () => {
    const again = await ensureActor(d, { userId: OWNER, organizationId: ORG });
    expect(again).toBe(owner.actorId);
  });

  it('is per organization, so the same person in two orgs is two actors', async () => {
    await d.insert(organizationMemberships).values({
      id: 'om_01TEST0000000000000ROOMALT',
      userId: OWNER,
      organizationId: OTHER_ORG,
      roles: ['member'],
      status: 'active',
    });
    const other = await ensureActor(d, { userId: OWNER, organizationId: OTHER_ORG });
    expect(other).not.toBe(owner.actorId);
  });

  it('repairs a projection that drifted from the mirror', async () => {
    await d
      .update(actors)
      .set({ displayName: 'Edited By Hand' })
      .where(eq(actors.id, owner.actorId));

    expect(await reconcileActorProfiles(d, ORG)).toBe(1);
    const [fixed] = await d.select().from(actors).where(eq(actors.id, owner.actorId));
    expect(fixed!.displayName).toBe('Ora Owner');
    expect(await reconcileActorProfiles(d, ORG)).toBe(0);
  });

  it('backfills only active memberships that lack one, and is safe to re-run', async () => {
    await d.delete(actors).where(and(eq(actors.organizationId, ORG), eq(actors.userId, MEMBER)));
    expect(await backfillActors(d, ORG)).toBe(1);
    expect(await actorFor(d, { userId: MEMBER, organizationId: ORG })).toBeTruthy();
    expect(await backfillActors(d, ORG)).toBe(0);
    member = await viewerFor(MEMBER);
  });
});

describe('creating a room', () => {
  it('writes the room, its one shared chat and the creator, in one transaction', async () => {
    const { room, conversation } = await newRoom('Design');
    expect(conversation.kind).toBe('main');
    expect(conversation.visibility).toBe('shared');
    expect(conversation.roomId).toBe(room.id);

    const members = await d.select().from(roomMembers).where(eq(roomMembers.roomId, room.id));
    expect(members).toHaveLength(1);
    expect(members[0]!.actorId).toBe(owner.actorId);
    // Denormalised from the room, not from the caller (invariant 2).
    expect(members[0]!.workspaceId).toBe(workspaceId);
  });

  it('refuses a name already taken in the workspace, ignoring case', async () => {
    await newRoom('Design');
    await expect(newRoom('DESIGN')).rejects.toBeInstanceOf(RoomNameTakenError);
    await expect(newRoom('  design ')).resolves.toBeTruthy(); // shape is a validator's job, not a CHECK
  });

  it('leaves nothing behind when the transaction fails', async () => {
    await newRoom('Design');
    await expect(newRoom('design')).rejects.toBeInstanceOf(RoomNameTakenError);
    const all = await d.select().from(rooms).where(eq(rooms.organizationId, ORG));
    expect(all).toHaveLength(1);
  });
});

describe('reading a public room', () => {
  it('is open to anyone in the workspace, joined or not', async () => {
    const { room } = await newRoom('General');
    expect(await mayReadRoom(d, member, room.id)).toBe(true);
    const joined = await d
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.actorId, member.actorId)));
    expect(joined).toHaveLength(0); // read without joining — membership means "joined"
  });

  it('is closed to a guest, who has no workspace membership', async () => {
    const { room } = await newRoom('General');
    expect(await mayReadRoom(d, guest, room.id)).toBe(false);
  });
});

describe('reading a private room', () => {
  it('admits only those explicitly added', async () => {
    const { room } = await newRoom('Founders', true);
    expect(await mayReadRoom(d, owner, room.id)).toBe(true);
    expect(await mayReadRoom(d, member, room.id)).toBe(false);
  });

  it('admits a guest who was added — an org membership and nothing else', async () => {
    const { room } = await newRoom('Founders', true);
    await addRoomMember(d, { roomId: room.id, actorId: guest.actorId, addedBy: owner.actorId });
    expect(await mayReadRoom(d, guest, room.id)).toBe(true);
  });

  it('gives a workspace admin no override', async () => {
    const { room } = await newRoom('Founders', true);
    expect(await mayReadRoom(d, admin, room.id)).toBe(false);
  });

  it('refuses a viewer whose session names another organization', async () => {
    const { room } = await newRoom('Founders', true);
    await addRoomMember(d, { roomId: room.id, actorId: guest.actorId });
    expect(await mayReadRoom(d, { ...guest, organizationId: OTHER_ORG }, room.id)).toBe(false);
  });
});

describe('reading a conversation', () => {
  it('delegates to the room when shared', async () => {
    const { room, conversation } = await newRoom('General');
    expect(await mayReadConversation(d, member, conversation.id)).toBe(true);
    expect(await mayReadConversation(d, guest, conversation.id)).toBe(false);

    await d.update(rooms).set({ isPrivate: true }).where(eq(rooms.id, room.id));
    expect(await mayReadConversation(d, member, conversation.id)).toBe(false);
  });

  it('uses its own membership when private, and ignores the room', async () => {
    const { room } = await newRoom('General');
    const [priv] = await d
      .insert(conversations)
      .values({
        workspaceId,
        organizationId: ORG,
        kind: 'panel',
        visibility: 'private',
        roomId: room.id,
        createdBy: owner.actorId,
      })
      .returning();
    await d.insert(conversationMembers).values({
      conversationId: priv!.id,
      actorId: owner.actorId,
      workspaceId,
      organizationId: ORG,
    });

    expect(await mayReadConversation(d, owner, priv!.id)).toBe(true);
    // A workspace member who can read the room still cannot read a private chat inside it.
    expect(await mayReadConversation(d, member, priv!.id)).toBe(false);
  });
});

describe('promoting a private panel chat', () => {
  it('moves two rows and rewrites no message', async () => {
    const { room } = await newRoom('General');
    const [conv] = await d
      .insert(conversations)
      .values({
        workspaceId,
        organizationId: ORG,
        kind: 'panel',
        visibility: 'private',
        roomId: room.id,
        createdBy: owner.actorId,
      })
      .returning();
    const [panel] = await d
      .insert(panels)
      .values({
        roomId: room.id,
        workspaceId,
        organizationId: ORG,
        kind: 'chat',
        visibility: 'private',
        conversationId: conv!.id,
        createdBy: owner.actorId,
      })
      .returning();
    const [msg] = await d
      .insert(messages)
      .values({
        conversationId: conv!.id,
        workspaceId,
        organizationId: ORG,
        authorId: owner.actorId,
        body: { v: 1, blocks: [] },
      })
      .returning();

    expect(await mayReadConversation(d, member, conv!.id)).toBe(false);
    expect(await promoteConversation(d, { conversationId: conv!.id, actorId: owner.actorId })).toBe(
      true,
    );

    expect(await mayReadConversation(d, member, conv!.id)).toBe(true);
    const [after] = await d.select().from(panels).where(eq(panels.id, panel!.id));
    expect(after!.visibility).toBe('shared'); // the mirror moved with it
    const [stillPanel] = await d.select().from(conversations).where(eq(conversations.id, conv!.id));
    expect(stillPanel!.kind).toBe('panel'); // one central chat per room; this is not it

    const [untouched] = await d.select().from(messages).where(eq(messages.id, msg!.id));
    expect(untouched!.conversationId).toBe(conv!.id);
    expect(untouched!.editedAt).toBeNull();
  });

  it("is refused to anyone but the conversation's creator", async () => {
    const { room } = await newRoom('General');
    const [conv] = await d
      .insert(conversations)
      .values({
        workspaceId,
        organizationId: ORG,
        kind: 'panel',
        visibility: 'private',
        roomId: room.id,
        createdBy: owner.actorId,
      })
      .returning();
    expect(
      await promoteConversation(d, { conversationId: conv!.id, actorId: member.actorId }),
    ).toBe(false);
  });
});

describe('archiving', () => {
  it('stamps the room, its conversations and its panels together', async () => {
    const { room, conversation } = await newRoom('General');
    await d.insert(panels).values({
      roomId: room.id,
      workspaceId,
      organizationId: ORG,
      kind: 'browser',
      createdBy: owner.actorId,
      config: { url: 'https://example.com' },
    });

    expect(await archiveRoom(d, { roomId: room.id, actorId: owner.actorId })).toBe(true);
    const [r] = await d.select().from(rooms).where(eq(rooms.id, room.id));
    const [c] = await d.select().from(conversations).where(eq(conversations.id, conversation.id));
    const [p] = await d.select().from(panels).where(eq(panels.roomId, room.id));
    expect(r!.archivedAt).not.toBeNull();
    expect(c!.archivedAt).not.toBeNull();
    expect(p!.archivedAt).not.toBeNull();

    expect(await unarchiveRoom(d, { roomId: room.id, actorId: owner.actorId })).toBe(true);
    const [back] = await d.select().from(rooms).where(eq(rooms.id, room.id));
    expect(back!.archivedAt).toBeNull();
  });

  it("is the creator's alone, even for a workspace admin", async () => {
    const { room } = await newRoom('General');
    expect(await archiveRoom(d, { roomId: room.id, actorId: admin.actorId })).toBe(false);
    expect(await archiveRoom(d, { roomId: room.id, actorId: member.actorId })).toBe(false);
    const [r] = await d.select().from(rooms).where(eq(rooms.id, room.id));
    expect(r!.archivedAt).toBeNull();
  });

  it('destroys nothing — an archived room keeps its messages', async () => {
    const { room, conversation } = await newRoom('General');
    await d.insert(messages).values({
      conversationId: conversation.id,
      workspaceId,
      organizationId: ORG,
      authorId: owner.actorId,
      body: { v: 1, blocks: [] },
    });
    await archiveRoom(d, { roomId: room.id, actorId: owner.actorId });
    const kept = await d
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(kept).toHaveLength(1);
  });
});

describe('leaving a room', () => {
  it('archives the private chats that were theirs alone, keeping the messages', async () => {
    const { room } = await newRoom('Founders', true);
    await addRoomMember(d, { roomId: room.id, actorId: member.actorId });
    const [conv] = await d
      .insert(conversations)
      .values({
        workspaceId,
        organizationId: ORG,
        kind: 'panel',
        visibility: 'private',
        roomId: room.id,
        createdBy: member.actorId,
      })
      .returning();
    await d.insert(messages).values({
      conversationId: conv!.id,
      workspaceId,
      organizationId: ORG,
      authorId: member.actorId,
      body: { v: 1, blocks: [] },
    });

    await removeRoomMember(d, { roomId: room.id, actorId: member.actorId });

    expect(await mayReadRoom(d, member, room.id)).toBe(false);
    const [c] = await d.select().from(conversations).where(eq(conversations.id, conv!.id));
    expect(c!.archivedAt).not.toBeNull();
    const kept = await d.select().from(messages).where(eq(messages.conversationId, conv!.id));
    expect(kept).toHaveLength(1); // there if they return
  });
});

describe('agents', () => {
  it('join a room like a person, and that is what makes them invokable', async () => {
    const [agent] = await d
      .insert(agents)
      .values({ workspaceId, organizationId: ORG, createdBy: owner.actorId, name: 'Researcher' })
      .returning();
    const agentActor = await createAgentActor(d, {
      agentId: agent!.id,
      organizationId: ORG,
      name: 'Researcher',
    });

    const { room } = await newRoom('Founders', true);
    expect(await mayInvokeIn(d, room.id, agentActor)).toBe(false);

    await addRoomMember(d, { roomId: room.id, actorId: agentActor, addedBy: owner.actorId });
    expect(await mayInvokeIn(d, room.id, agentActor)).toBe(true);

    // Removing it stops invocation without touching a credential.
    await removeRoomMember(d, { roomId: room.id, actorId: agentActor });
    expect(await mayInvokeIn(d, room.id, agentActor)).toBe(false);
  });

  it('author messages exactly like a person', async () => {
    const [agent] = await d
      .insert(agents)
      .values({ workspaceId, organizationId: ORG, createdBy: owner.actorId, name: 'Researcher' })
      .returning();
    const agentActor = await createAgentActor(d, {
      agentId: agent!.id,
      organizationId: ORG,
      name: 'Researcher',
    });
    const { conversation } = await newRoom('General');
    const [msg] = await d
      .insert(messages)
      .values({
        conversationId: conversation.id,
        workspaceId,
        organizationId: ORG,
        authorId: agentActor,
        body: { v: 1, blocks: [] },
      })
      .returning();
    expect(msg!.authorId).toBe(agentActor);
  });
});

describe('losing an org membership', () => {
  it('revokes every grant but keeps the actor, so authorship still renders', async () => {
    const { room, conversation } = await newRoom('Founders', true);
    await addRoomMember(d, { roomId: room.id, actorId: member.actorId });
    await d.insert(messages).values({
      conversationId: conversation.id,
      workspaceId,
      organizationId: ORG,
      authorId: member.actorId,
      body: { v: 1, blocks: [] },
    });

    await revokeRoomGrants(d, MEMBER, ORG);

    expect(await mayReadRoom(d, member, room.id)).toBe(false);
    expect(await actorFor(d, { userId: MEMBER, organizationId: ORG })).toBe(member.actorId);
    const authored = await d.select().from(messages).where(eq(messages.authorId, member.actorId));
    expect(authored).toHaveLength(1);

    // Put them back for the remaining tests.
    await d.insert(workspaceMemberships).values({
      workspaceId,
      userId: MEMBER,
      organizationId: ORG,
      role: 'member',
    });
  });
});
