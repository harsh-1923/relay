# Observability — logging, traces, metrics

> Working plan. Unlike the other plans, `ARCHITECTURE.md` does **not** hold these decisions —
> its header puts "governance, analytics and telemetry" out of scope, and operational logging
> was never separated from that line. So this document carries the decisions as well as the
> breakdown. They carry their reasoning so they can be re-argued if circumstances change, not
> re-litigated by default. See _Candidates for ARCHITECTURE.md_ at the bottom for the ones
> that belong upstream when that file is next edited in its own turn.

**Exit criterion:** every backend tier emits structured events through one shared package; a
local `pnpm run up` brings up Grafana and shows them; the same LogQL works against production;
Claude Code can answer "why did run X fail" from either; and switching vendor is two env vars.

**Scope:** the three backend tiers and the local dev stack. Frontend (Faro) and profiling
(Pyroscope) are designed for but not built — see _Deliberately not built_.

## Where things stand

| #   | Step                                      | State |
| --- | ----------------------------------------- | ----- |
| 1   | `packages/logger` — API, redaction, sinks | ⬜    |
| 2   | `tooling/docker/observability.yml`        | ⬜    |
| 3   | `services()` wiring in bootstrap          | ⬜    |
| 4   | `apps/server` as first consumer           | ⬜    |
| 5   | Cloudflare Destinations → Grafana Cloud   | ⬜    |
| 6   | `no-console` lint tightening              | ⬜    |
| 7   | Sampling on the shape proxy               | ⬜    |
| 8   | First dashboard, exported as JSON         | ⬜    |

---

## The shape of the problem

Three tiers, three runtimes, three different failure modes. This table is the whole design
brief — a logger correct for one of these is wrong for the other two.

| Tier           | Runtime               | Holds                | Logging risk                                              |
| -------------- | --------------------- | -------------------- | --------------------------------------------------------- |
| `apps/server`  | workerd               | session-sealing key  | **Volume/cost.** Every shape request passes here (H8)     |
| `apps/broker`  | Worker or container\* | **every credential** | **Leak.** One `log.error(err)` on a 401 dumps a token     |
| `apps/runtime` | Node, one per run     | nothing              | **Injection.** Every string it touches is attacker-shaped |

\* Broker host is still undecided (Phase 5). Nothing here depends on the answer.

---

## Decisions

### D1 — A shared package, never a service

`packages/logger`, imported by each app like `packages/schema` is. Not a deployed service
every tier calls over the network.

**Why:** a logging service makes every log call a network call, and adds a component that can
be down at exactly the moment you need it. The package has zero runtime dependency on itself.

### D2 — Levels are `debug | info | warn | error`. There is no `trace`

**Why:** "trace" already means `run_events` in this product (invariant 11 — two histories,
never merged). A `log.trace()` sitting next to a user-facing trace is precisely the confusion
that invariant exists to prevent. Operational logs are a **third** history and must not be
mistaken for either.

### D3 — Fields are flat primitives. The type signature is the redaction

```ts
type Field = string | number | boolean | null | undefined;
log.info(event: string, fields?: Record<string, Field>): void
```

No nested objects. **This one signature makes "someone logged the whole error object and
shipped a bearer token to the vendor" a compile error rather than a code-review catch.** It is
the highest-value line in the package.

Four layers of redaction, in order of reliability:

1. The type signature above.
2. `serializeError(e)` → `{ error_type, error_message, error_stack? }` and nothing else. Never
   `cause` chains, never `e.response` — that is where provider tokens and response bodies live.
3. Key denylist — `/authorization|cookie|token|secret|password|api[_-]?key|sealed/i` →
   `[redacted]`. Throws in dev, redacts in prod.
4. Truncate every string value at 512 chars. `apps/runtime` handles issue bodies and fetched
   pages; one unbounded field blows the 256 KB per-log ceiling and gets truncated upstream.

And: `event` is a stable machine name (`run.claimed`, `shape.proxied`). Untrusted content
never gets interpolated into it — it goes in a field, where JSON encoding neutralises forged
log lines.

**Carry invariant 13 across:** tool payloads never enter Postgres or the UI — nor stdout. Log
the `blob_key`, never the blob.

### D4 — Scope by explicit child loggers, not AsyncLocalStorage

Each tier already has a natural carrier:

- **server** — the handler gets `(request, env, ctx)`; the shape proxy needs a `Ctx` object
  anyway. Put `log` on it.
