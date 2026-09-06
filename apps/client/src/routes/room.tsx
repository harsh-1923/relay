import { eq, isNull } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { format } from 'date-fns';

import { useRoomParams } from '@/lib/paths';
import { useActorsSync, useMessagesSync, useRoomSync } from '@/lib/sync';

/**
 * A room, rendered from synced data.
 *
 * Every read here is a local query. Nothing in this file fetches: the shapes were subscribed
 * when the room was retained, and they stay subscribed after this component unmounts — so
 * coming back is instant and a room that changed while you were elsewhere is already right.
 *
 * The author join is why `actors` carries `display_name`: message → actor is one hop, on the
 * device, and `users` never leaves the server.
 */
export function Room() {
  const { roomId } = useRoomParams();
  const { room, members, conversations } = useRoomSync(roomId);
  const actors = useActorsSync();

  const { data: rooms } = useLiveQuery((q) => q.from({ room }));
  const current = rooms?.[0];

  // A room has exactly one central shared chat, enforced by a partial unique index.
  const { data: chats } = useLiveQuery((q) =>
    q.from({ c: conversations }).where(({ c }) => eq(c.kind, 'main')),
  );
  const main = chats?.[0];

  const messages = useMessagesSync(main?.id);
  // Returning null is the supported conditional form: there is no conversation to read until
  // the room's own shape has arrived.
  const { data: thread } = useLiveQuery(
    (q) =>
      messages
        ? q
            .from({ m: messages })
            .where(({ m }) => isNull(m.deleted_at))
            .orderBy(({ m }) => m.id)
        : null,
    [messages],
  );

  const { data: memberRows } = useLiveQuery((q) => q.from({ m: members }));
  const { data: actorRows } = useLiveQuery((q) => q.from({ a: actors }));
  const nameOf = (id: string | null) =>
    actorRows?.find((a) => a.id === id)?.display_name ?? 'Unknown';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border flex items-baseline gap-2 border-b px-5 py-3">
          <h1 className="truncate text-sm font-semibold">{current?.name ?? '…'}</h1>
          {current?.is_private ? (
            <span className="text-muted-foreground text-xs">private</span>
          ) : null}
        </header>

        <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {thread?.length ? (
            thread.map((m) => (
              <li key={m.id} className="text-sm">
                <span className="font-medium">
                  {m.kind === 'system' ? 'system' : nameOf(m.author_id)}
                </span>{' '}
                <span className="text-muted-foreground text-xs">
                  {format(new Date(m.created_at), 'h:mm:ss a')}
                </span>{' '}
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
            <li key={`${m.room_id}:${m.actor_id}`} className="truncate text-sm">
              {nameOf(m.actor_id)}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/**
 * `body` is a versioned block list. Until the block schema lands with the write path this
 * renders the plain-text case and says so for anything else, rather than guessing a shape.
 */
function renderBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'text' in body && typeof body.text === 'string') {
    return body.text;
  }
  return JSON.stringify(body);
}
