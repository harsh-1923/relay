/**
 * Shape definitions — **server-side only**.
 *
 * Electric's HTTP API is public by default and exposes anything its database user can read, so
 * a client must never name a table or write a where clause. It names a *shape* from this
 * registry and supplies parameters; the proxy builds the query. That inversion is the whole
 * security model, and it is why this file exports data rather than accepting input.
 *
 * `scope` is what the proxy authorises against — it maps a shape to a question `access.ts`
 * already answers, so the read path and the authorisation cannot drift apart.
 */

/** The authorisation question a shape asks. */
export type ShapeScope = 'organization' | 'room' | 'conversation' | 'workspace';

export interface ShapeParams {
  organizationId: string;
  roomId?: string;
  conversationId?: string;
  workspaceId?: string;
  /** Server-resolved, never client-supplied — see `roomMemberships`'s comment. */
  actorId?: string;
}

export interface ShapeDefinition {
  table: string;
  scope: ShapeScope;
  /** Omitted means every column. Present means an allow-list. */
  columns?: readonly string[];
  where: (params: ShapeParams) => string;
}

/**
 * A UUID literal for a where clause.
 *
 * Every parameter reaching a where clause is a uuid, and this is the only place one is
 * interpolated — so validating the shape here is the injection boundary. Anything else throws
 * rather than producing a query, because a caller that has a non-uuid has a bug or is probing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new Error('shape parameter is not a uuid');
  return `'${value}'`;
}

/**
 * Organization ids are WorkOS's (`org_...`), not uuids, so they get their own guard rather
 * than a looser one shared with the uuid case.
 */
const ORG_ID = /^org_[A-Za-z0-9]{1,64}$/;
function orgId(value: string): string {
  if (!ORG_ID.test(value)) throw new Error('shape parameter is not an organization id');
  return `'${value}'`;
}

export const shapes = {
  /**
   * Everyone the client can render — people and agents alike. Org-scoped and identical for
   * every member of the org, so it is the most cache-shareable shape there is.
   */
  actors: {
    table: 'actors',
    scope: 'organization',
    where: (p) => `organization_id = ${orgId(p.organizationId)}`,
  },

  room: {
    table: 'rooms',
    scope: 'room',
    where: (p) => `id = ${uuid(p.roomId)}`,
  },

  roomMembers: {
    table: 'room_members',
    scope: 'room',
    where: (p) => `room_id = ${uuid(p.roomId)}`,
  },

  /**
   * Shared only. A private panel chat is a different shape, requested by id and authorised by
   * its own membership — so privacy is structural: non-members never request it, rather than a
   * filter having to remember to exclude it.
   */
  conversations: {
    table: 'conversations',
    scope: 'room',
    where: (p) => `room_id = ${uuid(p.roomId)} AND visibility = 'shared'`,
  },

  panels: {
    table: 'panels',
    scope: 'room',
    where: (p) => `room_id = ${uuid(p.roomId)} AND visibility = 'shared'`,
  },

  /** One private conversation, by id. Authorised by `conversation_members`. */
  conversation: {
    table: 'conversations',
    scope: 'conversation',
    where: (p) => `id = ${uuid(p.conversationId)}`,
  },

  /**
   * The public half of a workspace's room directory. **Deliberately no subquery.**
   *
   * A subquery *works* — self-hosted Electric decomposes `id IN (SELECT … FROM room_members
   * WHERE actor_id = …)` into a dependent internal shape on `room_members` and joins against
   * it — but verified against a live 1.8.0 instance, a room membership inserted immediately
   * before the request was still missing from the result after 1.5s and repeated polls. That
   * is not a timing margin to design around, so the private half is `roomMemberships` below
   * instead: a second, ordinary shape, joined client-side.
   *
   * The upside of the split is real, not just a workaround: this shape is now identical for
   * every member of the workspace, so it is the one thing in this file that gets genuine CDN
   * sharing — a per-actor where clause never would have.
   */
  rooms: {
    table: 'rooms',
    scope: 'workspace',
    where: (p) =>
      `workspace_id = ${uuid(p.workspaceId)} and archived_at is null and is_private = false`,
  },

  /**
   * The private half: which rooms in this workspace the viewer is a member of. Room-id only —
   * rendering a name means opening that room's own `room` shape (below), which is cheap,
   * per-room cacheable, and already exists for the room-open path.
   *
   * Per-actor, and the reason that is acceptable here is the same one `local-first.md` uses
   * for the membership directory: tens of rows, changing rarely. No workspace-membership gate
   * — a guest with no workspace membership still needs this to find the rooms they were
   * explicitly added to.
   */
  roomMemberships: {
    table: 'room_members',
    scope: 'workspace',
    // Electric requires every primary-key column in the allow-list, and this table's key is
    // (room_id, actor_id) — so actor_id is here too, even though the where clause already
    // pins it to one value and it carries no information the client didn't already have.
    columns: ['room_id', 'actor_id'],
    where: (p) => `actor_id = ${uuid(p.actorId)} and workspace_id = ${uuid(p.workspaceId)}`,
  },

  /**
   * `search_text` is excluded deliberately: it duplicates `body` on the wire for every message
   * and exists only for the server's `tsvector`. Clients derive their own text from the blocks.
   */
  messages: {
    table: 'messages',
    scope: 'conversation',
    columns: [
      'id',
      'conversation_id',
      'workspace_id',
      'organization_id',
      'author_id',
      'parent_message_id',
      'run_id',
      'kind',
      'body',
      'created_at',
      'edited_at',
      'deleted_at',
    ],
    where: (p) => `conversation_id = ${uuid(p.conversationId)}`,
  },
} as const satisfies Record<string, ShapeDefinition>;

export type ShapeName = keyof typeof shapes;

export const isShapeName = (name: string): name is ShapeName =>
  Object.prototype.hasOwnProperty.call(shapes, name);
