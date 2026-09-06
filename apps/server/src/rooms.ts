import { and, eq, isNull } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { conversationMembers, conversations, panels, roomMembers, rooms } from '@relay/schema';

type Db = PostgresJsDatabase<Record<string, unknown>> | PgTransaction<never, never, never>;

/**
 * Ours. Rooms, their one central shared chat, and their membership.
 *
 * Every write here is a transaction because a room's parts are unreachable apart: a room with
 * no chat has nothing to render, a room with no members has nobody who can archive it, and an
 * archive that stamps three of four tables leaves a shared panel wrapping a private
 * conversation. Same reasoning as `createDefaultWorkspace`.
 */

/** The `rooms_workspace_name_key` violation, named so a caller can tell it from a failure. */
export class RoomNameTakenError extends Error {
  constructor(readonly name_: string) {
    super(`A room called "${name_}" already exists in this workspace`);
    this.name = 'RoomNameTakenError';
  }
}

/**
 * Drizzle wraps the driver error, so the constraint name is on the `cause` rather than on
 * what is thrown: `DrizzleQueryError -> PostgresError(constraint_name)`. Walk the chain
 * rather than reading the top, which silently never matches.
 */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  for (
    let c = e as { cause?: unknown; constraint_name?: string } | undefined;
    c;
    c = c.cause as typeof c
  ) {
    if (c.constraint_name === constraint) return true;
  }
  return false;
}

/**
 * A room, its `main` conversation, and its creator's membership — in one transaction.
 *
 * The creator gets a `room_members` row even for a public room, where it grants nothing:
 * membership there means *joined*, and the person who made the room has joined it.
 */
export async function createRoom(
  d: Db,
  {
    workspaceId,
    organizationId,
    name,
    createdBy,
    isPrivate = false,
  }: {
    workspaceId: string;
    organizationId: string;
    name: string;
    createdBy: string;
    isPrivate?: boolean;
  },
) {
  try {
    return await (d as PostgresJsDatabase<Record<string, unknown>>).transaction(async (tx) => {
      const [room] = await tx
        .insert(rooms)
        .values({ workspaceId, organizationId, name, isPrivate, createdBy })
        .returning();

      const [conversation] = await tx
        .insert(conversations)
        .values({
          workspaceId,
          organizationId,
          kind: 'main',
          visibility: 'shared',
          roomId: room!.id,
          createdBy,
        })
        .returning();

      await tx
        .insert(roomMembers)
        .values({ roomId: room!.id, actorId: createdBy, workspaceId, organizationId })
        .onConflictDoNothing();

      return { room: room!, conversation: conversation! };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'rooms_workspace_name_key')) throw new RoomNameTakenError(name);
    throw e;
  }
}

/**
 * Add someone — a person or an agent — to a room.
 *
 * The tenancy columns come from the room rather than the caller, so a mismatched
 * `workspace_id` cannot be passed in. An agent's row is also what makes it invokable here,
 * which is checked where runs are enqueued and never on the read path.
 */
export async function addRoomMember(
  d: Db,
  { roomId, actorId, addedBy }: { roomId: string; actorId: string; addedBy?: string },
): Promise<void> {
  const [room] = await d
    .select({ workspaceId: rooms.workspaceId, organizationId: rooms.organizationId })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room) throw new Error(`addRoomMember: no room ${roomId}`);

  await d
    .insert(roomMembers)
    .values({
      roomId,
      actorId,
      workspaceId: room.workspaceId,
      organizationId: room.organizationId,
      addedBy: addedBy ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Remove someone from a room, archiving what was theirs alone.
 *
 * Their private panel chats are archived rather than deleted: the messages are a record of
 * work, the person may be added back, and nothing about leaving a room says the conversation
 * should stop existing. A shared conversation is untouched — it belongs to the room.
 */
export async function removeRoomMember(
  d: Db,
  { roomId, actorId }: { roomId: string; actorId: string },
): Promise<void> {
  await (d as PostgresJsDatabase<Record<string, unknown>>).transaction(async (tx) => {
    await tx
      .delete(roomMembers)
      .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, actorId)));

    const theirs = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.roomId, roomId),
          eq(conversations.visibility, 'private'),
          eq(conversations.createdBy, actorId),
          isNull(conversations.archivedAt),
        ),
      );
    if (!theirs.length) return;

    const now = new Date();
    for (const c of theirs) {
      await tx.update(conversations).set({ archivedAt: now }).where(eq(conversations.id, c.id));
      await tx.update(panels).set({ archivedAt: now }).where(eq(panels.conversationId, c.id));
      await tx
        .delete(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, c.id),
            eq(conversationMembers.actorId, actorId),
          ),
        );
    }
  });
}

