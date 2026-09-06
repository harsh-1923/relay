import type { CSSProperties } from 'react';

import { MultipleCrossCancelDefault, PinDefault, PlusDefault } from '@relay/icons';

import { cn } from '@/lib/utils';
import type { TabsApi } from '@/lib/tabs';

/**
 * The strip itself.
 *
 * `app-region: no-drag` is not decoration: the title bar around this is a drag region, and a
 * drag region swallows mouse events. Without it the tabs render and nothing responds.
 */
export function TabStrip({ tabs, onNew }: { tabs: TabsApi; onNew?: () => void }) {
  const { strip } = tabs;
  if (!strip) return null;

  return (
    <div
      data-slot="tab-strip"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2"
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      {strip.tabs.map((tab) => {
        const active = tab.id === strip.activeId;
        return (
          <div
            key={tab.id}
            data-slot="tab"
            data-active={active || undefined}
            className={cn(
              'group flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-xs',
              active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            <button
              type="button"
              className="min-w-0 max-w-40 truncate"
              title={tab.title}
              onClick={() => tabs.activate(tab.id)}
              // Middle-click closes, the way every tabbed thing does.
              onAuxClick={(e) => e.button === 1 && tabs.close(tab.id)}
            >
              {tab.title}
            </button>

            <button
              type="button"
              aria-label={tab.pinned ? 'Unpin' : 'Pin'}
              className={cn(
                'shrink-0 rounded p-0.5 hover:bg-background/60',
                tab.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-60',
              )}
              onClick={() => tabs.setPinned(tab.id, !tab.pinned)}
            >
              <PinDefault className="size-3" />
            </button>

            <button
              type="button"
              aria-label="Close tab"
              className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:bg-background/60"
              onClick={() => tabs.close(tab.id)}
            >
              <MultipleCrossCancelDefault className="size-3" />
            </button>
          </div>
        );
      })}

      {/* Where a new tab goes is the caller's business — opening a second tab onto the
          location you are already on would be deduplicated into nothing (D14). */}
      {onNew && (
        <button
          type="button"
          aria-label="New tab"
          className="text-muted-foreground hover:bg-muted shrink-0 rounded-md p-1"
          onClick={onNew}
        >
          <PlusDefault className="size-3.5" />
        </button>
      )}
    </div>
  );
}
