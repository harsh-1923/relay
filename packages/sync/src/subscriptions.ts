// Effect-with-inverse registry: every subscription registers its own teardown.
//
// Electric subscriptions live outside the React tree and outlive any component, which is
// exactly where the leak happens. ~50 lines we own — not a Cordis dependency. Phase 2.

export {};
