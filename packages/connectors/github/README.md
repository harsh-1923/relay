# @relay/connector-github

The first connector, and the one that proves the credential model. Phase 7.

Tokens are scoped **per user, per organization** — `getAccessToken({ provider, userId,
organizationId })`, both IDs, always. The token belongs to whoever _invoked_ the run, not
whoever authored the agent; an agent is a recipe, credentials attach at invocation.

Fetch at point of use, not at run start — a 10-minute PR task can outlive a short-lived
token. Re-fetch on 401 and retry.

Build the **GitHub App** path alongside personal OAuth. GitHub OAuth grants are per account,
not per workspace, so the personal-account model is not something an enterprise will accept.
