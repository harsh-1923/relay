import { createCollection, type Row } from '@tanstack/db';
import { electricCollectionOptions } from '@tanstack/electric-db-collection';

import { persistedCollectionOptions, type Persistence } from '../persister';

/**
 * TanStack DB collections over Electric shapes.
 *
 * A collection is created per shape *instance* — `messages` for one conversation is a different
 * collection from `messages` for another — because a shape is a query and each has its own log
 * position. `collections.ts` is therefore a factory and a cache, not a module of singletons.
 *
 * Every collection points at our proxy, never at Electric. `electricCollectionOptions` takes a
 * URL and forwards `offset`, `handle` and `live` itself; the table, the where clause and the
 * secret are the proxy's business and are not expressible from here. That is deliberate: there
 * is no client-side API through which a shape could be widened.
 */

/** Row shapes, kept structural rather than imported from `@relay/schema`.
 *
 * Declared as type aliases rather than interfaces on purpose: Electric's row bound is
 * `Record<string, unknown>`, and only a type alias gets the implicit index signature that
 * satisfies it.
 *
 * The client sees what a shape sends — which is snake_case from Postgres, and for `messages` a
 * column allow-list rather than the whole table. Importing Drizzle's inferred types would claim
 * columns the proxy strips.
 */
/** What a `jsonb` column actually is on the wire. More honest than `unknown`, and it is what
 *  TanStack's row bound accepts. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type RoomRow = {
  id: string;
  workspace_id: string;
  organization_id: string;
  project_id: string | null;
  name: string;
  is_private: boolean;
  created_by: string;
  archived_at: string | null;
  created_at: string;
};

export type ActorRow = {
  id: string;
  organization_id: string;
  kind: 'human' | 'agent';
  user_id: string | null;
  agent_id: string | null;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
};

export type RoomMemberRow = {
  room_id: string;
  actor_id: string;
  workspace_id: string;
  organization_id: string;
  added_by: string | null;
  created_at: string;
};

export type ConversationRow = {
  id: string;
  workspace_id: string;
  organization_id: string;
  kind: 'main' | 'panel' | 'direct';
  visibility: 'shared' | 'private';
  room_id: string | null;
  created_by: string;
  sync_floor: string | null;
  archived_at: string | null;
  created_at: string;
};

export type PanelRow = {
  id: string;
  room_id: string;
  workspace_id: string;
  organization_id: string;
  kind: 'browser' | 'chat';
  visibility: 'shared' | 'private';
  conversation_id: string | null;
  created_by: string;
  config: Json;
  archived_at: string | null;
  created_at: string;
};

/** No `search_text`: the proxy's column allow-list strips it. */
export type MessageRow = {
  id: string;
  conversation_id: string;
  workspace_id: string;
  organization_id: string;
  author_id: string | null;
  parent_message_id: string | null;
  run_id: string | null;
  kind: 'message' | 'system';
  body: Json;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
};

export interface SyncConfigOptions {
  /** Where the shape proxy lives. Same origin in the browser; the shell's API base on desktop. */
  baseUrl: string;
  /**
   * Extra request headers. The browser needs none — it is same-origin and the sealed cookie
   * travels on its own — but the desktop shell holds its seal as a bearer token, so every
   * shape request has to carry it or the proxy answers 401 and the collection stays empty.
   *
   * Async, because that token lives in the main process and comes back over IPC.
   */
  headers?: () => Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
  /**
   * Local storage for synced rows. Absent means in-memory: correct, but a reload refetches and
   * an offline start shows nothing.
   *
   * Bumping `schemaVersion` discards the local copy and re-syncs. It is a property of the row
   * shape a shape sends, not of the Postgres schema — a column *added* to a shape is
   * backwards-compatible and needs no bump; one removed or retyped does.
   */
  persistence?: Persistence;
  schemaVersion?: number;
}

export type ShapeName =
  | 'actors'
  | 'room'
  | 'rooms'
  | 'roomMemberships'
  | 'roomMembers'
  | 'conversations'
  | 'panels'
  | 'messages';

/**
 * The whole contract between the client and the proxy: a shape name and its parameters.
 *
 * Exported so it can be asserted directly. There is deliberately no way to express a table, a
 * where clause, a column list or the secret from here — those are the proxy's, and a client
 * that could name them could widen its own shape.
 */
