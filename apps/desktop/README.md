# @relay/desktop

Electron — the primary surface. Chosen over Tauri because the webview panel _is_ the
product, and Tauri renders it in a different engine per platform.

- `main/` — webview hardening, session partitions, autoUpdater
- `preload/` — contextBridge, exposing the capability API only
- `renderer/` — wires `@relay/persist-sqlite`

`main/` and `preload/` will need their own tsconfig once they carry real code; today one
config covers all three.

Filled in Phases 4, 10 and 11.
