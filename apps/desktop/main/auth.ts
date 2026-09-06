import { ipcMain, shell, type BrowserWindow } from 'electron';

import * as accounts from './accounts';
import { onDeepLink } from './deep-links';
import { challengeFor, newVerifier } from './pkce';

/**
 * Desktop sign-in never happens inside the app window.
 *
 * Passkeys, Touch ID and an existing Google session all work in the system browser and
 * none of them work in an Electron BrowserWindow — Google's passkey prompt simply waits
 * forever. So the shell opens the real browser, WorkOS redirects to the server, and the
 * server's callback hands the authorization code back here over the `relay://` protocol.
 * This module redeems it, with the PKCE verifier only it ever held, and keeps the result.
 *
 * The sealed session lives on disk encrypted by `safeStorage`, which is the OS keychain
 * on macOS and DPAPI on Windows. The renderer never sees the file; it asks over the bridge.
 */

export interface AuthChange {
  error?: string;
}

export const readSession = accounts.activeSeal;

export function installAuth(
  uiUrl: string,
  window: () => BrowserWindow | null,
  ensureWindow: () => BrowserWindow,
) {
  // A shell that stored one seal may be upgrading into this one.
  void accounts.migrateLegacy(uiUrl);

  /** Set when a sign-in is in flight; the only thing that can redeem the code that follows. */
  let pendingVerifier: string | null = null;

  const notify = (change: AuthChange = {}) => {
    const w = window() ?? ensureWindow();
    w.webContents.send('auth:changed', change);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  };

  async function handleCallback(url: URL) {
    if (url.pathname !== '/callback') return;

    const code = url.searchParams.get('code');
    if (!code) return notify({ error: 'The browser returned no authorization code.' });

    const verifier = pendingVerifier;
    pendingVerifier = null;
    if (!verifier)
      return notify({ error: 'No sign-in was in progress. Start again from the app.' });

    try {
      const r = await fetch(`${uiUrl}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
      });
      if (!r.ok) {
        const detail = ((await r.json().catch(() => ({}))) as { error?: string }).error;
        console.error(`[relay] exchange failed: ${r.status} ${detail ?? ''}`);
        return notify({ error: 'Sign-in could not be completed. Try again.' });
      }
      const { sealedSession, user } = (await r.json()) as {
        sealedSession: string;
        user: { id: string; email: string };
      };
      // Adds rather than replaces: signing in as a second email leaves the first signed in.
      accounts.upsert({ userId: user.id, email: user.email, sealed: sealedSession });
      notify();
    } catch (e) {
      console.error('[relay] exchange failed:', e);
      notify({ error: 'Could not reach the server to finish signing in.' });
    }
  }

  // Only `relay://auth/...`. A navigation link reaching this handler would be dropped at the
  // verifier gate below, which is why the two are registered separately (N5).
  onDeepLink('auth', (url) => void handleCallback(url));

  ipcMain.handle('auth:sign-in', () => {
    pendingVerifier = newVerifier();
    const challenge = challengeFor(pendingVerifier);
    return shell.openExternal(`${uiUrl}/auth/login?surface=desktop&challenge=${challenge}`);
  });
  // Abandoning a sign-in must invalidate the verifier, or a code from that browser tab
  // could still be redeemed later.
  ipcMain.handle('auth:cancel', () => {
    pendingVerifier = null;
  });
  ipcMain.handle('auth:token', () => accounts.activeSeal());
  // The server rotates an expired access token and hands the renderer a new seal.
  ipcMain.handle('auth:store', (_event, sealed: unknown) => {
    if (typeof sealed === 'string' && sealed) accounts.updateActiveSeal(sealed);
  });

  ipcMain.handle('auth:accounts', () => accounts.list());

  ipcMain.handle('auth:switch-account', (_event, userId: unknown) => {
    if (typeof userId === 'string' && accounts.setActive(userId)) notify();
  });

  /**
   * Signs out one account and leaves the others. Revoking upstream uses that account's own
   * seal, not the active one — signing out of a background account must not end the session
   * you are looking at.
   */
  ipcMain.handle('auth:sign-out', async (_event, userId?: unknown) => {
    const all = accounts.list();
    const target = typeof userId === 'string' ? userId : all.find((a) => a.active)?.userId;
    if (!target) return;

    const seal = accounts.sealFor(target);
    accounts.remove(target);
    if (seal) {
      await fetch(`${uiUrl}/auth/logout`, { headers: { Authorization: `Bearer ${seal}` } }).catch(
        () => undefined,
      );
    }
    notify();
  });
}
