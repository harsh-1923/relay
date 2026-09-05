# @relay/runtime

The pi loop. One instance per run.

**Holds: nothing.** This is invariant 6 and it is the reason this app exists separately
from `@relay/broker`.

This process permanently executes attacker-influenced instructions — issue bodies, PR
comments, repo files, fetched pages all reach the model. So:

- No provider token, ever. It posts a tool name and parameters to the broker and receives
  only a result.
- No shell. Path-scoped filesystem tools only.
- No database URL, no object-storage key.
- Imports `@relay/connector-*/manifest` only — **never** `/execute`. Enforced by lint.

pi is a **peer dependency and is never bundled** (H9). A duplicate pi runtime shows up as
bizarre state bugs, not import errors — so this app needs a real Node filesystem and cannot
be a Worker.

Filled in Phase 6.
