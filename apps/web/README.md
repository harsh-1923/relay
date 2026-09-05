# @relay/web

Browser surface. Everything except the webview panel, which resolves to unavailable
through `@relay/ui`'s capability interface — a clear explained state, not a missing button.

Must never resolve `@relay/persist-sqlite`; it wires `@relay/persist-idb` instead.
Enforced by lint.

Filled in Phase 12.