- **broker** — per-request child, seeded from the inbound `x-relay-request-id`.
- **runtime** — one process per run, so bind `{run_id, agent_id, org_id}` once at startup and
  every line in the process carries it for free.

**Why not ALS:** it works on workerd (`nodejs_compat`, minus `enterWith`/`disable`) and is a
legitimate escape hatch for a deep call site. It is just unnecessary given the above, and
explicit threading is testable.

### D5 — One canonical wide event per unit of work

Accumulate fields on a request-scoped object; flush once at the end. Not five narrow lines per
request.

**Why:** it is the industry pattern (Stripe's canonical log lines, Honeycomb's wide events),
it makes every question a filter instead of a join across lines, and — see _Cost model_ — it
is the difference between ₹0 and ₹7,370/month at 1,000 DAU.

### D6 — OTel semantic conventions are the field vocabulary

Names come from the OTel semconv where one exists (`service.name`, `http.request.method`,
`error.type`). We adopt the **vocabulary**, not the whole SDK.

**Why this is load-bearing:** Loki promotes 17 specific resource attributes to stream labels
by default and drops everything else into structured metadata. Naming per semconv means the
label/metadata split happens with **zero Loki configuration**. Name them `tier` and `env`
instead and you are writing an `otlp_config` override later.

### D7 — OTLP is the only production wire format

Every candidate — Grafana, Axiom, PostHog, SigNoz, Datadog, and Cloudflare's own Destinations
— accepts OTLP. So the vendor is an endpoint plus a header, and switching is two env vars.

### D8 — Three sinks, selected by config, never by call site

```
LOG_SINK=console   # dev default, pretty, TTY-coloured
LOG_SINK=file      # NDJSON to .logs/<service>.ndjson (gitignored)
LOG_SINK=otlp      # production
```

Selected by an explicit env var, **never by `NODE_ENV`**.

`file` matters even in dev: `pnpm dev` runs five processes in parallel and interleaves their
output, so scrollback is near-useless for reconstructing a run. A per-service NDJSON file that
Claude Code greps and pipes through `jq` is the local equivalent of the production MCP path.
Truncate on start and cap the size — `apps/runtime` logs attacker-influenced content.

The pretty renderer should match the existing bootstrap voice (the `✓ / ! / ✗` + dim-hint
style in `tooling/bootstrap/src/doctor.mjs`), so dev output reads as one tool.

### D9 — Vendor: Grafana Cloud, managed

**Decided**, after comparing Axiom, PostHog, Better Stack, SigNoz, OpenObserve, Datadog and
Cloudflare-only.

**Two reasons, and neither is features** — on features alone Axiom wins more rows:

1. **Dev/prod parity of the debugging path.** Grafana runs locally as the identical UI,
   identical LogQL and identical `mcp-grafana` (`grafana/otel-lgtm`), offline and free. Axiom
   is cloud-only — no self-host, no local server, no offline mode — so the local option is
   either a cloud dev dataset or no dashboard at all.

   _Precision, because this was the deciding factor:_ invariant 7's **hard** refusal in
   `tooling/bootstrap/src/index.mjs` covers only data services (Postgres, `ELECTRIC_*`,
   `R2_*`, because of H1). Other remote services warn and proceed — WorkOS already lives
   there. So a cloud dev dataset would have been _tolerated_, not blocked. The argument that
   carries this decision is parity and offline, not a hard invariant violation.

2. **OSS with a real exit.** Grafana and Loki are AGPL-3.0 and self-hostable. Axiom is not.

**What that costs us, stated plainly:** 10× less free ingest (50 GB vs 500 GB), half the
retention (14 vs 30 days), a local MCP binary instead of a hosted endpoint, cardinality
discipline in two places (Loki labels + Prometheus series), and a **3-active-user cap that
will force $19/month the day a teammate joins** — sooner than volume ever will.

### D10 — The Worker exports via Cloudflare Destinations, with `persist: false`

Cloudflare forwards Worker logs **and** traces to any OTLP endpoint, configured in the
dashboard plus a `wrangler.jsonc` reference. No agent, no sidecar, no code changes.

Set `persist: false` so we are not paying to store in Workers Logs _and_ ship to Grafana.
Export is **$0.05/M events vs $0.60/M** to store — 12× cheaper. Requires Workers Paid;
10M events/month included; billing starts 2026-10-01.

This is what dissolves the two-silo problem: the edge tier does not stay stranded in
Cloudflare while the containers go to Grafana.

### D11 — `apps/runtime` holds no vendor credential

