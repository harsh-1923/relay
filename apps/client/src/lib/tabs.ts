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

import { paths, patterns } from './paths';
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

/**
 * Whether an address is a focus point — something that can be docked in the strip.
 *
 * A workspace is not. It is the container the tabs live inside: the sidebar belongs to it,
 * and the tabs are the several things you are looking at *within* it. Rooms, settings,
 * profile and the like are focus points; `/w/:workspaceId`, `/` and the sign-in screen are
 * not.
 */
export function isFocus(pathname: string): boolean {
  if (pathname === paths.root()) return false;
  if (matchPath(patterns.signIn, pathname)) return false;
  // Exact match only — `/w/:id/r/:id` is a room, and rooms are focus points.
  if (matchPath(patterns.workspace, pathname)) return false;
  return true;
}

export interface TabsApi {
  strip: Strip | null;
  open(location: string, title: string): void;
  activate(id: string): void;
  close(id: string): void;
  setPinned(id: string, pinned: boolean): void;
}

export function useTabs(
  key: StripKey | null,
  workspaces: SwitchTarget[],
  /** The workspace root — where closing the last tab leaves you. */
  home: string,
): TabsApi {
  const location = useLocation();
  const navigate = useNavigate();
  const path = `${location.pathname}${location.search}`;
  const title = titleFor(location.pathname, workspaces);
  /** The address as something dockable, or null when it is not a focus point. */
  const focus = isFocus(location.pathname) ? path : null;

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
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const homeRef = useRef(home);
  homeRef.current = home;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
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

  /**
   * Which key the strip in state was loaded under.
   *
   * Switching organization moves the address before the session query catches up, so for a
   * moment the strip in memory belongs to the organization you just left while the router is
   * already somewhere else. Writing then would point the old organization's remembered tab at
   * the new one's workspace. A strip is only ever written back under the key it was read with.
   */
  const loadedKey = useRef<string | null>(null);

  const newTab = useCallback(
    (location: string, title: string): Tab => ({
      id: crypto.randomUUID(),
      location,
      title,
      pinned: false,
    }),
    [],
  );

  const mint = useCallback(
    (location: string) =>
      newTab(location, titleFor(location.split('?')[0]!, workspacesRef.current)),
    [newTab],
  );

  // A different account or organization is a different strip, not an edit to this one.
  const keyString = key ? keyOf(key) : null;
  useEffect(() => {
    const k = keyRef.current;
    if (!k) {
      setStrip(null);
      return;
    }
    immediate.current = true;
    loadedKey.current = keyOf(k);
    const next = restore(store.load(k), focusRef.current, mint);
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
  }, [keyString, mint]);

  /**
   * The router is the authority; this only records what it did.
   *
   * Off a focus point — at the workspace root — nothing is active and the docked tabs stay
   * put. On one, an address already docked is activated rather than duplicated; otherwise the
   * tab in focus moves to it (D6), or, with nothing in focus, it is docked as the first.
   */
  useEffect(() => {
    immediate.current = false;
    setStrip((s) => {
      if (!s) return s;
      if (focus === null) return transitions.deactivate(s);
      const existing = s.tabs.find((t) => t.location === focus);
      if (existing) return transitions.activate(s, existing.id);
      return s.activeId ? transitions.navigate(s, focus, title) : transitions.open(s, mint(focus));
    });
  }, [focus, title, mint]);

  useEffect(() => {
    const k = keyRef.current;
    if (!k || !strip || keyOf(k) !== loadedKey.current) return;
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
      // Closing the tab in focus moves you to whichever takes its place; closing the last
      // leaves the workspace root, which is what an empty strip means.
      close: (id) => {
        const next = apply((s) => transitions.close(s, id));
        if (!next) return;
        if (next.activeId === null) void navigate(homeRef.current);
        else goTo(next);
      },
      setPinned: (id, pinned) => void apply((s) => transitions.setPinned(s, id, pinned)),
    }),
    [strip, apply, goTo, navigate, newTab, mint],
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
