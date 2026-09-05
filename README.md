# relay

> Monorepo scaffold. Apps land under `apps/`, shared libraries under `packages/`.

## Requirements

- Node.js — version pinned in [`.nvmrc`](.nvmrc) (`>=22` enforced via `engines`)
- pnpm — version pinned via `packageManager`; enable with `corepack enable`

## Getting started

```bash
pnpm install   # also installs git hooks via the prepare script
pnpm dev
```

## Layout

```
apps/                      # deployable applications
packages/
  eslint-config/           # @relay/eslint-config — shared ESLint flat config
  tsconfig/                # @relay/tsconfig — shared TypeScript configs
```

New packages consume the shared configs with `workspace:*`:

```jsonc
// packages/<name>/package.json
"devDependencies": { "@relay/tsconfig": "workspace:*" }
```

```jsonc
// packages/<name>/tsconfig.json
{ "extends": "@relay/tsconfig/node.json" }
```

ESLint runs from the single root [`eslint.config.mjs`](eslint.config.mjs), so packages need no
config of their own unless they want overrides.

## Scripts

| Script              | Description                              |
| ------------------- | ---------------------------------------- |
| `pnpm build`        | Build every workspace package            |
| `pnpm dev`          | Run every package's dev task in parallel |
| `pnpm lint`         | ESLint across the repo                   |
| `pnpm lint:fix`     | ESLint with `--fix`                      |
| `pnpm typecheck`    | `tsc` in every workspace package         |
| `pnpm test`         | Test every workspace package             |
| `pnpm format`       | Format the repo with Prettier            |
| `pnpm format:check` | Verify formatting (what CI runs)         |
| `pnpm clean`        | Remove build output and `node_modules`   |

## Toolchain notes

TypeScript is pinned to `^6` because `typescript-eslint` does not support TypeScript 7 yet
([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).
Bump once that lands.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/) and are checked by commitlint.

## License

[MIT](LICENSE) © Harsh Sharma
