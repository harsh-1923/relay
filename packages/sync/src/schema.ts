import { column, Schema, Table } from '@powersync/common';
import { z } from 'zod';

/**
 * The local database, as SQLite sees it.
 *
 * Declared once and consumed by both surfaces — `@powersync/node` in the Electron main
 * process and `@powersync/web` in the browser — so a query written against it means the same
 * thing on a desktop app and in a tab. That shared declaration is most of the reason
 * `packages/persist-idb` no longer needs to exist.
 *
 * **This is not `packages/schema`, and it is deliberately narrower.** That package is the
 * Postgres schema and the source of truth; this is the projection of it that
 * `tooling/powersync/sync-config.yaml` actually delivers to a device. Columns a stream never
 * sends are absent here, and their absence is the point: `messages.search_text` is a server-side
 * search index, and a device that never receives it cannot leak it.
 *
 * SQLite has three storage classes and PowerSync exposes exactly those, so the mapping is
 * lossy in ways worth stating once rather than rediscovering per column:
 *
 *   uuid, text, timestamptz  → column.text     (timestamps arrive as ISO 8601 strings)
 *   boolean                  → column.integer  (0 or 1, never a JS boolean)
 *   jsonb                    → column.text     (serialised; parse at the edge)
 *
 * `id` is implicit. PowerSync gives every table a text primary key of that name and it must
 * not be declared — which is why `room_members` and `conversation_members` grew a surrogate
 * `id` in `20260906223042_membership_surrogate_keys.sql`, having been keyed on a pair before.
 *
 * Adding a column here without adding it to a stream query gives every row a silent null.
 * Adding it to a stream without adding it here syncs bytes nothing can read. The two files
 * are edited together.
 */
export const AppSchema = new Schema({
  actors: new Table({
    organization_id: column.text,
    kind: column.text,
    user_id: column.text,
    agent_id: column.text,
    display_name: column.text,
    avatar_url: column.text,
    created_at: column.text,
  }),

  rooms: new Table({
    workspace_id: column.text,
    organization_id: column.text,
    project_id: column.text,
    name: column.text,
    is_private: column.integer,
    created_by: column.text,
    archived_at: column.text,
    created_at: column.text,
  }),

  room_members: new Table({
    room_id: column.text,
    actor_id: column.text,
    workspace_id: column.text,
    organization_id: column.text,
    added_by: column.text,
    created_at: column.text,
  }),

  conversations: new Table({
    workspace_id: column.text,
    organization_id: column.text,
    kind: column.text,
    visibility: column.text,
    room_id: column.text,
    created_by: column.text,
    sync_floor: column.text,
    archived_at: column.text,
    created_at: column.text,
  }),

  conversation_members: new Table({
    conversation_id: column.text,
    actor_id: column.text,
    workspace_id: column.text,
    organization_id: column.text,
    created_at: column.text,
  }),

  /** No `search_text` — see above. It is a server-side index and never leaves the server. */
  messages: new Table({
    conversation_id: column.text,
    workspace_id: column.text,
    organization_id: column.text,
    author_id: column.text,
    parent_message_id: column.text,
    run_id: column.text,
    kind: column.text,
    body: column.text,
    created_at: column.text,
    edited_at: column.text,
    deleted_at: column.text,
  }),

  panels: new Table({
    room_id: column.text,
    workspace_id: column.text,
    organization_id: column.text,
    kind: column.text,
    visibility: column.text,
    conversation_id: column.text,
    created_by: column.text,
    config: column.text,
    archived_at: column.text,
    created_at: column.text,
  }),
});

export type AppDatabase = (typeof AppSchema)['types'];

/**
 * The stream names `sync-config.yaml` defines, as a type rather than a string at each call
 * site. Only `room` takes a parameter; the rest carry `auto_subscribe: true` and are already
 * running by the time the client asks for anything.
 */
export const streams = {
  /** A public room the viewer has not joined — the one on-demand subscription. */
  room: 'room',
} as const;

/**
 * The same tables again, as Zod.
 *
 * Redundant-looking and not: `powerSyncCollectionOptions` infers a collection's row type from
 * the PowerSync `Table` by mapping over an internal `columnMap`, and the alpha collection
 * package expects a shape that `@powersync/common@2.2.0` does not expose — so every column
 * resolved to nothing and a query could only see `id`. Passing a schema makes the row type
 * `InferSchemaOutput` instead, which is ours and therefore stable across their versions.
 *
 * It also buys the validation their docs insist on: rows arriving from sync are *not*
 * validated unless a schema says how, and a column that silently changes shape is a bug that
 * surfaces far from its cause.
 *
 * Types are SQLite's, faithfully — `.nullable()` everywhere because every column except `id`
 * is nullable locally, and `is_private` is a number because SQLite has no boolean. Mapping
 * those into richer JavaScript types is a later change; doing it here would need matching
 * `serializer` entries for the write path.
 */
const text = () => z.string().nullable();
const int = () => z.number().nullable();

export const rowSchemas = {
  actors: z.object({
    id: z.string(),
    organization_id: text(),
    kind: text(),
    user_id: text(),
    agent_id: text(),
    display_name: text(),
    avatar_url: text(),
    created_at: text(),
  }),
  rooms: z.object({
    id: z.string(),
    workspace_id: text(),
    organization_id: text(),
    project_id: text(),
    name: text(),
    is_private: int(),
    created_by: text(),
    archived_at: text(),
    created_at: text(),
  }),
  room_members: z.object({
    id: z.string(),
    room_id: text(),
    actor_id: text(),
    workspace_id: text(),
    organization_id: text(),
    added_by: text(),
    created_at: text(),
  }),
  conversations: z.object({
    id: z.string(),
    workspace_id: text(),
    organization_id: text(),
    kind: text(),
    visibility: text(),
    room_id: text(),
    created_by: text(),
    sync_floor: text(),
    archived_at: text(),
    created_at: text(),
  }),
  conversation_members: z.object({
    id: z.string(),
    conversation_id: text(),
    actor_id: text(),
    workspace_id: text(),
    organization_id: text(),
    created_at: text(),
  }),
  messages: z.object({
    id: z.string(),
    conversation_id: text(),
    workspace_id: text(),
    organization_id: text(),
    author_id: text(),
    parent_message_id: text(),
    run_id: text(),
    kind: text(),
    body: text(),
    created_at: text(),
    edited_at: text(),
    deleted_at: text(),
  }),
  panels: z.object({
    id: z.string(),
    room_id: text(),
    workspace_id: text(),
    organization_id: text(),
    kind: text(),
    visibility: text(),
    conversation_id: text(),
    created_by: text(),
    config: text(),
    archived_at: text(),
    created_at: text(),
  }),
} as const;

export type RoomRow = z.infer<(typeof rowSchemas)['rooms']>;
export type MessageRow = z.infer<(typeof rowSchemas)['messages']>;
export type ActorRow = z.infer<(typeof rowSchemas)['actors']>;
