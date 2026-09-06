# @relay/broker

Credential tier. Pipes lookups, connector execution, approval verification, queue dispatch.

**Holds:** every credential.
**Runs:** no untrusted code, no model output — it receives a tool name and parameters.

Rules that come from Phase 5 and are not negotiable here:

- The execute route is **not routable from the internet**. Internal only.
- Runtime → broker auth is **two factors**: a per-run session token _and_ a shared service key.
- Broker → provider is a **second exchange, not a forward**. The credential goes down and
  outward, never up.
- Every caller-supplied URL is **origin-allowlisted** before it is fetched (invariant 8).

Postgres stays the queue of record — claim query, concurrency caps, priority and
`awaiting_approval` all live on the `runs` row. Cloudflare Queues is the wake signal only.

Host is undecided (Worker vs container) — see Phase 5. Filled in Phases 5–8.
