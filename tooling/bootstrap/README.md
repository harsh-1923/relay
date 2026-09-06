# @relay/bootstrap

`pnpm run up`. Five phases, serial, stopping at the first failure, each **idempotent** and
independently runnable.

```
pnpm run up               all phases
pnpm run up services      just one
pnpm run up:reconfigure   re-ask the remembered questions
pnpm health               is this checkout actually working?
pnpm services:stop        stop everything
RELAY_YES=1 pnpm run up   never prompt (implied by CI or a non-TTY)
```

`health` is named that way because `pnpm doctor` is a pnpm builtin and silently shadows a
script of the same name.

## What `health` checks

Docker, `.env` files, leftover `set-me` placeholders, Postgres reachability, migrations
applied vs on disk, seed data — and then the one that matters:

**WorkOS and Postgres must describe the same world.** Postgres is a read replica of WorkOS,
so every id our tables reference has to exist upstream. When it does not, a real login hands
back a `user_…` that is a foreign key to nothing — silent at runtime, obvious here. The
check also catches the bootstrap picker and `.env` disagreeing about which WorkOS is in use.

| Phase       | What it does                                                                      |
| ----------- | --------------------------------------------------------------------------------- |
| `env:setup` | Copies each app's `.env.example` to `.env` — **never overwrites** an existing one |
| `setup`     | Installs workspace dependencies (nothing to build: packages ship source)          |
| `secrets`   | Generates `signing-key.pem` and replaces every `set-me` with a random value       |
| `services`  | Docker check, **localhost guard**, port checks, Postgres, migrations, WorkOS      |
| `dev`       | App picker and process TUI — empty until apps actually run                        |

Zero dependencies, deliberately. This is the first thing a new checkout runs, so it must
work before anything is installed and must not break when a dependency does.

## The localhost guard

`services` refuses to start if any URL in any `.env` resolves to a non-local host, naming
the file and variable.

This is invariant 7 made executable. The failure it guards against is a local run writing to
a production replication slot (H1): unbounded WAL growth, and Supabase disk grows and never
shrinks. It is the hazard most likely to cause an unrecoverable incident, and it begins with
one wrong URL in a `.env`.

## Details that earn their keep

- **Port checks name the process holding the port**, with its pid — the single most common
  first-run failure. Ports published by a running container are not a conflict; that is
  resolved by asking Docker what it publishes, not by matching the holder's process name,
  which is `com.docke` on Docker Desktop, `OrbStack`, `dockerd`, or something else again.
- **Migrations are verified against the ledger, not assumed.** `supabase start` can restore
  a cached snapshot and silently skip pending migrations — it did exactly that on first run
  here. The phase compares `supabase/migrations/*.sql` against
  `supabase_migrations.schema_migrations` and only resets when something is genuinely pending.
- **A reset that would drop data asks first**, and remembers the answer in
  `.relay-bootstrap.json` (gitignored). A fresh database never asks.
- **Two placeholder markers, because they mean different things.** `generate-me` is a
  local-only value, so a random one is always correct. `set-me` comes from outside — a
  dashboard, a provider console — and generating a random value for one of those would
  produce a credential that looks set and fails at the first call, which is worse than an
  obvious placeholder.

Write this before the second developer joins. It is cheap at three services and expensive to
retrofit at ten.
