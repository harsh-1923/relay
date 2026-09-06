/**
 * The one page this server renders, and it exists only to leave the browser.
 *
 * Desktop sign-in runs in the system browser — passkeys, Touch ID and an existing Google
 * session all work there and none of them work inside an Electron window. When WorkOS
 * redirects back, this hands the authorization code to the app over its custom protocol.
 * The code is single-use and the exchange still needs the server's API key, so the value
 * on this URL is not a session.
 *
 * A bare 303 to a custom scheme is blocked by some browsers; a page with both a script
 * redirect and a visible link is the pattern that works everywhere.
 */
export const handoff = (code: string) => {
  const target = `relay://auth/callback?code=${encodeURIComponent(code)}`;
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>relay</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; color: #111; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } }
  main { text-align: center; padding: 24px; }
  a { color: inherit; }
</style>
<main>
  <p>Returning to relay…</p>
  <p><a href="${target}">Open relay</a> if it didn't open, then close this tab.</p>
</main>
<script>location.replace(${JSON.stringify(target)});</script>`;
};
