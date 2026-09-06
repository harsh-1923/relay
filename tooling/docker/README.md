# Local services

Postgres comes from `supabase start`, which manages its own containers — see `../../supabase`.

Nothing else runs in Docker yet. **Electric lands here in Phase 2**, as a `compose.yaml`
against the same local Postgres.

| Layer               | Locally                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Postgres            | `supabase start` — full control including replication slots                                                                    |
| Electric            | Docker (open source), against the local Postgres — Phase 2                                                                     |
| API server / broker | `wrangler dev` (workerd)                                                                                                       |
| R2, Durable Objects | `wrangler dev` (emulated)                                                                                                      |
| Sandbox             | Docker via `wrangler dev` — **egress interception works locally**, so the open-then-lock pattern is testable without deploying |
| pi                  | Node library, pointed at local vLLM or Ollama                                                                                  |
| **WorkOS**          | **Not local.** See `apps/server/README.md`                                                                                     |

WorkOS is the one dependency this stack does not run locally. A local emulator was set up and
then removed: with a real environment as the default, it was a second world to keep in sync
that nobody ran. Bring it back when tests need a WorkOS that shares no state between runs —
that is the trigger, and `@workos/emulate` is the package.
