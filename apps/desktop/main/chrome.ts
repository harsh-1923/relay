import type { BrowserWindow } from 'electron';

/**
 * Window chrome the renderer has to draw around.
 *
 * The window is `hiddenInset` on macOS, so the traffic lights float over the renderer's
 * top-left corner and the app has to leave room for them. How much room is the shell's
 * knowledge, not the renderer's — invariant 10: the renderer asks a capability, never which
 * platform it is on.
 *
 * Type-only import of `electron` on purpose: the preload imports `initialInset` from here, and
 * a main-process value import would put `ipcMain` into a renderer-side script. There is no
 * request/response channel for the same reason — the preload supplies the first value
 * synchronously and `watchChrome` pushes every one after it.
 *
 * See `docs/plans/navigation.md` (D11, N3).
 */

/**
 * Width of the traffic-light cluster plus its padding at the default `hiddenInset` position.
 * Electron exposes no way to measure it, so it is a constant — but only this file knows it.
 */
const TRAFFIC_LIGHTS = 78;

/** Windows and Linux keep a native title bar, so nothing overlaps the renderer there. */
export const initialInset = (): number => (process.platform === 'darwin' ? TRAFFIC_LIGHTS : 0);

/** Fullscreen hides the lights entirely; holding the inset would leave dead space. */
export const insetFor = (window: BrowserWindow): number =>
  window.isFullScreen() ? 0 : initialInset();

/**
 * Per window, since fullscreen is a property of the window rather than the app.
 *
 * Also fires once the renderer has loaded: a window restored into fullscreen never emits a
 * transition, so without it the corner would stay reserved for lights that are not there.
 */
export function watchChrome(window: BrowserWindow): void {
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send('chrome:inset-changed', insetFor(window));
  };
  window.on('enter-full-screen', send);
  window.on('leave-full-screen', send);
  window.webContents.on('did-finish-load', send);
}
