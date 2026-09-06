import { app } from 'electron';
import { join } from 'node:path';

/**
 * `relay://` dispatch.
 *
 * The scheme carries more than one kind of link, and they do not share a trust level: an auth
 * callback is a single-use code redeemed against a PKCE verifier, a navigation is a hint from
 * anywhere at all. Routing them through one handler is how a room link ends up dropped at the
 * verifier gate, or — worse — how something that should be gated stops being. So the host
 * segment names the kind, and each kind gets its own handler.
 *
 *   relay://auth/callback?code=…    the sign-in round trip (main/auth.ts)
 *   relay://open/w/<id>             go somewhere in the app (main/links.ts)
 *
 * See `docs/plans/navigation.md` (N5).
 */

export const PROTOCOL = 'relay';

type Handler = (url: URL) => void;
const handlers = new Map<string, Handler>();

export function onDeepLink(host: string, handler: Handler): void {
  handlers.set(host, handler);
}

/**
 * Routes one URL to the handler registered for its host. Exported for tests: which kind of
 * link reaches which handler is the whole point of this module, and it is not something to
 * find out by trying a real sign-in.
 */
export function dispatch(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== `${PROTOCOL}:`) return;
  // Unknown host: dropped in silence. A link the shell does not recognise is not an error
  // worth showing a user who did not knowingly send one.
  handlers.get(url.host)?.(url);
}

export function registerProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
      join(process.cwd(), process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/**
 * Wires the OS delivery paths. Returns false when another instance already holds the lock —
 * this one is quitting and should not install anything else.
 */
export function installDeepLinks(): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  // macOS delivers the URL to the running instance.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    dispatch(url);
  });

  // Windows and Linux launch a second instance with the URL in argv; it arrives here instead.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) dispatch(url);
  });

  return true;
}
