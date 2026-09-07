import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { createCollections, createDatabase, type Collections, type Database } from '@relay/sync';
import { bridge, detectPlatform } from '@relay/sync/platform';

import { apiUrl } from './api';

/**
 * The local database, and React's view of it.
 *
 * Much smaller than the Electric version this replaces, and deliberately: there is no
 * subscription registry, no per-shape collection cache and no retain/release discipline here,
 * because there is nothing to ration. Electric opened one long-poll per shape against a
 * six-connection budget, so *what was subscribed* had to be managed as a scarce resource.
 * PowerSync uses one connection for everything and the server's sync streams decide what
 * arrives, so the client's only job is to hold a database and hand out collections.
 *
 * Which rooms sync is therefore not decided here at all — `tooling/powersync/sync-config.yaml`
 * decides it, and it already covers every room you belong to whether or not it is on screen.
 */

interface Sync {
  db: Database;
  collections: Collections;
}

const SyncContext = createContext<Sync | null>(null);

/**
 * The same auth rule every other request follows, and the reason it is written out again
 * rather than reusing `authed()`: that helper parses JSON and reports `{ok, status, body}`,
 * while a connector needs the `Response` itself — `uploadData` must distinguish "server said
 * no" from "server was unreachable", and only the status can tell it.
 *
 * The browser is same-origin with the API and its sealed cookie travels on its own. The
 * desktop renderer is cross-origin to the API, so it sends the same seal as a bearer.
 */
async function syncFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (detectPlatform().session === 'bearer') {
    const token = await bridge()?.auth.token();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(apiUrl(path), { ...init, headers, credentials: 'include' });
}

/**
 * `accountKey` scopes the database file. Switching account must not read the previous one's
 * rows, and the cheapest way to guarantee that is a different file rather than a cleanup
 * routine that has to be correct.
 */
export function SyncProvider({
  children,
  accountKey,
}: {
  children: ReactNode;
  accountKey: string | null;
}) {
  const [sync, setSync] = useState<Sync | null>(null);

  const created = useMemo(() => {
    if (!accountKey) return null;
    const { db, connect } = createDatabase({
      filename: `relay-${accountKey}.db`,
      fetch: syncFetch,
    });
    return { db, connect, collections: createCollections(db) };
  }, [accountKey]);

  useEffect(() => {
    if (!created) {
      setSync(null);
      return;
    }
    let live = true;
    void created.connect().then(
      () => {
        if (live) setSync({ db: created.db, collections: created.collections });
      },
      (e: unknown) => {
        // Not fatal. Whatever is already on disk still renders, which is the whole point of
        // being local-first — a failure to reach the server is a stale app, not a broken one.
        console.error('[relay] sync could not connect:', e);
        if (live) setSync({ db: created.db, collections: created.collections });
      },
    );

    if (import.meta.env.DEV) {
      // Named well clear of `window.relay`, which is the Electron preload bridge — clobbering
      // that took the session's `auth.onChange` down with it once already.
      (window as unknown as { __relaySync: unknown }).__relaySync = {
        db: created.db,
        collections: created.collections,
        sql: (q: string, args: unknown[] = []) => created.db.getAll(q, args),
      };
    }

    return () => {
      live = false;
      void created.db.disconnect();
    };
  }, [created]);

  return <SyncContext.Provider value={sync}>{children}</SyncContext.Provider>;
}

/** Null until the database is open. Callers render their own empty state rather than
 *  suspending, because "no rows yet" and "not connected yet" look the same to a user. */
export function useSync(): Sync | null {
  return useContext(SyncContext);
}

export function useCollections(): Collections | null {
  return useContext(SyncContext)?.collections ?? null;
}
