# Postman

`relay.postman_collection.json` — every HTTP endpoint the server serves.
`relay.local.postman_environment.json` — pointed at `wrangler dev` on :8787.

Import both, pick the **relay — local** environment.

## Getting a session

AuthKit owns the sign-in round trip, so a session cannot be minted from Postman.

```
pnpm run up && pnpm dev
```

Sign in at <http://localhost:5173>, then copy the `relay_session` cookie value
(DevTools → Application → Cookies) into the `session` variable.

`unsealSession()` reads `Authorization: Bearer` before it reads the cookie, and both carry
the same sealed value — so the browser's cookie works unchanged as a Postman bearer token.

The desktop PKCE path is in folder 1 if you would rather mint one that way; its pre-request
script generates the verifier and challenge, and **Exchange** writes the seal into `session`
for you.

## Token refresh

A seal expires. When the server refreshes one mid-request it returns the new seal in the body
as `refreshedSession` for bearer callers — a collection-level test script rolls `session`
forward, so a long run does not fall over halfway.

## What is deliberately missing

**There are no room, chat or message endpoints.** Rooms, conversations, messages, panels and
their four authorisation paths exist as schema and as server-side modules — `src/rooms.ts`,
`src/access.ts`, `src/actors.ts` — with tests behind them. Nothing routes to them yet:

| Surface                    | Where it will live                      | Phase |
| -------------------------- | --------------------------------------- | ----- |
| Reading rooms and messages | Electric shapes through the shape proxy | 2     |
| Writing them               | The write endpoint                      | 3     |

Neither is built, so neither is in here. Nothing was invented to fill the gap.

## Webhooks

`/webhooks/workos` is unreachable from WorkOS locally without a tunnel — `pnpm tunnel` opens
one and re-points WorkOS in a single step. The request in folder 4 sends an unsigned body and
expects a 401, which is worth running: it proves the signature check is on, and that it says
nothing about _why_ it failed.
