import { app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Serving the packaged renderer over `app://relay` rather than `file://`.
 *
 * **This is not cosmetic, and it is the reason packaging needed thinking about at all.** A
 * `file://` page has an opaque origin: no `localStorage`, no OPFS, not a secure context. The
 * local database lives in OPFS (D9), so a `file://` build would launch, render, and then be
 * unable to open its own storage — the app would look fine and hold nothing.
 *
 * `standard: true` gives the scheme real origin semantics, and `secure: true` makes it a
 * secure context, which is what OPFS and `crypto.subtle` require. Both must be declared
 * before `app.whenReady()`, which is why `registerAppScheme()` is called at module scope in
 * `index.ts` rather than inside the ready handler.
 */

export const SCHEME = 'app';
export const APP_ORIGIN = `${SCHEME}://relay`;

/** Must run before the app is ready; Electron ignores privileges registered after. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Serve the built client from inside the bundle.
 *
 * Read through `node:fs`, **not** `net.fetch(file://…)`. The renderer lives inside
 * `app.asar`, and Electron's asar support is a patch over `fs` — a `file://` URL goes to the
 * real filesystem, finds no such directory, and every request fails. That failure is quiet
 * and looks like a broken app rather than a broken path.
 *
 * Three other things it has to get right:
 *
 *   **Traversal.** The path comes from a URL the renderer controls, so it is resolved and then
 *   checked to still be inside the renderer directory.
 *
 *   **Client-side routes.** `/w/:id/r/:id` is a real address (D1) but not a real file, so a
 *   path with no file extension falls back to `index.html` and lets the router resolve it. A
 *   missing `/assets/x.js` still 404s, because answering it with HTML surfaces far away as an
 *   unreadable MIME-type error.
 *
 *   **Content types.** Guessed from the extension, and `application/wasm` matters
 *   specifically: `WebAssembly.instantiateStreaming` rejects anything else, and the local
 *   database is WebAssembly SQLite.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export function serveRenderer(): void {
  const root = join(app.getAppPath(), 'renderer');

  const send = async (file: string): Promise<Response> => {
    const body = await readFile(file);
    return new Response(new Uint8Array(body), {
      headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' },
    });
  };

  protocol.handle(SCHEME, async (request) => {
    const decoded = decodeURIComponent(new URL(request.url).pathname);
    const resolved = normalize(join(root, decoded));

    if (!resolved.startsWith(root + sep) && resolved !== root) {
      return new Response('forbidden', { status: 403 });
    }

    const index = join(root, 'index.html');
    if (!extname(decoded)) return send(index);

    try {
      return await send(resolved);
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
