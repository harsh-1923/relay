import type { BrowserWindow } from 'electron';

import { onDeepLink } from './deep-links';

/**
 * `relay://open/<in-app path>` — "go here".
 *
 * The host says what kind of link this is; the path is the renderer's own address, verbatim,
 * so the shell never has to know the URL grammar and the two can change independently.
 *
 * Anything can trigger a deep link — a web page, an email, another app — so this does exactly
 * one thing: it hands the renderer a path. No credential is read, no request is made, nothing
 * is redeemed. Whether that path is reachable is then answered where it always is: the
 * session decides the organization, and the shape proxy authorises the data.
 *
 * See `docs/plans/navigation.md` (D12, N5).
 */
/**
 * One leading slash and no more. `//host` is protocol-relative and would leave the app
 * entirely; a backslash is the same trick spelled for Windows. Anything can hand us a
 * `relay://` URL, so this is a gate, not a formality.
 */
export const isInAppPath = (path: string): boolean =>
  path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');

export function installLinks(
  window: () => BrowserWindow | null,
  ensureWindow: () => BrowserWindow,
): void {
  onDeepLink('open', (url) => {
    const path = `${url.pathname}${url.search}`;
    if (!isInAppPath(path)) return;

    const w = window() ?? ensureWindow();
    w.webContents.send('link:navigate', path);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
}
