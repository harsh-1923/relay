import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  actorCollection,
  createRegistry,
  electronPersistence,
  messageCollection,
  publicRoomsCollection,
  roomCollections,
  roomMembershipsCollection,
  type ActorCollection,
  type MessageCollection,
  type PublicRoomsCollection,
  type RoomCollections,
  type RoomMembershipsCollection,
  type SyncConfigOptions,
} from '@relay/sync';
import { bridge, detectPlatform } from '@relay/sync/platform';

/**
 * The bridge between the subscription registry and React.
 *
 * The registry lives outside the tree deliberately — a room's subscription must outlive the
 * component showing it, so that switching rooms is a local query rather than a fetch, and a
 * room updated while you were elsewhere is already correct when you arrive. React's job here
 * is only to say *who still cares*; the registry decides what stays open.
 *
 * Collections are cached alongside their subscription, so two components asking for the same
 * room get the same collection instance and the same rows.
 */

interface SyncApi {
  /** Retain a room's collections for the lifetime of the caller. */
  room: (roomId: string) => RoomCollections;
  messages: (conversationId: string) => MessageCollection;
  actors: () => ActorCollection;
  publicRooms: (workspaceId: string) => PublicRoomsCollection;
  roomMemberships: (workspaceId: string) => RoomMembershipsCollection;
  /** Retain/release, exposed for the hooks below. */
  retain: (key: string, create: () => () => void) => () => void;
  clear: () => void;
}

const SyncContext = createContext<SyncApi | null>(null);

export function SyncProvider({ children, baseUrl }: { children: ReactNode; baseUrl?: string }) {
  const api = useMemo<SyncApi>(() => {
    const registry = createRegistry();
    /**
     * Persistence is resolved from the platform, not chosen here (invariant 10). On desktop
     * the shell exposes an `invoke` and rows land in SQLite; in the browser there is no
     * bridge, so collections are in-memory — correct, but a reload refetches.
     */
    const opts: SyncConfigOptions = {
      baseUrl: baseUrl ?? window.location.origin,
      persistence: electronPersistence(bridge()?.persistence),
      /**
       * The same rule `authed()` follows for every other request: the browser's cookie travels
       * on its own, the desktop shell's seal does not. Without this a shape request from the
       * shell is unauthenticated, the proxy answers 401, and every collection sits empty —
       * which looks exactly like "this workspace has no rooms".
       */
      headers: async () => {
        if (detectPlatform().session !== 'bearer') return undefined;
        const token = await bridge()?.auth.token();
        return token ? { Authorization: `Bearer ${token}` } : undefined;
      },
    };
    const cache = new Map<string, unknown>();

    const cached = <T,>(key: string, make: () => T): T => {
      if (!cache.has(key)) cache.set(key, make());
      return cache.get(key) as T;
    };

    /**
     * In development, hand the collections to the console.
     *
     * There is no local database to open yet — collections are in memory until Phase 4 wraps
     * them in `persistedCollectionOptions` — so this is the only way to answer "what does the
     * client actually hold". `__relaySync.dump()` prints every collection and its rows.
     *
     * Named to stay well clear of `window.relay`, which is the Electron preload bridge —
     * clobbering it took the session's `auth.onChange` down with it, and the shell crashed on
     * mount. A debug handle must never share a name with something the app reads.
     */
    if (import.meta.env.DEV) {
      (window as unknown as { __relaySync: unknown }).__relaySync = {
        collections: cache,
        subscriptions: () => registry.keys(),
        dump: () => {
          // A `room:` entry is four collections, everything else is one — flatten both.
          const isCollection = (
            v: unknown,
          ): v is { id: string; size: number; toArray: unknown[] } =>
            typeof v === 'object' && v !== null && 'toArray' in v && 'size' in v;

          for (const entry of cache.values()) {
            const collections = isCollection(entry) ? [entry] : Object.values(entry as object);
            for (const c of collections) {
              if (!isCollection(c)) continue;
              // eslint-disable-next-line no-console
              console.log(`${c.id} · ${c.size} row(s)`, c.toArray);
            }
          }
        },
      };
    }

    return {
      room: (roomId) => cached(`room:${roomId}`, () => roomCollections(opts, roomId)),
      messages: (conversationId) =>
        cached(`messages:${conversationId}`, () => messageCollection(opts, conversationId)),
      actors: () => cached('actors', () => actorCollection(opts)),
      publicRooms: (workspaceId) =>
        cached(`publicRooms:${workspaceId}`, () => publicRoomsCollection(opts, workspaceId)),
      roomMemberships: (workspaceId) =>
        cached(`roomMemberships:${workspaceId}`, () =>
          roomMembershipsCollection(opts, workspaceId),
        ),
      retain: (key, create) => registry.retain(key, create),
      clear: () => {
        registry.clear();
        cache.clear();
      },
    };
  }, [baseUrl]);

  // A sign-out or account switch must not leave another account's shapes polling.
  useEffect(() => () => api.clear(), [api]);

  return <SyncContext.Provider value={api}>{children}</SyncContext.Provider>;
}

