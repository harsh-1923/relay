# relay

A multiplayer agent workspace: Slack-shaped rooms where people and agents work together, shipped as
an Electron desktop app with a webview panel so a room can watch an agent act on a live page.
Local-first, with a browser surface planned.

**Phase 0 is built.** Workspace, `packages/schema` (Drizzle → generated migrations), five
tenancy tables, local Postgres, and `pnpm run up` / `pnpm health`. **Phase 1 has started:** the
AuthKit round trip works in `apps/server`; the webhook handlers and the signup path do not
exist, so Postgres is empty by design.

```
pnpm run up      infrastructure          pnpm health        is it actually working
pnpm dev         apps (:8787)            pnpm services:stop tear down
```

WorkOS is the one dependency that is not local — point `.env` at an environment that never
serves production traffic.

## Where the context lives

`[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)` **is the source of truth.** Read it before proposing
anything structural. It is a working document ordered by implementation sequence, not a reference —
thirteen phases, each carrying its own decisions, steps, nuances, questions to settle and exit
criteria. Two sections at the top apply everywhere and are worth reading first: the **Cross-Cutting
Invariants** (violating one is a design regression, not a trade-off) and the **Hazards Register**.

`[docs/design-session.md](docs/design-session.md)` **is why.** The full 261-message conversation that
produced the architecture, with a topic map at the top. Several decisions were argued, reversed, and
argued back; the losing options and the reasons they lost are recorded there and almost nowhere else.
Search it before re-opening a decision that looks arbitrary.

## Working agreement

- **Do not edit** `docs/ARCHITECTURE.md` **unless asked to.** It is edited deliberately, in its own turn,
  as decisions are made — not as a side effect of implementation work.
- Always ask clarifying questions when needed
- Write comments iff needed
- **Work one phase at a time.** Resolve that phase's _Questions to settle_ before writing its code.
- **Decisions carry their reasoning so they can be re-argued if circumstances change** — not
  re-litigated by default. If new information contradicts one, say so explicitly and cite what changed.
- Open questions are indexed in Appendix A; deliberately deferred work, with reasons, in Appendix B.

## Stack and documentation

Fetch current docs before answering from memory — several of these move fast, and the
architecture depends on version-specific behaviour in Cloudflare, Drizzle, pi and TanStack DB.

### llms.txt — prefer these, they are written for this

|            |                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Cloudflare | https://developers.cloudflare.com/llms.txt · [full](https://developers.cloudflare.com/llms-full.txt) |
| WorkOS     | https://workos.com/docs/llms.txt                                                                     |
| Drizzle    | https://orm.drizzle.team/llms.txt · [full](https://orm.drizzle.team/llms-full.txt)                   |
| Electric   | https://electric-sql.com/llms.txt                                                                    |
| TanStack   | https://tanstack.com/llms.txt                                                                        |
| Supabase   | https://supabase.com/llms.txt                                                                        |
| Zod        | https://zod.dev/llms.txt                                                                             |
| Vitest     | https://vitest.dev/llms.txt                                                                          |
| Vite       | https://vite.dev/llms.txt                                                                            |
| MCP        | https://modelcontextprotocol.io/llms.txt                                                             |

No llms.txt: Electron, pnpm, better-sqlite3, pi.

### By layer

| Layer                                     | Docs                                                                                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity** — WorkOS                     | [User Management](https://workos.com/docs/user-management) · [Webhooks](https://workos.com/docs/events/data-syncing/webhooks) · [Pipes](https://workos.com/docs/pipes) (Phase 7)                                      |
| **Schema** — Drizzle                      | [drizzle-kit](https://orm.drizzle.team/docs/kit-overview) — generate only, never `push`                                                                                                                               |
| **Postgres** — Supabase                   | [Local development](https://supabase.com/docs/guides/local-development)                                                                                                                                               |
| **Sync** — Electric + TanStack DB         | [Shapes](https://electric-sql.com/docs/guides/shapes) · [TanStack DB](https://tanstack.com/db/latest/docs/overview)                                                                                                   |
| **Edge / storage / sandbox** — Cloudflare | [Workers](https://developers.cloudflare.com/workers/) · [R2](https://developers.cloudflare.com/r2/) · [Queues](https://developers.cloudflare.com/queues/) · [Sandbox SDK](https://developers.cloudflare.com/sandbox/) |
| **Agent harness** — pi                    | [earendil-works/pi](https://github.com/earendil-works/pi) — no MCP, no permission system; read the README before Phase 6                                                                                              |
| **Desktop** — Electron                    | [electron-builder](https://www.electron.build/) · [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)                                                                                                        |
| **Reference implementation**              | [juspay/xyne-spaces](https://github.com/juspay/xyne-spaces) — Apache-2.0, runs pi in production. Read `apps/xyne-claw` and `apps/xyne-claw-auth` before Phases 5–8; the comments document failures already paid for.  |

### Version-sensitive, verify rather than recall

- **Cloudflare Sandbox SDK** is at 1.0 preview and its HTTP/WebSocket transports are already
  deprecated in favour of RPC. Pin the version; keep it behind a thin interface.
- **pi** moved from `badlogic/pi-mono` and renamed `@mariozechner/*` → `@earendil-works/*`.
- **TanStack DB** persistence (`persistedCollectionOptions`, `db-sqlite-persistence-core`) is
  recent enough that Phase 4's estimate depends on checking what actually ships.
