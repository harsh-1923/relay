# @relay/desktop

The Electron **shell**. It owns the window, webview hardening and OS integration — it does
not own the UI. There is no renderer source here: the renderer is `@relay/client`, loaded
from the dev server in development and from a local bundle in production.

```
pnpm dev:desktop     # from the repo root — server, client and shell together
```

Electron over Tauri because the panel _is_ the product: Tauri uses the system webview, so an
embedded Notion or Google Doc would render in a different engine per platform.

## Webviews are hardened in one place

`will-attach-webview` is the choke point. Every `<webview>` that will ever exist passes
through it, so the main process strips preload scripts, forces `nodeIntegration: false` and
`contextIsolation: true`, pins the partition, and rejects any URL failing the allowlist.

With panels created from JSX, per-element attributes are a discipline problem — someone
eventually writes one without a partition. Here it cannot happen, which is what keeps H10
enforceable at ten panes rather than one.

**Internal IPs and non-http schemes are blocked.** The desktop app sits inside the user's
network, so an internal URL is a genuine pivot, not a broken link.

**One shared `persist:agent` partition**, not one per panel: agent-opened pages never touch
app storage, and a provider login still happens once ever rather than once per pane.

## Sign-in happens in the system browser, never in the window

Passkeys, Touch ID and an existing Google session all work in a real browser; none of them
work in an Electron `BrowserWindow`. Google's passkey prompt does not fail there — it waits
forever on "Verifying it's you…". So `main/auth.ts` never loads a login page:

```
Sign in → shell.openExternal(client/auth/login?surface=desktop)
        → WorkOS, in the user's browser
        → server callback sees state=desktop → hands off to relay://auth/callback?code=…
        → shell redeems the code at /auth/exchange → sealed session
        → stored with safeStorage (OS keychain) → renderer sends it as a bearer
```

WorkOS never sees `relay://`; the redirect URI stays the client's. The code on the deep link
is single-use and the exchange still needs the server's API key, so it is not a session.
The renderer never touches the stored file — it asks the bridge for a token.

**PKCE binds the code to this shell.** `main/pkce.ts` mints a verifier per sign-in and sends
only its S256 challenge with the authorize request. The code WorkOS hands back can be redeemed
by nothing else — a hijacked `relay://` link gets a code it cannot use, and a link arriving
with no sign-in in flight is dropped before any network call.

**Expired access tokens are not a sign-out.** The server refreshes them from the token inside
the seal and returns the new seal in the `/auth/session` body; the renderer hands it back over
`auth.store()` so the next request carries it. Without that hand-back the next request would
repeat the refresh against a refresh token WorkOS has already rotated away.

**The window says what it is waiting for.** Sign-in happens elsewhere, so an unchanged
screen is wrong twice over: it looks broken, and it invites a second click — which mints a
fresh verifier and silently invalidates the browser tab already open. The renderer goes to a
`pending` state on `signIn()` and leaves it only when the shell reports back. `auth.cancel`
clears the pending verifier so an abandoned attempt cannot be redeemed later.

**Failures reach the user.** Every way the round trip can go wrong — no code, no sign-in in
progress, exchange refused, server unreachable — is sent to the renderer through
`auth.onChange({ error })` and shown on the sign-in screen, not left in a log.

Test the plumbing without a real login: with the shell running,
`open "relay://auth/callback?code=probe"` with no sign-in in progress should do nothing
visible to the network and show "No sign-in was in progress" in the app — the link reached
main and was dropped at the verifier gate.

## `bridgeVersion`

The preload exposes one number. It is the compatibility contract with a downloaded UI bundle
(Phase 11): a bundle declares the minimum shell it needs, and the updater refuses one this
shell cannot run rather than showing a white screen. A bundle declares a _minimum_, so bump
it on any change to what is exposed — additions included — or a bundle cannot say it needs
them.

Packaging, signing and the two update channels land in Phase 11. `electron-builder` is not
installed yet, deliberately.
