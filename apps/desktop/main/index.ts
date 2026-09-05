import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';

/**
 * The Electron shell. It owns the window, the webview hardening and OS integration — it does
 * not own the UI. The renderer is `apps/client`, loaded from the dev server here and, in
 * production, from a bundle on local disk (Phase 11).
 */

const UI_URL = process.env.RELAY_UI_URL ?? 'http://localhost:5173';

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

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Panels. Hardened centrally below, never per element.
      webviewTag: true,
    },
  });

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

  if (!app.isPackaged) window.webContents.openDevTools({ mode: 'detach' });
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
