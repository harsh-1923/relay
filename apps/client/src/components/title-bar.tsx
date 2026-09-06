import type { CSSProperties } from 'react';

import { detectPlatform } from '@relay/sync/platform';

import { TabStrip } from '@/components/tab-strip';
import { useTitleBarInset } from '@/lib/chrome';
import type { TabsApi } from '@/lib/tabs';

/**
 * The strip the window is dragged by, and where the tabs live.
 *
 * Absent in the browser, which has its own chrome and its own tabs — asked as a capability
 * rather than as "am I in Electron", so Windows and Linux (window controls, but on the right,
 * and not overlapping) come out right without a second branch.
 */
export function TitleBar({ tabs, onNew }: { tabs: TabsApi; onNew?: () => void }) {
  const inset = useTitleBarInset();
  const platform = detectPlatform();

  if (!platform.tabs) return null;

  return (
    <div
      data-slot="title-bar"
      className="bg-background flex h-9 shrink-0 items-center border-b"
      // `app-region` has no Tailwind utility and is not in React's CSSProperties.
      style={{ paddingLeft: inset, WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <TabStrip tabs={tabs} onNew={onNew} />
    </div>
  );
}
