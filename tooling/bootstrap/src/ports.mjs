#!/usr/bin/env node
/**
 * Runs before `pnpm dev`. Wrangler's own error for a busy port is a kj::Exception stack
 * trace that says nothing about *what* is holding it — usually a dev server someone forgot
 * about. This names the process and offers the kill.
 */

import { spawnSync } from 'node:child_process';

const PORTS = [
  [8787, 'server (wrangler)'],
  [5173, 'client (vite)'],
];

const c = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const busy = [];

for (const [port, what] of PORTS) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const line = (r.stdout ?? '').split('\n')[1];
  if (!line) continue;
  const [command, pid] = line.trim().split(/\s+/);
  busy.push({ port, what, command, pid });
}

if (busy.length) {
  console.error(
    `\n  ${c(31)('✗')} ${busy.length} port${busy.length === 1 ? ' is' : 's are'} already in use\n`,
  );
  for (const b of busy)
    console.error(`      :${b.port}  ${b.what} — held by ${b.command} (pid ${b.pid})`);
  console.error(
    `\n  ${c(2)('Almost always a dev server still running from earlier. To free them:')}\n` +
      `      kill ${busy.map((b) => b.pid).join(' ')}\n`,
  );
  process.exit(1);
}
