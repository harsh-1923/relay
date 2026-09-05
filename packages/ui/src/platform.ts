// The capability interface. Nothing above the persister knows which platform it is on
// (invariant 10) — so this is where `webview: unavailable` is expressed on the browser
// surface, never an `if (isElectron)` at a call site.

export {};