An OTLP ingest token **is a secret**, and invariant 6 says that tier holds none. So the
runtime writes stdout JSON and something else forwards it — Cloudflare's automatic container
log capture, or a collector alongside the broker.

This is not only hygiene: it makes the runtime tier's vendor swap zero-touch, because it never
held a vendor reference to change.

### D12 — Local dev is `grafana/otel-lgtm`, wired into `pnpm run up`

One container bundling OTel Collector + Loki + Tempo + Prometheus + Pyroscope + Grafana.
Datasources arrive pre-wired. Grafana on `:3000` (`admin`/`admin`), OTLP in on `:4317/:4318`.

It goes in `services()` next to the Postgres block — same port-conflict check, same
`waitFor`, same closing banner — not as a separate thing to remember. Named volume, so logs
survive a restart the way Postgres data does.

Point `mcp-grafana` at `http://localhost:3000` and Claude Code debugs local runs through the
same tools it will use against production.

### D13 — Sampling: every error, a fraction of successes

No unconditional info line per shape request. One canonical event per request; 100% of errors
and non-2xx; ~1–5% of successes, decided once at ingress and propagated so a sampled request
logs all its lines or none. Half-traces are worse than no traces.

`head_sampling_rate` in `wrangler.jsonc` is the platform-side backstop.

### D14 — `no-console` is enforced as lint

Tighten to `error` under `apps/**`, with `packages/logger` as the only exception.
`eslint.config.mjs` already encodes invariants 6 and 9 this way; this is the same move.

### D15 — Dashboards live in the repo as JSON

Anything you would hate to rebuild goes in `tooling/docker/dashboards/` as exported JSON, not
only clicked into a browser tab. Grafana dashboard JSON is portable between the local stack
and Cloud — which is the one piece of vendor lock-in that packaging discipline cannot remove.

---

## Field taxonomy

Emit in three places. Get this right once, in the package, and every consumer inherits it.

| Emit as                   | Fields                                                                                                           | Lands in Loki as    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Resource attributes**   | `service.name` (`relay-server`/`relay-broker`/`relay-runtime`), `service.version`, `deployment.environment.name` | Stream labels       |
| **Log record attributes** | `run_id`, `parent_run_id`, `request_id`, `org_id`, `workspace_id`, `room_id`, `user_id`, `agent_id`, `worker_id` | Structured metadata |
| **Body + record fields**  | `event`, message, `status`, `dur_ms`, counts, `trace_id`, `span_id`, `severity_number`                           | Log line + record   |

**Invariant 2 applies to logs too.** `org_id` and `workspace_id` ride on every event even
where derivable — you must never join to find out whose log line this is.

**The cardinality rule, in both directions:**

- `run_id` as a **Loki stream label** is a cardinality explosion — one stream per run. It
  belongs in structured metadata.
- `run_id` as a **Prometheus label** blows the 10k-active-series free cap. Metrics get only
  bounded dimensions.

Correlation: seed `request_id` from `cf-ray` at the edge, forward it on server → broker →
runtime, and put it on the `runs` row. When Cloudflare tracing leaves beta, rename to real
`traceparent` propagation — a rename, not a migration, because the names are already OTel's.

---

## The logger API

```ts
export type Field = string | number | boolean | null | undefined;

export interface Scope {
  tier: 'server' | 'broker' | 'runtime';
  request_id?: string;
  org_id?: string;
  workspace_id?: string;
  room_id?: string;
  user_id?: string;
  run_id?: string;
  parent_run_id?: string;
  agent_id?: string;
  worker_id?: string;
}

export interface Logger {
  child(scope: Partial<Scope>): Logger;
  debug(event: string, fields?: Record<string, Field>): void;
  info(event: string, fields?: Record<string, Field>): void;
  warn(event: string, fields?: Record<string, Field>): void;
  error(event: string, fields?: Record<string, Field>): void;
  /** Canonical line: accumulate through the unit of work, flush once. */
  event(fields: Record<string, Field>): Flush;
}
```

Zero dependencies. **Not pino** — see _Rejected_.

---

## Cost model

Assumptions from `ARCHITECTURE.md`: 1,000 DAU → 300K runs/month. Canonical logging is ~50
events per run plus 5%-sampled shape requests; "naive" is ~500 lines per run. ₹94.49/USD.

| DAU   | Canonical | Naive     |
| ----- | --------- | --------- |
| 100   | 1.3 GB/mo | 12 GB/mo  |
| 1,000 | 13 GB/mo  | 120 GB/mo |

