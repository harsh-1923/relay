# Contributing

Thanks for taking the time to contribute.

## Setup

```bash
corepack enable
pnpm install
```

`pnpm install` runs `husky` through the `prepare` script, which installs the git hooks:

- **pre-commit** — runs `lint-staged` (Prettier over staged files)
- **commit-msg** — runs `commitlint` over the message

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`.

Examples:

```
feat(api): add message relay endpoint
fix: handle empty payload without throwing
chore(deps): bump prettier to 3.9
```

Breaking changes use `!` after the type/scope (`feat(api)!: drop v1 routes`) or a
`BREAKING CHANGE:` footer.

The subject line is capped at 100 characters, stays in the imperative mood, and takes no
trailing period.

## Pull requests

1. Branch off `main` (`feat/short-name`, `fix/short-name`).
2. Keep the change focused; unrelated cleanups belong in their own PR.
3. Make sure these pass locally — CI runs the same commands:
   ```bash
   pnpm format:check
   pnpm lint
   pnpm typecheck
   pnpm build
   pnpm test
   ```
4. Fill in the PR template and link any related issue.

## Code style

Prettier owns formatting — do not hand-format; `eslint-config-prettier` disables every ESLint
rule that would fight it. `.editorconfig` covers editors that are not Prettier-aware.

Lint and TypeScript rules are shared:

- [`@relay/eslint-config`](packages/eslint-config) — one flat config, applied repo-wide from the
  root `eslint.config.mjs`
- [`@relay/tsconfig`](packages/tsconfig) — `base` / `node` / `react` presets to extend

Change a rule in the shared package rather than adding per-package exceptions, unless the
exception is genuinely local.
