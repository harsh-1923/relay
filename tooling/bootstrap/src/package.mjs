#!/usr/bin/env node
/**
 * Build a distributable desktop app.
 *
 * Four steps, in this order for a reason:
 *
 *   1. Build the renderer, with `VITE_API_BASE` baked in. A packaged app is served from
 *      `app://relay`, so relative `/auth/...` paths would resolve against that scheme and
 *      reach nothing — the API origin has to be decided at build time.
 *   2. Copy it into `apps/desktop/renderer`, which the `app://` handler serves and
 *      electron-builder includes.
 *   3. Compile the main and preload processes.
 *   4. Hand the lot to electron-builder.
 *
 * **This is a local build, not a release.** No signing, no notarization, no auto-update —
 * those need certificates and a Phase 11 decision about where updates come from. macOS will
 * warn about an unidentified developer; that is expected for an unsigned local build.
 *
 *   pnpm package                       against http://localhost:8787
 *   RELAY_API_BASE=https://… pnpm package   against a deployment
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const API_BASE = process.env.RELAY_API_BASE ?? 'http://localhost:8787';

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const green = (s) => `[32m${s}[0m`;

let step = 0;
const say = (msg) => console.log(`\n${bold(`${++step}/4`)} ${msg}`);

const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

say(`renderer  ${dim(`API base ${API_BASE}`)}`);
run('pnpm', ['--filter', '@relay/client', 'build'], { VITE_API_BASE: API_BASE });

say('bundle    copying the built renderer into the shell');
const from = join(ROOT, 'apps/client/dist');
const to = join(ROOT, 'apps/desktop/renderer');
if (!existsSync(from)) {
  console.error(`\n  the client build produced nothing at ${from}`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });

say('shell     compiling main and preload');
run('pnpm', ['--filter', '@relay/desktop', 'build']);

say('package   electron-builder');
/**
 * `relayApiBase` is written into the packaged `package.json` so the **main** process knows
 * where the server is. The renderer gets the same value through `VITE_API_BASE`, but main
 * needs it independently: it is what `shell.openExternal` opens for sign-in, and taking that
 * URL from the renderer would let the renderer choose what the OS opens.
 */
run('pnpm', [
  '--filter',
  '@relay/desktop',
  'exec',
  'electron-builder',
  '--publish',
  'never',
  `--config.extraMetadata.relayApiBase=${API_BASE}`,
]);

console.log(`\n  ${green('done')}`);
console.log(dim(`    ${join(ROOT, 'apps/desktop/release')}`));
console.log(
  dim(
    '\n    Unsigned, so macOS will need Right-click → Open the first time.\n' +
      `    It talks to ${API_BASE} — that server must be running.\n`,
  ),
);
