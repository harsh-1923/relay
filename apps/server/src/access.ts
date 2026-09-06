import { and, eq } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  conversationMembers,
  conversations,
  roomMembers,
  rooms,
  workspaceMemberships,
  workspaces,
} from '@relay/schema';

type Db = PostgresJsDatabase<Record<string, unknown>> | PgTransaction<never, never, never>;

/**
 * Who may read what, below the workspace line.
 *
 * This sits in the shape proxy's hot path, so every check here is a **primary-key lookup and
 * never a join** (invariant 2). That is why `organization_id` and `workspace_id` are
 * denormalised onto tables that could derive them, and it is the constraint that decides the
 * whole shape of this module: read the row, then one indexed lookup.
 *
 * It only ever authorises humans. An agent never opens a shape — the agent service
 * authenticates as a service and each of its writes is authorised by the `runs` row it
 * references. An agent's `room_members` row makes it addressable and invokable there; it is
 * never the subject of a check in this file, and making it one would give agents ambient
 * access to rooms they were never invoked in.
 */

/**
 * The session (`{user_id, organization_id}`) plus the actor it resolves to.
 *
 * Both halves are needed and neither is redundant: `workspace_memberships` is keyed by
 * `user_id` because it predates actors and mirrors a WorkOS-shaped world, while everything
 * from rooms down is keyed by `actor_id`. Resolving the actor once per request and passing
 * it keeps that hop off the hot path.
 */
export interface Viewer {
  userId: string;
  organizationId: string;
  actorId: string;
}

/**
 * Two paths, chosen by `is_private`, both a single indexed lookup.
 *
 *   public  → `workspace_memberships (workspace_id, user_id)` — anyone in the workspace
 *   private → `room_members (room_id, actor_id)` — only those explicitly added
 *
 * A guest holds an org membership and no workspace membership, so they fail the public path
 * and pass the private one exactly when they were added. That is the whole guest model, and
 * it is why guests never needed FGA.
 *
 * There is deliberately no role check. A workspace admin gets no override into a private
 * room: access is decided at workspace and room level only (invariant 5), and reintroducing
 * a role here would put an FGA-shaped question back on the hot path.
 */
export async function mayReadRoom(d: Db, viewer: Viewer, roomId: string): Promise<boolean> {
  const [room] = await d
    .select({
      organizationId: rooms.organizationId,
      workspaceId: rooms.workspaceId,
      isPrivate: rooms.isPrivate,
    })
    .from(rooms)
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!room) return false;

  // The tenant check comes first and is why `organization_id` is on every row.
  if (room.organizationId !== viewer.organizationId) return false;

  if (!room.isPrivate) {
    const [member] = await d
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, room.workspaceId),
          eq(workspaceMemberships.userId, viewer.userId),
        ),
      )
      .limit(1);
    return !!member;
  }

  const [member] = await d
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, viewer.actorId)))
    .limit(1);
  return !!member;
}

/**
 * The same split one level down.
 *
 *   private → `conversation_members (conversation_id, actor_id)`
 *   shared  → whatever the room says
 *
 * A shared conversation deliberately has no membership row per room member: materialising
 * them would break "join a public room without permission" and amplify writes on every join.
 * So sharing delegates, and the delegation costs no extra round trip — the proxy has to read
 * the conversation row anyway to know which shape it is serving.
 *
 * A detached conversation (a DM, when those exist) has no room and is always private, so it
 * resolves entirely on the first branch.
 */
export async function mayReadConversation(
  d: Db,
  viewer: Viewer,
  conversationId: string,
): Promise<boolean> {
  const [conversation] = await d
    .select({
      organizationId: conversations.organizationId,
      visibility: conversations.visibility,
      roomId: conversations.roomId,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conversation) return false;
  if (conversation.organizationId !== viewer.organizationId) return false;

  if (conversation.visibility === 'private') {
    const [member] = await d
      .select({ actorId: conversationMembers.actorId })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.actorId, viewer.actorId),
        ),
      )
      .limit(1);
    return !!member;
  }

  return conversation.roomId ? mayReadRoom(d, viewer, conversation.roomId) : false;
}

/**
 * Whether an agent may be invoked in a room.
 *
 * Not a read check and not on the shape path — this is asserted where a run is enqueued. It
 * bounds an agent to the rooms it was deliberately added to, so removing it from a room stops
 * future invocations without touching a credential.
 */
/**
 * The workspace half of D3's union — a boolean, not a list. The room-directory shape encodes
 * the list itself; this is what the proxy needs first, to decide which branch of that where
 * clause a viewer gets. Same primary-key lookup `mayReadRoom`'s public path already does.
 */
export async function isWorkspaceMember(
  d: Db,
  viewer: Viewer,
  workspaceId: string,
): Promise<boolean> {
  const [member] = await d
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, viewer.userId),
      ),
    )
    .limit(1);
  return !!member;
}

/** Whether a workspace belongs to the viewer's organization — the room-directory shape's only
 *  gate beyond membership, since the where clause itself does the rest. */
export async function workspaceInOrg(d: Db, viewer: Viewer, workspaceId: string): Promise<boolean> {
  const [ws] = await d
    .select({ organizationId: workspaces.organizationId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return !!ws && ws.organizationId === viewer.organizationId;
}

export async function mayInvokeIn(d: Db, roomId: string, agentActorId: string): Promise<boolean> {
  const [member] = await d
    .select({ actorId: roomMembers.actorId })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.actorId, agentActorId)))
    .limit(1);
  return !!member;
}
