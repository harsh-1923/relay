import base from '@relay/eslint-config/base';

/**
 * Architectural boundaries, enforced as lint rather than review.
 *
 * Flat config does not merge `no-restricted-imports` across blocks — a later block that
 * matches the same file replaces the earlier one. So each block below carries every
 * pattern that applies to its files, composed from the shared arrays.
 */

const APPS = ['site', 'web', 'desktop', 'server', 'broker', 'runtime'];

/** Invariant 9 — dependencies point from apps into packages, never sideways between apps. */
const crossApp = APPS.map((app) => ({
  group: [`@relay/${app}`, `@relay/${app}/*`],
  message: 'Invariant 9: apps depend on packages, never on each other. Extract to packages/.',
}));

/** Invariant 6 — the tier that runs untrusted code holds no secrets. */
const runtimeIsCredentialFree = [
  {
    group: ['@relay/connector-*/execute'],
    message:
      'Invariant 6: /execute resolves the invoker credential and belongs to the broker. ' +
      'The runtime imports /manifest and asks the broker for the result.',
  },
];

/** The native module must never be reachable from a browser bundle. */
const noNativeSqlite = [
  {
    group: ['@relay/persist-sqlite', '@relay/persist-sqlite/*'],
    message: 'better-sqlite3 cannot ship to a browser. Use @relay/persist-idb.',
  },
];

const restrict = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

export default [
  ...base,

  { files: ['apps/**/*.{ts,tsx}'], rules: restrict(crossApp) },

  {
    files: ['apps/runtime/**/*.{ts,tsx}'],
    rules: restrict([...crossApp, ...runtimeIsCredentialFree]),
  },

  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/site/**/*.{ts,tsx}'],
    rules: restrict([...crossApp, ...noNativeSqlite]),
  },

  {
    files: ['packages/persist-idb/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: restrict(noNativeSqlite),
  },

  // CLIs print.
  { files: ['tooling/**/*.{ts,mts,js,mjs}'], rules: { 'no-console': 'off' } },
];
