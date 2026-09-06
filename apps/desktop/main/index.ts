import { app, BrowserWindow, nativeImage, shell } from 'electron';
import { join } from 'node:path';

import { installAuth } from './auth';
import { watchChrome } from './chrome';
import { installDeepLinks, registerProtocol } from './deep-links';
import { installLinks } from './links';
import { installPersistence } from './persistence';

/**
 * The Electron shell. It owns the window, the webview hardening and OS integration — it does
 * not own the UI. The renderer is `apps/client`, loaded from the dev server here and, in
 * production, from a bundle on local disk (Phase 11).
 */

/**
 * Follows the dev server: `RELAY_HTTPS=1` puts Vite on HTTPS for HTTP/2 (five shapes per room
 * against a six-connection HTTP/1.1 budget), and the shell has to load the same scheme.
 */
const HTTPS = !!process.env.RELAY_HTTPS;
const UI_URL = process.env.RELAY_UI_URL ?? `${HTTPS ? 'https' : 'http'}://localhost:5173`;
const icon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'));

let mainWindow: BrowserWindow | null = null;
registerProtocol();

/**
 * Trust the dev server's self-signed certificate, and nothing else — only when HTTPS is on.
 *
 * `certificate-error` is the scoped check: it sees the URL and refuses anything that is not
 * the dev server. But it fires *above* the TLS handshake, and Chromium aborts a self-signed
 * connection below that with `ERR_CERT_AUTHORITY_INVALID` before the event is raised.
 * `--allow-insecure-localhost` no longer reliably stops that in current Chromium, so this
 * uses `--ignore-certificate-errors`, which does — and which is exactly why it is gated on an
 * explicit opt-in *and* on not being packaged. It must never be the default.
 */
if (!app.isPackaged && HTTPS) {
  app.commandLine.appendSwitch('ignore-certificate-errors');

  app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
    const { hostname, origin } = new URL(url);
    const trusted =
      origin === new URL(UI_URL).origin && (hostname === 'localhost' || hostname === '127.0.0.1');
    if (!trusted) return callback(false);
    event.preventDefault();
    callback(true);
  });
}

// A losing second instance forwards its URL to the first and quits, so there is nothing more
// for it to set up.
if (installDeepLinks()) {
  installAuth(UI_URL, () => mainWindow, createWindow);
  installLinks(() => mainWindow, createWindow);
}

/** Blocked outright. The desktop app sits inside the user's network, so an internal URL is a
 *  genuine pivot, not a broken link (H10). */
function isNavigable(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) return url.origin === UI_URL;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || host === '[::1]') return false;
  return true;
}

function createWindow(): BrowserWindow {
  const window = (mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Panels. Hardened centrally below, never per element.
      webviewTag: true,
    },
  }));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  // Fullscreen hides the traffic lights, so the renderer has to be told to reclaim the space.
  watchChrome(window);

  /**
   * One choke point for every webview that will ever exist. With panels created from JSX,
   * per-element attributes are a discipline problem — someone eventually writes one without
   * a partition. Here it cannot happen.
   */
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // A dedicated partition, shared across panels so a provider login happens once ever
    // rather than once per pane — and never touching app storage.
    params.partition = 'persist:agent';
    if (!isNavigable(params.src)) event.preventDefault();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isNavigable(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isNavigable(url)) event.preventDefault();
  });

  // The dev server may not be up yet when Electron starts.
  const load = (attempt = 0): void => {
    window.loadURL(UI_URL).catch(() => {
      if (attempt < 40) setTimeout(() => load(attempt + 1), 500);
      else console.error(`[relay] could not reach ${UI_URL} — is \`pnpm dev\` running?`);
    });
  };
  load();

  // Opt in, not by default. Electron's stock menu already binds Toggle Developer Tools —
  // Cmd+Opt+I on macOS, Ctrl+Shift+I elsewhere — so opening it on every launch only gets in
  // the way of the window you actually wanted to look at.
  if (!app.isPackaged && process.env.RELAY_DEVTOOLS) {
    window.webContents.openDevTools({ mode: 'detach' });
  }
  return window;
}

void app.whenReady().then(async () => {
  // Before the first window: the renderer asks for persistence as soon as it mounts, and an
  // unhandled IPC channel is an error rather than a wait. A failure here is not fatal — the
  // app still works, it just has no local cache — so it is logged and stepped over.
  await installPersistence().catch((e: unknown) => {
    console.error('[relay] local persistence unavailable:', e);
  });

  // BrowserWindow's `icon` only reaches Windows/Linux; the Dock reads whatever the app bundle
  // declares (Phase 11) and ignores it in dev unless set here.
  app.dock?.setIcon(icon);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
