# Connectors

A connector is **extension + skills + prompts** — pi's package format. Each folder is its
own workspace package with its own `package.json`, so any one can be extracted and
published later without restructuring.

## The two entry points are a security boundary

| Entry        | Contains                                              | Imported by            |
| ------------ | ----------------------------------------------------- | ---------------------- |
| `./manifest` | tool names, schemas, trace labels, `requiresApproval` | runtime **and** broker |
| `./execute`  | provider calls using the invoker's credential         | **broker only**        |

`apps/runtime` importing `./execute` is invariant 6 violated in the import graph, so the
root eslint config blocks it. If that rule fires, move the work — don't relax the rule.

## Conventions

- **Namespace tool names from the first connector, not the second** (`github.create_issue`).
- Each connector owns its own trace labels via its `tool_call` handler. There is no central
  mapping table to maintain.
- **The skills are the differentiator, not the tools.** Provider tool descriptions say what
  a tool does, not that in your product one call beats three.

`github/` lands in Phase 7 and proves the model. Linear, Slack and Notion follow in Phase 9
— Notion needs the most skill content of the four.
