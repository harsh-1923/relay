# @relay/eslint-config

Shared ESLint [flat config](https://eslint.org/docs/latest/use/configure/configuration-files).

The repo is linted from a single root `eslint.config.mjs`, so most packages need nothing. To
override rules for one package, add a scoped block to the root config:

```js
import base from '@relay/eslint-config/base';

export default [
  ...base,
  {
    files: ['apps/api/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
```

Prettier is applied last via `eslint-config-prettier`, so ESLint never reports formatting.
