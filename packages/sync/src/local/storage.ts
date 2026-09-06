import { transitions, type Strip, type Tab } from './tabs';

/**
 * Where the tab strip is kept between runs.
 *
 * Local-only state, which the architecture separates sharply from synced state: synced
 * collections are derived and get rebuilt on a schema bump, while this "cannot be rebuilt"
 * and gets real migrations instead. Hence the version on the stored envelope — when the shape
 * changes, the migration reads the old version rather than the data being silently dropped.
 *
 * The interface is two functions on purpose. Phase 4 replaces the implementation with the
 * `ui_state` / `tabs` tables behind `persist-sqlite`, and neither the reducer nor the strip UI
 * should notice. Until then a `localStorage` implementation carries it — the same trade the
 * plan names, and the reason nothing above here knows which is in use.
 *
 * See `docs/plans/navigation.md` (D7, D9, step 6).
 */

/**
 * The strip is scoped to exactly what the session pins — account and organization — and to
 * nothing else. Workspace is not in the session, so it is not in the key either.
 */
export interface StripKey {
  accountId: string;
  organizationId: string;
}

const VERSION = 1;

/**
 * Ids are opaque, so they are encoded rather than trusted not to contain the separator — and
 * the separator is `:` because `encodeURIComponent` escapes it. A `.` would not have been
 * escaped, so `("a.b", "c")` and `("a", "b.c")` would name the same strip.
 */
export const keyOf = (key: StripKey): string =>
  `relay:tabs:v${VERSION}:${encodeURIComponent(key.accountId)}:${encodeURIComponent(key.organizationId)}`;

export interface StripStore {
  /** Null when nothing usable is stored — the caller opens its default rather than an empty strip. */
  load(key: StripKey): Strip | null;
  save(key: StripKey, strip: Strip): void;
}

interface Envelope {
  version: number;
  tabs: unknown;
  activeId: unknown;
}

/**
 * A stored tab is only as trustworthy as the disk it came from: an older build wrote it, or
 * something edited it. `location` is checked against the same rule the shell applies to a
 * deep link, because a persisted path is followed on the next launch without anyone asking.
 */
const isTab = (value: unknown): value is Tab => {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    t.id !== '' &&
    typeof t.location === 'string' &&
    t.location.startsWith('/') &&
    !t.location.startsWith('//') &&
    typeof t.title === 'string' &&
    typeof t.pinned === 'boolean'
  );
};

/**
 * Takes what is usable and discards the rest, rather than refusing the whole strip over one
 * bad row — losing every tab because one was malformed is the worse failure.
 *
 * Restores the two invariants the reducer maintains and readers rely on: pinned tabs sort
 * first, and `activeId` names a tab that is actually present.
 */
export function reviveStrip(raw: unknown): Strip | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const envelope = raw as Partial<Envelope>;
  // An unrecognised version is discarded for now. When the shape changes, this is where the
  // migration goes — the version is recorded so that stays possible.
  if (envelope.version !== VERSION) return null;
  if (!Array.isArray(envelope.tabs)) return null;

  const seen = new Set<string>();
  const tabs = envelope.tabs.filter((t): t is Tab => {
    if (!isTab(t) || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  if (tabs.length === 0) return null;

  const ordered = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  const activeId =
    typeof envelope.activeId === 'string' && ordered.some((t) => t.id === envelope.activeId)
      ? envelope.activeId
      : ordered[0]!.id;

  return { tabs: ordered, activeId };
}

const serialize = (strip: Strip): string =>
  JSON.stringify({ version: VERSION, tabs: strip.tabs, activeId: strip.activeId });

/** For tests, and for a surface where persistent storage is unavailable or refused. */
export function memoryStore(): StripStore {
  const held = new Map<string, string>();
  return {
    load: (key) => {
      const raw = held.get(keyOf(key));
      if (raw == null) return null;
      try {
        return reviveStrip(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    save: (key, strip) => void held.set(keyOf(key), serialize(strip)),
  };
}

/**
 * The stopgap until Phase 4. Every access is guarded: `localStorage` throws outright in a
 * private window and when a quota is hit, and failing to remember a tab strip is never worth
 * taking the app down for.
 *
 * Storage is per origin, so a strip written against the dev server does not follow the app to
 * `app://` — which is the right answer anyway, and stops mattering once this is SQLite.
 */
export function webStore(): StripStore {
  return {
    load: (key) => {
      try {
        const raw = globalThis.localStorage?.getItem(keyOf(key));
        return raw == null ? null : reviveStrip(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    save: (key, strip) => {
      try {
        globalThis.localStorage?.setItem(keyOf(key), serialize(strip));
      } catch {
        // Out of quota, or storage refused. The strip stays correct in memory for this run.
      }
    },
  };
}

export interface StripWriter {
  /** For navigation, which fires on every route change. Coalesced. */
  write(key: StripKey, strip: Strip): void;
  /** For deliberate acts — open, close, pin, reorder. Never deferred. */
  writeNow(key: StripKey, strip: Strip): void;
  /** Commits anything still pending. Bind to `pagehide`, or a quit is a lost navigation. */
  flush(): void;
}

export function createWriter(store: StripStore, delayMs = 300): StripWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { key: StripKey; strip: Strip } | undefined;

  const commit = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const { key, strip } = pending;
    pending = undefined;
    store.save(key, strip);
  };

  return {
    write: (key, strip) => {
      pending = { key, strip };
      if (timer === undefined) timer = setTimeout(commit, delayMs);
    },
    writeNow: (key, strip) => {
      // Drops any coalesced write: this strip is newer than whatever was waiting, and for the
      // same key it supersedes it.
      pending = { key, strip };
      commit();
    },
    flush: commit,
  };
}

/**
 * What to show on launch.
 *
 * The URL wins unless it is the root. Landing on a specific address — a deep link, a refresh
 * mid-room — has to go there, so the stored active tab only decides when the address says
 * nothing, which is what a cold launch looks like. Opening a location already in the strip
 * activates that tab rather than adding a second one onto the same place.
 *
 * See `docs/plans/navigation.md` (D13, D14).
 */
/**
 * Where to go once a strip has been restored, or null to stay put.
 *
 * The other half of D13. At the root the stored active tab decides, and deciding means going
 * there — a strip that merely highlights the tab you were on while the address bar says
 * something else is not a restored session. Without this the root's redirect to the default
 * workspace lands first and `transitions.navigate` then rewrites the restored tab to point at
 * it, so you come back from a quit to find the tab you were on replaced by a second copy of
 * the workspace.
 */
export function bootTarget(strip: Strip, path: string): string | null {
  if (path !== '/') return null;
  const active = strip.tabs.find((t) => t.id === strip.activeId);
  return active && active.location !== '/' ? active.location : null;
}

export function restore(stored: Strip | null, path: string, fallback: () => Tab): Strip {
  const strip = stored ?? { tabs: [], activeId: null };
  if (strip.tabs.length === 0) return transitions.open(strip, fallback());
  if (path === '/') return strip;

  const existing = strip.tabs.find((t) => t.location === path);
  return existing
    ? transitions.activate(strip, existing.id)
    : transitions.open(strip, { ...fallback(), location: path });
}
