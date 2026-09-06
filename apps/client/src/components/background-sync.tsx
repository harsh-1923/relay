import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';

import { useMessagesSync, useRoomConversationsSync } from '@/lib/sync';

/**
 * Keeps the rooms you are *in* synced while you are looking at something else.
 *
 * Without this, a message shape is only subscribed by the room currently open, so a room
 * updated while you were elsewhere is stale when you arrive and empty when you arrive offline.
 * The subscription registry was built for exactly this — subscriptions independent of what is
 * rendered — and this is what actually uses it.
 *
 * Renders nothing. It exists to hold subscriptions, and it holds them for as long as the
 * sidebar is mounted rather than for as long as a room is on screen.
 */

/**
 * How many rooms stay warm, decided by the transport rather than by taste.
 *
 * Each warm room costs two open long-polls (its conversations shape, and its `main`
 * conversation's messages). Over HTTP/1.1 a browser allows about six connections per origin
 * in total — which the sidebar, `actors` and the open room have largely spent already — so
 * warming several rooms there does not make the app faster, it deadlocks it. Over HTTP/2 they
 * multiplex onto one connection and the limit stops mattering.
 *
 * `nextHopProtocol` is what the browser actually negotiated, so this reflects reality instead
 * of assuming: `RELAY_HTTPS=1 pnpm dev` locally, and HTTP/2 in any real deployment.
 */
function warmRoomBudget(): number {
  const nav = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  const http2 = nav?.nextHopProtocol === 'h2' || nav?.nextHopProtocol === 'h3';
  return http2 ? 5 : 1;
}

export function BackgroundSync({ roomIds }: { roomIds: string[] }) {
  const warm = roomIds.slice(0, warmRoomBudget());
  return (
    <>
      {warm.map((roomId) => (
        <WarmRoom key={roomId} roomId={roomId} />
      ))}
    </>
  );
}

/**
 * One room kept warm. A component per room rather than a loop calling hooks, for the same
 * reason `PrivateRoomEntry` is one: the hook count must not change with the room count.
 *
 * Two hops, because messages are keyed by conversation and the sidebar only knows rooms —
 * subscribe the room's conversations, find its `main`, then subscribe that conversation's
 * messages. Retaining the same conversation the open room is already using is free: the
 * registry refcounts, so the two holders share one subscription.
 */
function WarmRoom({ roomId }: { roomId: string }) {
  const conversations = useRoomConversationsSync(roomId);
  const { data } = useLiveQuery(
    (q) => q.from({ c: conversations }).where(({ c }) => eq(c.kind, 'main')),
    [conversations],
  );
  useMessagesSync(data?.[0]?.id);
  return null;
}
