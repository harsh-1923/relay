import type { Hotkey } from '@tanstack/hotkeys';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { matchPath, useLocation } from 'react-router';

import { detectPlatform } from '@relay/sync/platform';

import { patterns } from './paths';
import { useTabsApi } from './tabs';

/**
 * Commands, and the keys that reach them.
 *
 * Two tables, joined by id. This one holds every command whether or not it is bound, so the
 * palette can list an action that has no chord; the library's `HotkeyManager` holds the
 * bindings and is the only thing that matches keystrokes. They are not two copies of one
 * thing, so they cannot disagree — `meta.id` on a registration points back here.
 *
 * See `docs/plans/shortcuts.md` (D1–D6).
 */

declare module '@tanstack/hotkeys' {
  interface HotkeyMeta {
    id: string;
  }
}

export type Category = 'Navigation' | 'Tabs' | 'Workspace' | 'Application';

/** The order categories appear in the help sheet and the palette. */
export const CATEGORIES: Category[] = ['Navigation', 'Tabs', 'Workspace', 'Application'];

/**
 * A command is the unit; a binding is one way to reach it.
 *
 * `hotkey` is absent for palette-only commands, and widens to accept a sequence if sequences
 * ever land — one field, no call sites touched.
 */
export interface Command {
  id: string;
  name: string;
  category: Category;
  hotkey?: Hotkey;
  when?: ContextName;
  /**
   * A fact the declaring component already holds — a permission, a capability. Distinct from
   * `when`, which names an ambient condition shared across commands; this keeps that set small
   * rather than growing a context for every one-off.
   */
  available?: boolean;
  run: () => void;
}

/** What the palette and the help sheet read: a command plus whether it can run right now. */
export interface CommandEntry extends Command {
  enabled: boolean;
}

/**
 * Named conditions, rather than arbitrary closures at the call site.
 *
 * VS Code needs a string DSL here because its `when` clauses live in user-editable JSON. Ours
 * are TypeScript, where a function is simply better — but they stay named so the set of
 * conditions is small and greppable, which is the discipline the DSL was enforcing.
 *
 * Tabs are a desktop surface, so the capability is folded into the condition: on a surface
 * with no strip there is no active tab, which is what these already mean.
 */
export type ContextName = 'hasActiveTab' | 'hasTabs' | 'inWorkspace';

function useContextValue(name: ContextName | undefined): boolean {
  const tabs = useTabsApi();
  const { pathname } = useLocation();
  const strip = tabs?.strip;
  const onTabSurface = detectPlatform().tabs;

  if (name === undefined) return true;
  switch (name) {
    case 'hasActiveTab':
      return onTabSurface && strip?.activeId != null;
    case 'hasTabs':
      return onTabSurface && (strip?.tabs.length ?? 0) > 0;
    case 'inWorkspace':
      return (
        matchPath(patterns.workspace, pathname) !== null ||
        matchPath(patterns.room, pathname) !== null
      );
  }
}

const registry = new Map<string, CommandEntry>();
const listeners = new Set<() => void>();
let snapshot: CommandEntry[] = [];

/**
 * Rebuilt rather than mutated, because `useSyncExternalStore` compares snapshots by identity
 * and would not re-render on a mutation in place.
 */
function publish() {
  snapshot = [...registry.values()].sort(
    (a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category),
  );
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Every declared command, bound or not, in category order. */
export function useCommands(): CommandEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** Nothing presses this. It parks the hook for a command with no binding. */
const IDLE = 'F24' as Hotkey;
const conflictBehavior = import.meta.env.DEV ? 'error' : 'warn';

/**
 * Declares a command, binds it if it has a chord, and leaves it in the palette either way.
 *
 * Colocated with the thing it acts on: there is no central list to append to, and no second
 * place to declare it for the palette.
 *
 * `useHotkey` is called unconditionally because hooks cannot be conditional. An unbound
 * command parks it on `IDLE` with `conflictBehavior: 'allow'`, so several unbound commands do
 * not collide with each other, and with no `meta`, so nothing reading the registry mistakes a
 * park for a binding.
 */
export function useCommand(command: Command): void {
  const enabled = useContextValue(command.when) && (command.available ?? true);

  /**
   * `run` closes over render state, so the stored entry would go stale within a render or two
   * and the palette would invoke yesterday's closure. Held in a ref and reached through a
   * stable wrapper, so the entry's identity only changes when something displayable does.
   */
  const latest = useRef(command);
  latest.current = command;
  const run = useCallback(() => latest.current.run(), []);

  const { id, name, category, hotkey, when } = command;
  useEffect(() => {
    registry.set(id, { id, name, category, hotkey, when, run, enabled });
    publish();
    return () => {
      registry.delete(id);
      publish();
    };
  }, [id, name, category, hotkey, when, run, enabled]);

  const bound = hotkey != null;
  useHotkey(hotkey ?? IDLE, run, {
    enabled: enabled && bound,
    // A duplicate binding is a bug; fail where it will be seen and fixed, not in front of
    // someone whose muscle memory just stopped working.
    conflictBehavior: bound ? conflictBehavior : 'allow',
    meta: bound ? { id, name } : undefined,
  });
}
