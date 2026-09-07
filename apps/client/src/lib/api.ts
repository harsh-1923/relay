/**
 * Where relay's own API lives, relative to wherever the app is running.
 *
 * Empty in development and in the browser, because both are same-origin with the API — the
 * Vite proxy makes that true in dev deliberately, so the sealed session cookie behaves exactly
 * as it will in production.
 *
 * A packaged desktop app is the exception and the reason this exists. Its renderer is served
 * from `app://relay`, not from an HTTP origin, so a relative `/auth/session` would resolve to
 * `app://relay/auth/session` and never reach a server. `VITE_API_BASE` is baked in at build
 * time to point at whichever deployment that build talks to.
 */
const BASE: string = import.meta.env.VITE_API_BASE ?? '';

/** Absolute when a base is configured, untouched otherwise — so dev and browser keep the
 *  same-origin behaviour their cookies depend on. */
export const apiUrl = (path: string): string =>
  BASE && path.startsWith('/') ? `${BASE}${path}` : path;

/** Whether this build talks to a different origin than it is served from, which is what
 *  decides if a session can ride on a cookie at all (invariant: desktop uses a bearer). */
export const isCrossOrigin = (): boolean => BASE !== '';
