import { app, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

const PROTOCOL = 'relay';
const SESSION_FILE = () => join(app.getPath('userData'), 'session');

export function readSession(): string | null {
  try {
    return safeStorage.decryptString(readFileSync(SESSION_FILE()));
  } catch {
    return null;
  }
}

const writeSession = (sealed: string) =>
  writeFileSync(SESSION_FILE(), safeStorage.encryptString(sealed));
const clearSession = () => rmSync(SESSION_FILE(), { force: true });

/**
 * Registers the protocol and wires the deep-link entry points. Call before `app.whenReady`.
 *
 * In development the app is the bare Electron binary, so macOS must be told which script to
 * launch it with; a packaged app registers plainly.
 */
export function registerProtocol() {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      join(process.cwd(), process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

export interface AuthChange {
  error?: string;
}

export function installAuth(
  uiUrl: string,
  window: () => BrowserWindow | null,
  ensureWindow: () => BrowserWindow,
) {
  /** Set when a sign-in is in flight; the only thing that can redeem the code that follows. */
  let pendingVerifier: string | null = null;

  const notify = (change: AuthChange = {}) => {
    const w = window() ?? ensureWindow();
    w.webContents.send('auth:changed', change);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  };

  async function handleDeepLink(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== `${PROTOCOL}:` || url.host !== 'auth' || url.pathname !== '/callback')
      return;

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
      const { sealedSession } = (await r.json()) as { sealedSession: string };
      writeSession(sealedSession);
      notify();
    } catch (e) {
      console.error('[relay] exchange failed:', e);
      notify({ error: 'Could not reach the server to finish signing in.' });
    }
  }

  // macOS delivers the URL to the running instance.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });

  // Windows and Linux launch a second instance with the URL in argv; forward it and quit.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) void handleDeepLink(url);
  });

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
  ipcMain.handle('auth:token', () => readSession());
  // The server rotates an expired access token and hands the renderer a new seal.
  ipcMain.handle('auth:store', (_event, sealed: unknown) => {
    if (typeof sealed === 'string' && sealed) writeSession(sealed);
  });
  ipcMain.handle('auth:sign-out', async () => {
    const sealed = readSession();
    clearSession();
    if (sealed) {
      await fetch(`${uiUrl}/auth/logout`, { headers: { Authorization: `Bearer ${sealed}` } }).catch(
        () => undefined,
      );
    }
    notify();
  });
}
