# relay

A multiplayer agent workspace: Slack-shaped rooms where people and agents work together, shipped as
an Electron desktop app with a webview panel so a room can watch an agent act on a live page.
Local-first, with a browser surface planned.

The repo is currently a monorepo scaffold — no application code yet. Phase 0 is the next thing to build.

## Where the context lives

**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the source of truth.** Read it before proposing
anything structural. It is a working document ordered by implementation sequence, not a reference —
thirteen phases, each carrying its own decisions, steps, nuances, questions to settle and exit
criteria. Two sections at the top apply everywhere and are worth reading first: the **Cross-Cutting
Invariants** (violating one is a design regression, not a trade-off) and the **Hazards Register**.

**[`docs/design-session.md`](docs/design-session.md) is why.** The full 261-message conversation that
produced the architecture, with a topic map at the top. Several decisions were argued, reversed, and
argued back; the losing options and the reasons they lost are recorded there and almost nowhere else.
Search it before re-opening a decision that looks arbitrary.

## Working agreement

- **Do not edit `docs/ARCHITECTURE.md` unless asked to.** It is edited deliberately, in its own turn,
  as decisions are made — not as a side effect of implementation work.
- **Work one phase at a time.** Resolve that phase's _Questions to settle_ before writing its code.
- **Decisions carry their reasoning so they can be re-argued if circumstances change** — not
  re-litigated by default. If new information contradicts one, say so explicitly and cite what changed.
- Open questions are indexed in Appendix A; deliberately deferred work, with reasons, in Appendix B.
