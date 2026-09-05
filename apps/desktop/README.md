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

## `bridgeVersion`

The preload exposes one number. It is the compatibility contract with a downloaded UI bundle
(Phase 11): a bundle declares the minimum shell it needs, and the updater refuses one this
shell cannot run rather than showing a white screen. Bump it only on a breaking change to
what the bridge exposes.

Packaging, signing and the two update channels land in Phase 11. `electron-builder` is not
installed yet, deliberately.
