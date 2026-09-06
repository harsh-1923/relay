import { useEffect, useState } from 'react';

import { bridge, detectPlatform } from '@relay/sync/platform';

/**
 * Pixels to leave clear at the top-left for the OS window controls.
 *
 * Reactive rather than a constant: macOS hides the traffic lights in fullscreen, and holding
 * the inset would leave dead space in the corner for as long as the window stayed there.
 * The initial value is synchronous so the first paint is already correct.
 *
 * See `docs/plans/navigation.md` (D11, N3).
 */
export function useTitleBarInset(): number {
  const [inset, setInset] = useState(() => detectPlatform().titleBarInset);
  useEffect(() => bridge()?.chrome?.onInsetChange(setInset), []);
  return inset;
}
