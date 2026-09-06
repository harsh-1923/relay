# Local services

Postgres comes from `supabase start`, which manages its own containers — see `../../supabase`.
Everything else that needs Docker is in `compose.yaml`, started by `pnpm run up` and stopped by
`pnpm services:stop`.

| Layer               | Locally                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Postgres            | `supabase start` — full control including replication slots                                                                    |
| **Electric**        | **`compose.yaml` — `electricsql/electric:1.8.0` on :54330, against the same Postgres**                                         |
| API server / broker | `wrangler dev` (workerd)                                                                                                       |
| R2, Durable Objects | `wrangler dev` (emulated)                                                                                                      |
| Sandbox             | Docker via `wrangler dev` — **egress interception works locally**, so the open-then-lock pattern is testable without deploying |
| pi                  | Node library, pointed at local vLLM or Ollama                                                                                  |
| **WorkOS**          | **Not local.** See `apps/server/README.md`                                                                                     |

WorkOS is the one dependency this stack does not run locally. A local emulator was set up and
then removed: with a real environment as the default, it was a second world to keep in sync
that nobody ran. Bring it back when tests need a WorkOS that shares no state between runs —
that is the trigger, and `@workos/emulate` is the package.

## Electric

Self-hosted because Electric Cloud is winding down after the Databricks acquisition. The engine
stays Apache 2.0; the managed offering does not. See `docs/plans/local-first.md`.

It joins the network `supabase start` creates (`supabase_network_<project_id>`) and reaches the
database container directly, so `DATABASE_URL` is a **direct** connection — poolers do not carry
logical replication, and this is the line that matters when this moves to a deployed
environment.

```
curl localhost:54330/v1/health                  # {"status":"active"}
curl 'localhost:54330/v1/shape?table=rooms&offset=-1&secret=…'
docker logs -f relay_electric
```

`ELECTRIC_SECRET` is required on every request. Electric's HTTP API is otherwise public and
exposes anything its database user can read — the shape proxy adds the header, and a client must
never see it. The value in `compose.yaml` is local-only.

### The slot is the hazard

Electric owns a replication slot named `electric_slot_relay_local`. **An inactive slot retains
WAL forever, and Supabase disk grows and never shrinks** — so an Electric that has been stopped
while its slot survives is worse than one that was never started. `pnpm health` checks exactly
this, and reports the retained WAL:

```
electric
  ✓ reachable on :54330 — replication active
  ✓ slot active, 232 bytes of WAL retained
```

If you tear the containers down by hand and the slot is left behind:

```sql
select pg_drop_replication_slot('electric_slot_relay_local');
```

`ELECTRIC_REPLICATION_STREAM_ID` names the slot and publication, so a second Electric against
this database — a test run, a colleague's branch — cannot silently adopt ours.

### The volume

`electric_data` holds the shape logs and their metadata. It is **derived**: lose it and Electric
rebuilds from Postgres, so there is nothing to back up. What it costs is that every connected
client takes a `must-refetch` and re-syncs, which is survivable and is why the volume exists at
all rather than running stateless.