/**
 * Archive a room and everything in it — the creator's one privileged act.
 *
 * Reversible and destructive of nothing, which is why it needs no role table: the check is a
 * column comparison, not a permission. Returns false rather than throwing when someone else
 * asks, so a caller can render "you cannot archive this" without catching.
 *
 * The cascade is the point. A room is a container; leaving its conversations and panels
 * unstamped would show an archived room's panels in a strip that no longer has a room.
 */
export async function archiveRoom(
  d: Db,
  { roomId, actorId }: { roomId: string; actorId: string },
): Promise<boolean> {
  return (d as PostgresJsDatabase<Record<string, unknown>>).transaction(async (tx) => {
    const [room] = await tx
      .select({ createdBy: rooms.createdBy })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!room || room.createdBy !== actorId) return false;

    const now = new Date();
    await tx.update(rooms).set({ archivedAt: now }).where(eq(rooms.id, roomId));
    await tx.update(conversations).set({ archivedAt: now }).where(eq(conversations.roomId, roomId));
    await tx.update(panels).set({ archivedAt: now }).where(eq(panels.roomId, roomId));
    return true;
  });
}

/** The inverse, on the same terms. A room archived by its creator is unarchived by them. */
export async function unarchiveRoom(
  d: Db,
  { roomId, actorId }: { roomId: string; actorId: string },
): Promise<boolean> {
  return (d as PostgresJsDatabase<Record<string, unknown>>).transaction(async (tx) => {
    const [room] = await tx
      .select({ createdBy: rooms.createdBy })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (!room || room.createdBy !== actorId) return false;

    await tx.update(rooms).set({ archivedAt: null }).where(eq(rooms.id, roomId));
    await tx
      .update(conversations)
      .set({ archivedAt: null })
      .where(eq(conversations.roomId, roomId));
    await tx.update(panels).set({ archivedAt: null }).where(eq(panels.roomId, roomId));
    return true;
  });
}

/**
 * Promote a private panel chat into the room.
 *
 * Two rows, and no message touched — which is the whole reason placement lives on the
 * conversation rather than on every message. Both must move together or a shared panel wraps
 * a private conversation, so they share a transaction.
 *
 * The conversation stays `kind = 'panel'`: a room has exactly one central shared chat, and a
 * promoted thread becomes another tab beside it rather than a second one.
 */
export async function promoteConversation(
  d: Db,
  { conversationId, actorId }: { conversationId: string; actorId: string },
): Promise<boolean> {
  return (d as PostgresJsDatabase<Record<string, unknown>>).transaction(async (tx) => {
    const [conversation] = await tx
      .select({ createdBy: conversations.createdBy, visibility: conversations.visibility })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation || conversation.createdBy !== actorId) return false;
    if (conversation.visibility === 'shared') return true;

    await tx
      .update(conversations)
      .set({ visibility: 'shared' })
      .where(eq(conversations.id, conversationId));
    await tx
      .update(panels)
      .set({ visibility: 'shared' })
      .where(eq(panels.conversationId, conversationId));
    return true;
  });
}
