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
| `node.json`  | Node libraries and services (`NodeNext` resolution)          |
| `react.json` | Bundled React apps (`react-jsx`, DOM libs, `noEmit`)         |

Add `@relay/tsconfig` to the package's `devDependencies` as `workspace:*`. Install
`@types/node` in the consuming package if you set `"types": ["node"]`.

`base.json` enables `verbatimModuleSyntax`, so a package extending `node.json` must declare
`"type": "module"` in its `package.json` (or use `.mts` files) — otherwise TypeScript treats the
files as CommonJS and rejects ESM `export` syntax.

Unused-variable checks are deliberately left to ESLint rather than `noUnusedLocals` /
`noUnusedParameters`, so they surface as lint warnings instead of breaking builds.