At 100 DAU everything is free on every candidate, including Better Stack's 3 GB. At 1,000 DAU:

| Vendor                  | Canonical | Naive  |
| ----------------------- | --------- | ------ |
| Axiom                   | ₹0        | ₹0     |
| Grafana Cloud           | ₹0        | ₹5,008 |
| PostHog                 | ₹71       | ₹2,599 |
| Cloudflare Workers Logs | ₹0        | ₹7,370 |

**Same information, 10× the volume, ₹0 vs ₹7,370.** D5 is not tidiness — it is the bill. Note
it hits per-event pricing (Cloudflare) hardest.

For the full Cloudflare picture including Containers, R2, Browser Rendering and Durable
Objects, see the cost analysis in the design session — logs are ~7% of the bill at 10K DAU;
Containers are 53%.

---

## Local development

```yaml
# tooling/docker/observability.yml
services:
  observability:
    image: grafana/otel-lgtm:latest
    ports: ['3000:3000', '4317:4317', '4318:4318']
    volumes: ['observability-data:/data']
volumes: { observability-data }
```

Then in `services()`, next to the Postgres block: add `[3000, 'Grafana']` to the port-conflict
loop, `docker compose -f tooling/docker/observability.yml up -d`, and
`waitFor('Grafana', () => portOpen(3000))`. Add to the ready banner:

```
grafana   http://localhost:3000 (admin/admin) — logs, traces, dashboards
```

`admin/admin` is a dev-only default on a localhost-bound port. Never expose it.

**The hard rule:** `LOG_SINK=otlp` never points at Grafana Cloud from a dev machine. Local
runs authenticate against the real WorkOS test org, so dev logs carry real tenant ids — and
dev noise burns the retention window you will want during an actual incident. The bootstrap's
existing localhost guard already covers the shape of this.

The Worker is different: it cannot write files, so `LOG_SINK=file` does not apply. Locally
`wrangler dev` prints to the terminal; for a deployed Worker,
`wrangler tail --format json > .logs/server.ndjson` gives Claude Code the same greppable file
without touching quota.

---

## Rejected

| Option                           | Why not                                                                                                                                                         | Revisit if                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **pino**                         | Does not run cleanly on workerd. A library choice means two loggers and two field vocabularies — which defeats the entire exercise                              | Node-side throughput ever matters; swap the sink, not the API                    |
| **AsyncLocalStorage for scope**  | Works, but unnecessary — each tier has a natural carrier (D4)                                                                                                   | A deep call site makes threading genuinely ugly                                  |
| **A logging service**            | Network call per log; a component that is down when you need it most                                                                                            | Never                                                                            |
| **Axiom**                        | 10× free tier and simpler (one store, no cardinality tax, hosted MCP), but cloud-only — no local dashboard, so dev and prod debugging diverge — and no OSS exit | Offline dev parity stops mattering, or the 3-user cap bites harder than expected |
| **PostHog**                      | Best Claude Code integration by far (MCP + CLI + skills), OTLP-native, MIT. Lost on local-dev parity                                                            | Logs need correlating with product analytics or error tracking                   |
| **Cloudflare Workers Logs only** | 7-day cap, container Logpush is Enterprise-only, and H13 concentration is worst exactly here — the logs telling you Cloudflare is down are on Cloudflare        | Never for the whole stack; it stays as the Worker's collector                    |
| **Better Stack**                 | Cheapest per GB (₹9.45/GB EU), but not OSS and no MCP found                                                                                                     | Cost becomes the only axis                                                       |
| **SigNoz Cloud**                 | Apache-2.0 with a hosted MCP, but a ₹4,630/month floor                                                                                                          | Volume grows enough that the floor stops mattering                               |
| **Datadog**                      | $0.10/GB ingest looks cheap, then indexing bills per event — ~₹21,000/month at 100 GB                                                                           | Never at this size                                                               |
| **Self-hosting Loki**            | Costs _more_ than the managed free tier (~₹400–1,100/mo VM) and adds an ops surface. Deferred, not rejected                                                     | Retention past 14 days, or tenant data cannot leave                              |

---

## Hazards

Local to this document. Candidates for the main register are marked.

