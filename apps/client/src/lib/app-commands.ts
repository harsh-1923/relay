import { useNavigate } from 'react-router';

import { paths } from './paths';
import { useCommand } from './commands';
import type { Session, SwitchTarget } from './session';
import type { TabsApi } from './tabs';

/**
 * The shell's command set.
 *
 * These live together because the shell is what owns them: it holds the panel, the strip and
 * the router. Commands that belong to a feature are declared in that feature instead — the
 * palette and the help sheet each declare their own.
 *
 * See `docs/plans/shortcuts.md` (step 5).
 */

/** ⌘1–⌘9. Fixed length so the hooks below are called in the same order on every render. */
const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * Where ⌘1–⌘9 land. ⌘9 is the last tab, the way every browser does it; the rest are
 * positional. Null when the strip is too short to have that slot.
 */
export function slotIndex(count: number, slot: number): number | null {
  if (count === 0) return null;
  if (slot === 9) return count - 1;
  return slot <= count ? slot - 1 : null;
}

/**
 * Where Ctrl+Tab lands: the next tab along, wrapping at both ends. From nowhere — no active
 * tab, which the strip allows at a workspace root — forward starts at the first and backward
 * at the last.
 */
export function stepIndex(count: number, active: number, by: number): number | null {
  if (count === 0) return null;
  if (active === -1) return by > 0 ? 0 : count - 1;
  return (((active + by) % count) + count) % count;
}

export function useShellCommands({
  tabs,
  session,
  workspaces,
  onToggleSidebar,
}: {
  tabs: TabsApi;
  session: Session | null;
  workspaces: SwitchTarget[];
  onToggleSidebar: () => void;
}): void {
  const navigate = useNavigate();
  const strip = tabs.strip;

  const step = (by: number) => {
    if (!strip) return;
    const at = strip.tabs.findIndex((t) => t.id === strip.activeId);
    const to = stepIndex(strip.tabs.length, at, by);
    if (to !== null) tabs.activate(strip.tabs[to]!.id);
  };

  useCommand({
    id: 'sidebar.toggle',
    name: 'Toggle sidebar',
    category: 'Application',
    hotkey: 'Mod+B',
    run: onToggleSidebar,
  });

  useCommand({
    id: 'tabs.close',
    name: 'Close tab',
    category: 'Tabs',
    hotkey: 'Mod+W',
    when: 'hasActiveTab',
    run: () => strip?.activeId && tabs.close(strip.activeId),
  });

  useCommand({
    id: 'tabs.next',
    name: 'Next tab',
    category: 'Tabs',
    hotkey: 'Control+Tab',
    when: 'hasTabs',
    run: () => step(1),
  });

  useCommand({
    id: 'tabs.previous',
    name: 'Previous tab',
    category: 'Tabs',
    hotkey: 'Control+Shift+Tab',
    when: 'hasTabs',
    run: () => step(-1),
  });

  useCommand({
    id: 'tabs.togglePin',
    name: 'Pin or unpin tab',
    category: 'Tabs',
    hotkey: 'Mod+Shift+P',
    when: 'hasActiveTab',
    run: () => {
      const active = strip?.tabs.find((t) => t.id === strip.activeId);
      if (active) tabs.setPinned(active.id, !active.pinned);
    },
  });

  // A loop over a module constant, so the hooks below are called in the same order every
  // render — the thing the rule against conditional hooks is actually protecting.
  for (const slot of SLOTS) {
    useCommand({
      id: `tabs.select${slot}`,
      name: `Go to tab ${slot}`,
      category: 'Tabs',
      hotkey: `Mod+${slot}`,
      when: 'hasTabs',
      run: () => {
        if (!strip) return;
        const to = slotIndex(strip.tabs.length, slot);
        if (to !== null) tabs.activate(strip.tabs[to]!.id);
      },
    });
  }

  useCommand({
    id: 'settings.open',
    name: 'Open settings',
    category: 'Application',
    hotkey: 'Mod+,',
    run: () => void navigate(paths.settings()),
  });

  useCommand({
    id: 'workspace.new',
    name: 'New workspace',
    category: 'Workspace',
    // Deliberately unbound: reachable from the palette, and can be given a chord later
    // without its implementation moving.
    available: session?.canInvite === true,
    run: () => void navigate(paths.newWorkspace()),
  });

  useCommand({
    id: 'workspace.open',
    name: 'Go to workspace',
    category: 'Workspace',
    available: workspaces.some((w) => w.organizationId === session?.organizationId),
    run: () => {
      const inOrg = workspaces.filter((w) => w.organizationId === session?.organizationId);
      const home = inOrg.find((w) => w.isDefault) ?? inOrg[0];
      if (home) void navigate(paths.workspace(home.workspaceId));
    },
  });
}
