#!/usr/bin/env node
/**
 * `pnpm tunnel` — expose the local worker so WorkOS can deliver webhooks.
 *
 *   pnpm tunnel              start cloudflared, then point WorkOS at whatever URL it got
 *   pnpm tunnel <url>        point WorkOS at a tunnel you are already running
 *
 * A quick tunnel gets a new hostname on every run, so restarting one is never enough on its
 * own — the registered endpoint keeps pointing at the dead host and delivery silently stops.
 * This syncs the two. The endpoint is PATCHed rather than recreated, so the signing secret
 * in .env stays valid.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENV = join(ROOT, 'apps/server/.env');
const LOCAL = 'http://localhost:8787';

const c = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = c(2);
const die = (msg, hint) => {
  console.error(`\n  ${c(31)('✗')} ${msg}`);
  if (hint) console.error(`      ${dim(hint)}`);
  console.error('');
  process.exit(1);
};

const env = () => {
  if (!existsSync(ENV)) die('apps/server/.env is missing', 'Run `pnpm run up env:setup`.');
  const map = {};
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
};

async function workos(path, method = 'GET', body) {
  const { WORKOS_API_KEY } = env();
  if (!WORKOS_API_KEY || WORKOS_API_KEY === 'set-me')
    die('WORKOS_API_KEY is not set in apps/server/.env');
  const r = await fetch(`https://api.workos.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${WORKOS_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) die(`WorkOS ${method} ${path} → ${r.status}`, (await r.text()).slice(0, 200));
  return r.json();
}

const EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  'organization.created',
  'organization.updated',
  'organization.deleted',
  // Acceptance surfaces as a membership event — that is where an invitee becomes a member of
  // the default workspace, or a guest of specific rooms.
  'organization_membership.created',
  'organization_membership.updated',
  'organization_membership.deleted',
];

/** Points WorkOS at `base`, creating the endpoint if none exists yet. */
async function sync(base) {
  const url = `${base.replace(/\/$/, '')}/webhooks/workos`;
  const { data } = await workos('/webhook_endpoints');

  if (!data.length) {
    const created = await workos('/webhook_endpoints', 'POST', {
      endpoint_url: url,
      events: EVENTS,
    });
    const file = readFileSync(ENV, 'utf8');
    writeFileSync(
      ENV,
      /^WORKOS_WEBHOOK_SECRET=/m.test(file)
        ? file.replace(/^WORKOS_WEBHOOK_SECRET=.*$/m, `WORKOS_WEBHOOK_SECRET=${created.secret}`)
        : `${file.trimEnd()}\nWORKOS_WEBHOOK_SECRET=${created.secret}\n`,
    );
    console.log(`  ${c(32)('✓')} endpoint created, secret written to apps/server/.env`);
    console.log(`      ${dim('restart `pnpm dev` so the worker picks it up')}`);
    return;
  }

  // PATCH keeps the signing secret, so .env does not change.
  await workos(`/webhook_endpoints/${data[0].id}`, 'PATCH', { endpoint_url: url, events: EVENTS });
  console.log(`  ${c(32)('✓')} WorkOS now delivers to ${url}`);
}

const given = process.argv.slice(2).find((a) => a.startsWith('http'));

if (given) {
  await sync(given);
  process.exit(0);
}

console.log(`\n  starting cloudflared → ${LOCAL}\n`);
const proc = spawn('cloudflared', ['tunnel', '--url', LOCAL], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

proc.on('error', () =>
  die(
    'cloudflared is not installed',
    'brew install cloudflared\n      Or run your own tunnel and pass its URL: pnpm tunnel <url>',
  ),
);

let synced = false;
const watch = (chunk) => {
  const text = chunk.toString();
  process.stderr.write(dim(text));
  const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (found && !synced) {
    synced = true;
    void sync(found[0]).then(() =>
      console.log(
        `\n  ${dim('Ctrl-C stops the tunnel. WorkOS will keep pointing here until the next run.')}\n`,
      ),
    );
  }
};
proc.stdout.on('data', watch);
proc.stderr.on('data', watch);

process.on('SIGINT', () => {
  proc.kill('SIGINT');
  process.exit(0);
});
