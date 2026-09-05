# @relay/ui

**Ships uncompiled.** `exports` points at source, not `dist`. No build step, no watch
process, no stale artefacts — each app's bundler compiles it as if the components lived
inside that app. Compile it only if it is ever published for outside consumers.

`src/platform.ts` is the capability interface. Nothing above the persister knows which
platform it is on (invariant 10), so the webview panel resolves to unavailable on the
browser surface through this file — never through an `if (isElectron)` at a call site.
