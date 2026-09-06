/**
 * The desktop tab strip.
 *
 * Local-only state: which tabs are open is arrangement, and arrangement is per device — the
 * same call Phase 10 makes for panels, where *what* is open syncs but *how it is arranged*
 * does not. So this never reaches the server and never drives subscription lifecycle;
 * switching tabs is a local query against data already present.
 *
 * Pure transitions, kept apart from storage and React so the invariants can be tested on
 * their own — the same shape as `apps/desktop/main/accounts.ts`. A strip is a list with an
 * active index and a handful of operations, which is a reducer, not a state machine.
 *
 * The strip is scoped to `(account, organization)` — exactly what the session pins. Workspace
 * is not in the session, so it is not in the key either. That scoping lives in the storage
 * layer; nothing here knows about it.
 *
 * See `docs/plans/navigation.md` (D6–D10).
 */

export interface Tab {
  id: string;
  /** A path, opaque here. A tab can hold any location the router serves, not only a room. */
  location: string;
  /** Cached so the strip can paint on a cold start, before anything has synced. */
  title: string;
  pinned: boolean;
}

/** `tabs` is display order: pinned first, then insertion order. Readers never sort. */
export interface Strip {
  tabs: Tab[];
  activeId: string | null;
}

export const empty: Strip = { tabs: [], activeId: null };

/** Index where the pinned run ends — where a newly pinned or unpinned tab lands. */
const boundary = (tabs: Tab[]): number => {
  const i = tabs.findIndex((t) => !t.pinned);
  return i === -1 ? tabs.length : i;
};

export const transitions = {
  /**
   * Opening a location already in the strip activates it rather than duplicating it. A room
   * is a place, not a document — two tabs on one room is never what anyone meant.
   */
  open: (s: Strip, tab: Tab): Strip => {
    const existing = s.tabs.find((t) => t.location === tab.location);
    if (existing) return { ...s, activeId: existing.id };
    // Unpinned tabs append; a pinned one has to land inside the pinned run to keep the order.
    const at = tab.pinned ? boundary(s.tabs) : s.tabs.length;
    return {
      tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)],
      activeId: tab.id,
    };
  },

  activate: (s: Strip, id: string): Strip =>
    s.tabs.some((t) => t.id === id) ? { ...s, activeId: id } : s,

  /**
   * Closing the tab you are looking at lands on its right neighbour, the way every browser
   * does it, falling back left when it was the last one. Never leaves the strip empty — a
   * window with no tabs has nothing to render and no way back — so the caller supplies what
   * to fall back to.
   */
  close: (s: Strip, id: string, fallback: () => Tab): Strip => {
    const i = s.tabs.findIndex((t) => t.id === id);
    if (i === -1) return s;
    const tabs = s.tabs.filter((t) => t.id !== id);
    if (tabs.length === 0) return transitions.open(empty, fallback());
    return { tabs, activeId: s.activeId === id ? (tabs[i] ?? tabs[i - 1]!).id : s.activeId };
  },

  /** The router is the authority on where the active tab points; this only records it. */
  navigate: (s: Strip, location: string, title: string): Strip => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, location, title } : t)),
  }),

  /** Retitling the active tab as its data arrives, without moving it. */
  retitle: (s: Strip, id: string, title: string): Strip => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
  }),

  /**
   * Pinning moves the tab to the end of the pinned run; unpinning to the start of the
   * unpinned run. Both are the same index, which is why one transition serves both.
   */
  setPinned: (s: Strip, id: string, pinned: boolean): Strip => {
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab || tab.pinned === pinned) return s;
    const rest = s.tabs.filter((t) => t.id !== id);
    const at = boundary(rest);
    return { ...s, tabs: [...rest.slice(0, at), { ...tab, pinned }, ...rest.slice(at)] };
  },

  /**
   * Drag to reorder. A tab cannot leave its run: dragging an unpinned tab into the pinned
   * range would silently pin it, which is not what the gesture said.
   */
  reorder: (s: Strip, id: string, to: number): Strip => {
    const from = s.tabs.findIndex((t) => t.id === id);
    const tab = s.tabs[from];
    if (!tab) return s;
    const rest = s.tabs.filter((t) => t.id !== id);
    const edge = boundary(rest);
    const [lo, hi] = tab.pinned ? [0, edge] : [edge, rest.length];
    const at = Math.min(Math.max(to, lo), hi);
    return { ...s, tabs: [...rest.slice(0, at), tab, ...rest.slice(at)] };
  },
};

/** The active tab, or null when the strip is empty. */
export const active = (s: Strip): Tab | null => s.tabs.find((t) => t.id === s.activeId) ?? null;
