import { app, BrowserWindow, nativeImage, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { installAuth } from './auth';
import { watchChrome } from './chrome';
import { installDeepLinks, registerProtocol } from './deep-links';
import { installLinks } from './links';
import { APP_ORIGIN, registerAppScheme, serveRenderer } from './protocol';

/**
 * The Electron shell. It owns the window, the webview hardening and OS integration — it does
 * not own the UI. The renderer is `apps/client`, loaded from the dev server here and, in
 * production, from a bundle on local disk (Phase 11).
 */

/**
 * Packaged builds serve the renderer from `app://relay` — a real, secure origin, which OPFS
 * and therefore the local database require. Development keeps the Vite dev server, so HMR and
 * the API proxy behave as they always have.
 */
const UI_URL = process.env.RELAY_UI_URL ?? (app.isPackaged ? APP_ORIGIN : 'http://localhost:5173');

/**
 * Where relay's server is — a different thing from where the renderer is loaded from, and
 * conflating them is what broke sign-in in the first packaged build.
 *
 * In development they coincide: Vite serves the renderer and proxies `/auth` to the worker,
 * so one origin covers both. Packaged there is no proxy and no HTTP origin at all, so
 * `shell.openExternal('app://relay/auth/login')` asked the OS to open a scheme only this app
 * understands and nothing happened.
 *
 * Baked in at package time by `tooling/bootstrap/src/package.mjs` (the same value the renderer
 * gets as `VITE_API_BASE`), read here from the packaged metadata. Never taken from the
 * renderer: this string is handed to `shell.openExternal`.
 */
function packagedApiBase(): string | undefined {
  try {
    const raw = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8');
    return (JSON.parse(raw) as { relayApiBase?: string }).relayApiBase;
  } catch {
    return undefined;
  }
}

const API_URL =
  process.env.RELAY_API_URL ?? (app.isPackaged ? (packagedApiBase() ?? UI_URL) : UI_URL);

// Before `app.whenReady()`: Electron ignores scheme privileges registered after that point.
registerAppScheme();
const icon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'));

let mainWindow: BrowserWindow | null = null;
registerProtocol();

// A losing second instance forwards its URL to the first and quits, so there is nothing more
// for it to set up.
if (installDeepLinks()) {
  installAuth(API_URL, () => mainWindow, createWindow);
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
  // The packaged renderer's own origin. Everything else must still be http(s).
  if (url.origin === APP_ORIGIN) return true;
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
    window.loadURL(UI_URL).catch((e: unknown) => {
      // Packaged, the renderer is served from inside the bundle, so a first failure is a real
      // fault rather than a dev server that has not started yet — retrying would only hide it.
      if (app.isPackaged && attempt === 0) console.error('[relay] loadURL failed:', e);
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

void app.whenReady().then(() => {
  // Before the first window: `app://relay` is where a packaged renderer is loaded from, and
  // an unhandled scheme fails the load outright rather than waiting.
  if (app.isPackaged) serveRenderer();

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