/**
 * Keep collections syncing for as long as someone holds them.
 *
 * A subscription is what makes a TanStack DB collection *active*: it starts syncing when it
 * gains its first subscriber and starts its GC timer when it loses the last. So holding an
 * empty subscription is exactly "keep this alive", and dropping it hands the collection back
 * to its own lifecycle.
 *
 * **Not `cleanup()`.** That tears a collection down permanently, and these instances are
 * cached and reused — so under StrictMode's double-invoke the first release destroyed the
 * instance the second retain then handed to React. The symptom was a room that rendered its
 * chrome and nothing else, with the shape never requested at all.
 *
 * Also where sync activity gets logged in development: every row a collection receives — the
 * initial snapshot, a live update while you're looking elsewhere, an optimistic write once
 * Phase 3 lands — passes through this same callback, so it is the one place to watch to see
 * that a shape is actually streaming rather than sitting empty.
 */
function hold(
  collections: Array<{
    id: string;
    subscribeChanges: (
      cb: (changes: Array<{ type: string; key: unknown; value?: unknown }>) => void,
    ) => { unsubscribe: () => void };
  }>,
) {
  const subs = collections.map((c) =>
    c.subscribeChanges((changes) => {
      if (!import.meta.env.DEV) return;
      for (const change of changes) {
        // eslint-disable-next-line no-console
        console.log(`[relay:sync] ${c.id} · ${change.type}`, change.value ?? change.key);
      }
    }),
  );
  return () => subs.forEach((s) => s.unsubscribe());
}

function useSync(): SyncApi {
  const api = useContext(SyncContext);
  if (!api) throw new Error('useSync() used outside <SyncProvider>');
  return api;
}

/**
 * Subscribe to a room, and keep it subscribed while this component is mounted.
 *
 * The subscription is retained rather than created: a remount, or a second component showing
 * the same room, shares one set of shapes instead of tearing down and re-establishing five.
 */
export function useRoomSync(roomId: string) {
  const api = useSync();
  const collections = api.room(roomId);
  useEffect(
    () => api.retain(`room:${roomId}`, () => hold(Object.values(collections))),
    [api, roomId, collections],
  );
  return collections;
}

export function useMessagesSync(conversationId: string | undefined) {
  const api = useSync();
  const collection = conversationId ? api.messages(conversationId) : undefined;

  useEffect(() => {
    if (!conversationId || !collection) return;
    return api.retain(`messages:${conversationId}`, () => hold([collection]));
  }, [api, conversationId, collection]);

  return collection;
}

/**
 * Everyone the client can render, org-scoped.
 *
 * Retained at the app level rather than per room: it is the same shape for every member of the
 * organization, and dropping it on every navigation would refetch what never changed.
 */
export function useActorsSync() {
  const api = useSync();
  const collection = api.actors();
  useEffect(() => api.retain('actors', () => hold([collection])), [api, collection]);
  return collection;
}

/**
 * The room directory for the sidebar — two independent subscriptions, distinct from
 * `room`/`messages` above. Opening the sidebar should not open a room's five shapes, and
 * vice versa.
 */
export function usePublicRoomsSync(workspaceId: string | undefined) {
  const api = useSync();
  const collection = workspaceId ? api.publicRooms(workspaceId) : undefined;
  useEffect(() => {
    if (!workspaceId || !collection) return;
    return api.retain(`publicRooms:${workspaceId}`, () => hold([collection]));
  }, [api, workspaceId, collection]);
  return collection;
}

export function useRoomMembershipsSync(workspaceId: string | undefined) {
  const api = useSync();
  const collection = workspaceId ? api.roomMemberships(workspaceId) : undefined;
  useEffect(() => {
    if (!workspaceId || !collection) return;
    return api.retain(`roomMemberships:${workspaceId}`, () => hold([collection]));
  }, [api, workspaceId, collection]);
  return collection;
}

/**
 * Just a room's conversations — for background sync, which needs to find a room's `main`
 * conversation in order to subscribe its messages, and nothing else about the room.
 */
export function useRoomConversationsSync(roomId: string) {
  const { conversations } = useSync().room(roomId);
  const api = useSync();
  useEffect(
    () => api.retain(`room:${roomId}:conversations`, () => hold([conversations])),
    [api, roomId, conversations],
  );
  return conversations;
}

/**
 * Just a room's own row — for a directory entry that needs a name, not the five shapes a
 * fully open room needs. `useRoomSync` retains all five; this retains one.
 */
export function useRoomHeaderSync(roomId: string) {
  const api = useSync();
  const { room } = api.room(roomId);
  useEffect(() => api.retain(`room:${roomId}:header`, () => hold([room])), [api, roomId, room]);
  return room;
}

/** Whether a collection has produced its first snapshot — for a one-time skeleton, not a spinner
 *  on every change. */
export function useReady(collection: { status?: string } | undefined) {
  const [ready, setReady] = useState(false);
  const seen = useRef(false);
  useEffect(() => {
    if (seen.current || !collection) return;
    if (collection.status === 'ready') {
      seen.current = true;
      setReady(true);
    }
  });
  return ready;
}
