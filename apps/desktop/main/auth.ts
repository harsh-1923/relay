import { app, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Desktop sign-in never happens inside the app window.
 *
 * Passkeys, Touch ID and an existing Google session all work in the system browser and
 * none of them work in an Electron BrowserWindow — Google's passkey prompt simply waits
 * forever. So the shell opens the real browser, WorkOS redirects to the server, and the
 * server's callback hands the authorization code back here over the `relay://` protocol.
 * This module redeems it and holds the result.
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

export function installAuth(uiUrl: string, window: () => BrowserWindow | null) {
  const notify = () => window()?.webContents.send('auth:changed');

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
    if (!code) return;

    try {
      const r = await fetch(`${uiUrl}/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) {
        console.error(`[relay] exchange failed: ${r.status} ${await r.text()}`);
        return;
      }
      const { sealedSession } = (await r.json()) as { sealedSession: string };
      writeSession(sealedSession);
      notify();
    } finally {
      const w = window();
      if (w) {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      }
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

  ipcMain.handle('auth:sign-in', () => shell.openExternal(`${uiUrl}/auth/login?surface=desktop`));
  ipcMain.handle('auth:token', () => readSession());
  ipcMain.handle('auth:sign-out', async () => {
    const sealed = readSession();
    clearSession();
    if (sealed) {
      await fetch(`${uiUrl}/auth/logout`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${sealed}` },
      }).catch(() => undefined);
    }
    notify();
  });
}
