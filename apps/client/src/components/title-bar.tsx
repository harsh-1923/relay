import type { CSSProperties } from 'react';

import { ChevronLeft, ChevronRight, ClockDefault, SidebarDefault } from '@relay/icons';
import { detectPlatform } from '@relay/sync/platform';

import { TabStrip } from '@/components/tab-strip';
import { Button } from '@/components/ui/button';
import { useTitleBarInset } from '@/lib/chrome';
import type { TabsApi } from '@/lib/tabs';

/**
 * Narrowest the gutter goes. With the sidebar collapsed to nothing the buttons still need a
 * home: the traffic-light inset, the toggle, and the three navigation buttons.
 */
const MIN_GUTTER = 216;

/**
 * The strip the window is dragged by, and where the tabs live.
 *
 * Laid out the way Linear does it: a gutter exactly as wide as the sidebar, holding the
 * window controls, the sidebar toggle and navigation, so the first tab begins where the
 * content column does. `gutterWidth` is the sidebar panel's live pixel width, which is why
 * the tabs follow a drag and snap back when the sidebar collapses.
 *
 * Absent in the browser, which has its own chrome and its own tabs — asked as a capability
 * rather than as "am I in Electron", so Windows and Linux (window controls, but on the right,
 * and not overlapping) come out right without a second branch.
 */
export function TitleBar({
  tabs,
  onNew,
  gutterWidth,
  onToggleSidebar,
}: {
  tabs: TabsApi;
  onNew?: () => void;
  gutterWidth: number;
  onToggleSidebar: () => void;
}) {
  const inset = useTitleBarInset();
  const platform = detectPlatform();

  if (!platform.tabs) return null;

  return (
    <div
      data-slot="title-bar"
      className="bg-background flex h-9 shrink-0 items-center border-b"
      // `app-region` has no Tailwind utility and is not in React's CSSProperties.
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <div
        data-slot="title-bar-gutter"
        className="flex h-full shrink-0 items-center gap-1 pr-2"
        style={{ width: Math.max(gutterWidth, MIN_GUTTER), paddingLeft: inset }}
      >
        {/* Buttons must opt out of the drag region, or the bar swallows their clicks. */}
        <div
          className="flex items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle sidebar"
            title="Toggle sidebar (⌘B)"
            onClick={onToggleSidebar}
          >
            <SidebarDefault />
          </Button>
        </div>

        <div className="flex-1" />

        {/* Navigation. Placeholders for now — where they go is the next thing to build. */}
        <div
          className="flex items-center gap-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <Button variant="ghost" size="icon-sm" aria-label="History" disabled>
            <ClockDefault />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Back" disabled>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled>
            <ChevronRight />
          </Button>
        </div>
      </div>

      <TabStrip tabs={tabs} onNew={onNew} />
    </div>
  );
}
