import base from '@relay/eslint-config/base';

/**
 * Architectural boundaries, enforced as lint rather than review.
 *
 * Flat config does not merge `no-restricted-imports` across blocks — a later block that
 * matches the same file replaces the earlier one. So each block below carries every
 * pattern that applies to its files, composed from the shared arrays.
 */

const APPS = ['site', 'client', 'desktop', 'server', 'broker', 'runtime'];

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
    files: ['apps/client/**/*.{ts,tsx}', 'apps/site/**/*.{ts,tsx}'],
    rules: restrict([...crossApp, ...noNativeSqlite]),
  },

  /**
   * One module spells the URL grammar. A route literal anywhere else is how two spellings of
   * the same address start to drift — and `tabs.location` persists them, so a stray one
   * outlives the release that introduced it. See `docs/plans/navigation.md` (D4).
   */
  {
    files: ['apps/client/src/**/*.{ts,tsx}'],
    ignores: ['apps/client/src/lib/paths.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^\\/(w\\/|r\\/|settings|sign-in)/]',
          message: 'Route literals belong in lib/paths.ts. Use paths.* or patterns.*.',
        },
      ],
    },
  },

  {
    files: ['packages/persist-idb/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: restrict(noNativeSqlite),
  },

  // CLIs print.
  { files: ['tooling/**/*.{ts,mts,js,mjs}'], rules: { 'no-console': 'off' } },
];
