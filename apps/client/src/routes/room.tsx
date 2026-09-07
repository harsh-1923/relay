import { and, eq, isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { format } from 'date-fns';

import { useRoomParams } from '@/lib/paths';
import { useCollections } from '@/lib/sync';

/**
 * A room, rendered entirely from local SQLite.
 *
 * Nothing here fetches. The sync streams put every room this actor belongs to on the device
 * before this component existed, so opening a room is a query against data already present —
 * which is why it is instant, and why it still works with the network off.
 *
 * The author lookup is why `actors` carries `display_name`: message → actor is one hop on the
 * device, and `users` (which holds emails) never leaves the server.
 */
export function Room() {
  const { roomId } = useRoomParams();
  const c = useCollections();

  const { data: rooms } = useLiveQuery(
    (q) => (c ? q.from({ r: c.rooms }).where(({ r }) => eq(r.id, roomId)) : null),
    [c, roomId],
  );
  const room = rooms?.[0];

  // A room has exactly one central shared chat, enforced by a partial unique index.
  const { data: chats } = useLiveQuery(
    (q) =>
      c
        ? q
            .from({ v: c.conversations })
            .where(({ v }) => and(eq(v.room_id, roomId), eq(v.kind, 'main')))
        : null,
    [c, roomId],
  );
  const main = chats?.[0];

  const { data: thread } = useLiveQuery(
    (q) =>
      c && main
        ? q
            .from({ m: c.messages })
            .where(({ m }) => and(eq(m.conversation_id, main.id), isNull(m.deleted_at)))
            // UUIDv7, so id order is chronological order and no second column is needed.
            .orderBy(({ m }) => m.id)
        : null,
    [c, main?.id],
  );

  const { data: memberRows } = useLiveQuery(
    (q) => (c ? q.from({ m: c.roomMembers }).where(({ m }) => eq(m.room_id, roomId)) : null),
    [c, roomId],
  );
  const { data: actorRows } = useLiveQuery((q) => (c ? q.from({ a: c.actors }) : null), [c]);

  const nameOf = (id: string | null) =>
    actorRows?.find((a) => a.id === id)?.display_name ?? 'Unknown';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border flex items-baseline gap-2 border-b px-5 py-3">
          <h1 className="truncate text-sm font-semibold">{room?.name ?? '…'}</h1>
          {room?.is_private ? <span className="text-muted-foreground text-xs">private</span> : null}
        </header>

        <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {thread?.length ? (
            thread.map((m) => (
              <li key={m.id} className="text-sm">
                <span className="font-medium">
                  {m.kind === 'system' ? 'system' : nameOf(m.author_id)}
                </span>{' '}
                {m.created_at ? (
                  <span className="text-muted-foreground text-xs">
                    {format(new Date(m.created_at), 'h:mm:ss a')}
                  </span>
                ) : null}{' '}
                <span className="text-muted-foreground">{renderBody(m.body)}</span>
              </li>
            ))
          ) : (
            <li className="text-muted-foreground text-sm">No messages yet.</li>
          )}
        </ol>
      </div>

      <aside className="border-border w-56 shrink-0 border-l px-4 py-4">
        <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          Members · {memberRows?.length ?? 0}
        </h2>
        <ul className="space-y-1">
          {memberRows?.map((m) => (
            <li key={m.id} className="truncate text-sm">
              {nameOf(m.actor_id)}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/**
 * `body` is jsonb in Postgres and therefore a JSON *string* in SQLite. Until the block schema
 * lands with the rich editor this renders the plain-text case and shows the raw value for
 * anything else, rather than guessing at a shape it does not yet know.
 */
function renderBody(body: string | null): string {
  if (!body) return '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'text' in parsed) {
      const { text } = parsed as { text?: unknown };
      if (typeof text === 'string') return text;
    }
    return body;
  } catch {
    return body;
  }
}
