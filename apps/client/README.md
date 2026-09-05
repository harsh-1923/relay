# @relay/client

**The UI. One build, two distributions** — deployed as the browser surface, and zipped into
the desktop UI bundle the Electron shell loads from local disk (Phase 11).

Vite · React · Tailwind v4 · React Router · shadcn (`components.json` points at
`src/components/ui`, so `shadcn add` lands in the right place).

```
pnpm dev            # with the server, both surfaces
pnpm dev:desktop    # the above plus the Electron shell
```

## Dev is same-origin, on purpose

`vite.config.ts` proxies `/auth` and `/api` to the worker on `:8787` **without rewriting
Host**. So the browser sees one origin in development exactly as it does in production, the
sealed session cookie behaves identically in both, and `/auth/login` derives its
`redirect_uri` from the origin you are actually using.

The alternative — talking to `:8787` directly — would need CORS and `SameSite=None` that
production never uses, which is divergence in the one place you cannot afford it.

## Scope

Auth only: sign in, see who you are, sign out. Screens arrive in Phase 2 against live
TanStack DB collections — building them now against mock data means rewriting them, because
a live query has a different shape than props.

The client never parses a session. It asks `/auth/session`, which is the only place
`unsealSession()` runs. On the browser that request carries a cookie; on desktop
`lib/session.ts` gets a token from the bridge and sends it as a bearer, and re-fetches when
the shell says the session changed — sign-in completes in another application.
