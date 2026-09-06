# @relay/tsconfig

Shared TypeScript configs. Consume from a workspace package:

```json
{
  "extends": "@relay/tsconfig/node.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

| Config       | For                                                          |
| ------------ | ------------------------------------------------------------ |
| `base.json`  | Everything — strict flags, ES2022 target, declaration output |
| `node.json`  | Node libraries and services — no DOM libs                    |
| `react.json` | Bundled React apps (`react-jsx`, DOM libs, `noEmit`)         |

Add `@relay/tsconfig` to the package's `devDependencies` as `workspace:*`. Install
`@types/node` in the consuming package if you set `"types": ["node"]`.

`base.json` enables `verbatimModuleSyntax`, so a package extending `node.json` must declare
`"type": "module"` in its `package.json` (or use `.mts` files) — otherwise TypeScript treats the
files as CommonJS and rejects ESM `export` syntax.

Both configs use `Bundler` module resolution, so relative imports stay extensionless. That is
not a shortcut: every package in this workspace ships uncompiled TypeScript and every consumer
bundles it, so nothing here is ever resolved by Node itself. `NodeNext` would force `./x.js`
specifiers pointing at `./x.ts` files — an artefact of a build step this repo deliberately
does not have. Revisit only if something starts running raw TypeScript through Node's own
resolver.

Unused-variable checks are deliberately left to ESLint rather than `noUnusedLocals` /
`noUnusedParameters`, so they surface as lint warnings instead of breaking builds.
