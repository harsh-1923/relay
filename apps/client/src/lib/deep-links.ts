import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { bridge } from '@relay/sync/platform';

/**
 * Follows a `relay://open/…` deep link the shell forwarded.
 *
 * `onOpen` is how the desktop hands it to the tab strip: a link is "open this", not "move the
 * tab I happen to be on", so it activates a tab already at that address rather than pointing a
 * second one at it (D14). Without it — on a surface with no strip — it is an ordinary
 * navigation.
 *
 * Either way this is a client-side navigation, so everything that decides whether the user may
 * be there runs exactly as it does for a link clicked inside the app.
 *
 * See `docs/plans/navigation.md` (D12, D14, N5).
 */
export function useDeepLinkNavigation(onOpen?: (path: string) => void): void {
  const navigate = useNavigate();

  // Both change identity as you move; the subscription should not be torn down for that.
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(
    () =>
      bridge()?.links?.onNavigate((path) => {
        const open = openRef.current;
        if (open) open(path);
        else void navigateRef.current(path);
      }),
    [],
  );
}
