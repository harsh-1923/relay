import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';

import {
  bootTarget,
  createWriter,
  keyOf,
  restore,
  transitions,
  webStore,
  type Strip,
  type StripKey,
  type Tab,
} from '@relay/sync/local';

import { patterns } from './paths';
import type { SwitchTarget } from './session';

/**
 * Binds the tab strip to the router.
 *
 * The division of labour is the point: the reducer in `@relay/sync/local` owns the invariants,
 * storage owns durability, and this owns only the two directions between them and React —
 * the router says where the active tab points, and a click on the strip says where to go.
 *
 * See `docs/plans/navigation.md` (D6–D10, D13, D14).
 */

const store = webStore();
const writer = createWriter(store);

/**
 * What a tab is called. Derived centrally rather than reported by each route, so the strip can
 * label a tab it is not currently rendering — the whole point of a cached title.
 *
 * Matched against `patterns`, so the grammar still lives in exactly one module.
 */
export function titleFor(pathname: string, workspaces: SwitchTarget[]): string {
  const room = matchPath(patterns.room, pathname);
  if (room?.params.roomId) return room.params.roomId;

  const workspace = matchPath(patterns.workspace, pathname);
  if (workspace?.params.workspaceId) {
    const found = workspaces.find((w) => w.workspaceId === workspace.params.workspaceId);
    return found?.name ?? 'Workspace';
  }

  if (matchPath(patterns.settings, pathname)) return 'Settings';
  return 'relay';
}

export interface TabsApi {
  strip: Strip | null;
  open(location: string, title: string): void;
  activate(id: string): void;
  close(id: string): void;
  setPinned(id: string, pinned: boolean): void;
}

export function useTabs(key: StripKey | null, workspaces: SwitchTarget[]): TabsApi {
  const location = useLocation();
  const navigate = useNavigate();
  const path = `${location.pathname}${location.search}`;
  const title = titleFor(location.pathname, workspaces);

  const [strip, setStrip] = useState<Strip | null>(null);

  /**
   * Mirrors of things the effects need to read without depending on them. Loading a strip must
   * happen when the *key* changes and not on every navigation, but it needs the address it is
   * loading against — a dependency would reload the strip each time you moved.
   */
  const stripRef = useRef(strip);
  stripRef.current = strip;
  const pathRef = useRef(path);
  pathRef.current = path;
  const titleRef = useRef(title);
  titleRef.current = title;
  const keyRef = useRef(key);
  keyRef.current = key;
  /**
   * `useNavigate()` is not referentially stable — it changes with the location. Held in a ref
   * so the effect below depends on the key alone: with `navigate` in its dependencies it re-ran
   * on every navigation, reloading the strip from disk each time, which turned "move this tab"
   * into "open another one".
   */
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  /** Whether the next write is a deliberate act or a coalesced navigation. */
  const immediate = useRef(true);

  const newTab = useCallback(
    (location: string, title: string): Tab => ({
      id: crypto.randomUUID(),
      location,
      title,
      pinned: false,
    }),
    [],
  );

  const fallback = useCallback(() => newTab(pathRef.current, titleRef.current), [newTab]);

  // A different account or organization is a different strip, not an edit to this one.
  const keyString = key ? keyOf(key) : null;
  useEffect(() => {
    const k = keyRef.current;
    if (!k) {
      setStrip(null);
      return;
    }
    immediate.current = true;
    const next = restore(store.load(k), pathRef.current, fallback);
    setStrip(next);

    /**
     * At the root, the stored active tab decides — and deciding means *going there*, not just
     * being highlighted. Without this the root's own redirect to the default workspace lands
     * first, and the effect below then rewrites the restored tab to point at it: you come back
     * from a quit to find the tab you were on has become a second copy of the workspace.
     *
     * Runs after the redirect rather than racing it. Effects fire child-first, and the
     * redirect is deeper in the tree, so this is the one that lands last.
     */
    const target = bootTarget(next, pathRef.current);
    if (target) void navigateRef.current(target, { replace: true });
  }, [keyString, fallback]);

  // The router is the authority on where the active tab points; this only records it.
  useEffect(() => {
    immediate.current = false;
    setStrip((s) => (s ? transitions.navigate(s, path, title) : s));
  }, [path, title]);

  useEffect(() => {
    const k = keyRef.current;
    if (!k || !strip) return;
    (immediate.current ? writer.writeNow : writer.write)(k, strip);
  }, [strip]);

  // Quitting mid-debounce would otherwise lose the last navigation.
  useEffect(() => {
    const flush = () => writer.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  /** Applies a transition and hands back the result, so the caller can navigate to it. */
  const apply = useCallback((fn: (s: Strip) => Strip): Strip | null => {
    const current = stripRef.current;
    if (!current) return null;
    const next = fn(current);
    immediate.current = true;
    setStrip(next);
    return next;
  }, []);

  const goTo = useCallback(
    (next: Strip | null) => {
      const active = next?.tabs.find((t) => t.id === next.activeId);
      if (active && active.location !== pathRef.current) void navigate(active.location);
    },
    [navigate],
  );

  return useMemo(
    () => ({
      strip,
      open: (location, title) => goTo(apply((s) => transitions.open(s, newTab(location, title)))),
      activate: (id) => goTo(apply((s) => transitions.activate(s, id))),
      // Closing the tab you are looking at moves you to whichever one takes its place.
      close: (id) => goTo(apply((s) => transitions.close(s, id, fallback))),
      setPinned: (id, pinned) => void apply((s) => transitions.setPinned(s, id, pinned)),
    }),
    [strip, apply, goTo, newTab, fallback],
  );
}

/**
 * The strip is owned by the shell but acted on from anywhere — any list of rooms needs to be
 * able to open one in a new tab. A context rather than prop drilling through every route,
 * since nothing between the shell and the caller has an opinion about tabs.
 */
const TabsContext = createContext<TabsApi | null>(null);
export const TabsProvider = TabsContext.Provider;

/** Null on a surface with no strip — the browser, where the browser's own tabs are the tabs. */
export const useTabsApi = (): TabsApi | null => useContext(TabsContext);