| #   | Hazard                                    | Consequence                                                                                       | Mitigated by         |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------- |
| L1  | Vendor ingest token in `apps/runtime`     | Invariant 6 violation. A compromised run exfiltrates through it or poisons the stream             | D11 ⬆                |
| L2  | Naive per-call logging                    | 10× volume; ₹0 → ₹7,370/month at 1,000 DAU                                                        | D5, D13 ⬆            |
| L3  | `run_id` as a Loki stream label           | Cardinality explosion, one stream per run; slow and expensive                                     | Taxonomy             |
| L4  | High-cardinality Prometheus labels        | Blows the 10k-active-series free cap                                                              | Taxonomy             |
| L5  | Logging tool payloads                     | Invariant 13 by another door                                                                      | D3                   |
| L6  | Dev logs shipped to the production vendor | Real tenant ids in a third party; burns the retention window you need in an incident              | D12                  |
| L7  | Grafana 3-user cap                        | First teammate forces $19/month — before volume ever does                                         | Accepted             |
| L8  | Faro's collector endpoint is public       | A write endpoint shipped to every client; expect junk in session counts                           | Deferred             |
| L9  | Self-hosted Loki has no authentication    | `auth_enabled: false` means no login at all — anything reaching `:3100` reads every tenant's logs | Only if self-hosting |

---

## Steps

1. `packages/logger` — types, redaction, `serializeError`, `child()`, the canonical `event()`
   accumulator. Zero dependencies.
2. Console and file sinks. Pretty renderer matching the bootstrap voice.
3. `tooling/docker/observability.yml` + `services()` wiring + ready-banner line.
4. `apps/server` as the first consumer: `Ctx` object carrying `log`, one canonical event per
   request, sampling.
5. OTLP sink. Point it at `http://localhost:4318` and confirm the label/metadata split lands
   right in local Loki **before** touching Grafana Cloud.
6. `no-console` tightening in `eslint.config.mjs`.
7. Cloudflare Destinations → Grafana Cloud, `persist: false`.
8. First dashboard; export to `tooling/docker/dashboards/`.
9. `mcp-grafana` wired for local, then for Cloud.

Steps 1–6 are Phase 0 work and independent of any vendor account. Step 7 needs Workers Paid.

---

## Deliberately not built

| Thing                           | Why deferred                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Faro / frontend RUM             | No frontend worth instrumenting until Phase 3–4. Design is settled (L8 applies)                             |
| Pyroscope / profiling           | Genuinely useful for Phase 8's Q13 (checkout vs loop time) — not before                                     |
| Metrics beyond Worker defaults  | Worker infra metrics cannot be OTel-exported anyway; Grafana's Cloudflare integration covers it when needed |
| Electron main-process telemetry | Needs the Node OTel SDK, not Faro. Two SDKs for one app — decide in Phase 4                                 |
| Alerting                        | Nothing to alert on until runs exist                                                                        |

---

## Questions to settle

- **Electric long-poll rate.** The Workers request volume — and therefore the log volume — is
  modelled on 5 live shapes per active user at ~180 requests/shape/hour. That number is
  invented. Measure it in Phase 2; it is the biggest unvalidated input in the cost model.
- **Do container logs reach Cloudflare Destinations?** Container stdout lands in Workers Logs,
  but whether the OTel export includes it is undocumented. If not, the broker and runtime need
  their own collector and D10 covers only the edge tier. **Verify before step 7.**
- **Broker host** (Worker vs container, Phase 5) — decides whether the broker exports directly
  or through a collector. Nothing else depends on it.
- **Sampling rate for shape-proxy successes** — 1% or 5%? Pick after measuring real volume.
- **Where does `apps/desktop` main-process telemetry go**, and does it share the taxonomy?

---

## Done when

- `pnpm run up` brings up Grafana; `http://localhost:3000` shows `apps/server` events.
- A run's logs are reachable from `run_id` in one LogQL query with no join.
- `LOG_SINK` switches console → file → otlp with no call-site change.
- Claude Code answers "why did run X fail" through `mcp-grafana`, locally and in production.
- `pnpm lint` fails on a raw `console.log` in `apps/`.

---

## Candidates for ARCHITECTURE.md

To promote when that file is next edited in its own turn — not as a side effect of this work:

- **The telemetry-out-of-scope line needs qualifying.** It reads as product analytics, but has
  been taken to cover operational logging too. Those are different things.
- **D11 as an invariant-6 corollary** — the tier that runs untrusted code holds no secrets,
  _including a log-vendor ingest token_.
- **D2 as an invariant-11 corollary** — two histories never merged; operational logs are a
  third, and must not borrow the word "trace".
- **L1 and L2 into the Hazards Register.**
- **Invariant 2 applies to log records**, not only to tables.