export function shapeUrl(
  opts: SyncConfigOptions,
  shape: ShapeName,
  params: Record<string, string>,
): string {
  const url = new URL(`/shapes/${shape}`, opts.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function shapeCollection<T extends Row>(
  opts: SyncConfigOptions,
  shape: ShapeName,
  params: Record<string, string>,
  getKey: (row: T) => string,
) {
  const id = `${shape}:${Object.values(params).join(':')}`;
  const electric = electricCollectionOptions<T>({
    id,
    getKey,
    shapeOptions: {
      url: shapeUrl(opts, shape, params),
      // The proxy authorises from the session, so the request must carry it. Same-origin in
      // the browser means the cookie rides along; desktop supplies a bearer.
      fetchClient: async (input, init) => {
        const extra = await opts.headers?.();
        return fetch(input, {
          ...init,
          credentials: 'include',
          headers: { ...init?.headers, ...extra },
        });
      },
    },
  });

  /**
   * Persistence **wraps** the sync source rather than replacing it, which is the property that
   * makes this reversible: the Electric options above are untouched, and swapping the engine
   * later changes them and nothing here.
   *
   * It also brings the Electric resume state along for free — the collection stores
   * `{offset, handle, shapeId}` in its metadata, so a relaunch continues the shape log instead
   * of re-reading it (H11).
   */
  if (!opts.persistence) return createCollection(electric);
  return createCollection(
    // The utils generic is passed through explicitly: without it the wrapper widens to a bare
    // `UtilsRecord` and Electric's `awaitTxId` / `awaitMatch` disappear from the collection —
    // which the write path (Phase 3) needs to reconcile an optimistic insert.
    persistedCollectionOptions<T, string | number, never, NonNullable<typeof electric.utils>>({
      ...electric,
      persistence: opts.persistence,
      schemaVersion: opts.schemaVersion ?? 1,
    }),
  );
}

/**
 * The collections a room needs, created together.
 *
 * Five shapes, because Electric covers one table per shape. They are created as a set because
 * they are torn down as a set: a room's subscriptions live and die together, and the registry
 * in `subscriptions.ts` is what guarantees that.
 */
export function roomCollections(opts: SyncConfigOptions, roomId: string) {
  return {
    room: shapeCollection<RoomRow>(opts, 'room', { roomId }, (r) => r.id),
    // Composite key: `room_members` has no single-column id, and TanStack needs one per row.
    members: shapeCollection<RoomMemberRow>(
      opts,
      'roomMembers',
      { roomId },
      (r) => `${r.room_id}:${r.actor_id}`,
    ),
    conversations: shapeCollection<ConversationRow>(opts, 'conversations', { roomId }, (r) => r.id),
    panels: shapeCollection<PanelRow>(opts, 'panels', { roomId }, (r) => r.id),
  };
}

export const messageCollection = (opts: SyncConfigOptions, conversationId: string) =>
  shapeCollection<MessageRow>(opts, 'messages', { conversationId }, (r) => r.id);

/** Org-scoped and identical for everyone in the org — the most shareable shape there is. */
export const actorCollection = (opts: SyncConfigOptions) =>
  shapeCollection<ActorRow>(opts, 'actors', {}, (r) => r.id);

/**
 * The room directory for a workspace, in two shapes rather than one.
 *
 * `rooms` is public rooms only — no subquery, identical for every workspace member, and
 * genuinely CDN-shareable. `roomMemberships` is which rooms (of any visibility) this actor
 * belongs to, room-id only. The client reconciles them: a private room the actor is in shows
 * up in the second shape but not the first, and its name comes from opening that room's own
 * `room` shape — cheap, and already the mechanism for opening a room at all.
 *
 * The alternative — one shape with `id IN (SELECT … FROM room_members …)` — was tried first
 * and dropped. Verified against a live self-hosted Electric 1.8.0: the subquery decomposes
 * into a dependent internal shape on `room_members`, and a membership row inserted immediately
 * before the request was still missing from the result after 1.5s and repeated polls. Not a
 * margin to design around.
 */
export const publicRoomsCollection = (opts: SyncConfigOptions, workspaceId: string) =>
  shapeCollection<RoomRow>(opts, 'rooms', { workspaceId }, (r) => r.id);

export type RoomMembershipRow = { room_id: string };

export const roomMembershipsCollection = (opts: SyncConfigOptions, workspaceId: string) =>
  shapeCollection<RoomMembershipRow>(opts, 'roomMemberships', { workspaceId }, (r) => r.room_id);

/**
 * Inferred rather than declared: `Collection` carries five type parameters that
 * `electricCollectionOptions` fixes for us, and restating them by hand only creates a second
 * place to be wrong.
 */
export type ShapeCollection<T extends Row> = ReturnType<typeof shapeCollection<T>>;
export type RoomCollections = ReturnType<typeof roomCollections>;
export type MessageCollection = ReturnType<typeof messageCollection>;
export type ActorCollection = ReturnType<typeof actorCollection>;
export type PublicRoomsCollection = ReturnType<typeof publicRoomsCollection>;
export type RoomMembershipsCollection = ReturnType<typeof roomMembershipsCollection>;
