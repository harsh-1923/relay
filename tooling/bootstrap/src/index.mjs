#!/usr/bin/env node
/**
 * `pnpm run up` — the bootstrap contract.
 *
 * Phases run serially and stop at the first failure. Every phase is idempotent: re-running
 * on an existing checkout is safe, and any phase can run on its own:
 *
 *   pnpm run up              all phases
 *   pnpm run up services     just that one
 *   RELAY_YES=1 pnpm run up  never prompt (also implied by CI or a non-TTY)
 *
 * No dependencies. This is the first thing a new checkout runs, so it must work before
 * anything is installed and must not break when a dependency does.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ANSWERS = join(ROOT, '.relay-bootstrap.json');
const NON_INTERACTIVE = !!process.env.RELAY_YES || !!process.env.CI || !process.stdin.isTTY;

// ── output ────────────────────────────────────────────────────────────────────
const c = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = c(2);
const bold = c(1);
const green = c(32);
const yellow = c(33);
const red = c(31);

const step = (s) => console.log(`  ${green('✓')} ${s}`);
const skip = (s) => console.log(`  ${dim('·')} ${dim(s)}`);
const warn = (s) => console.log(`  ${yellow('!')} ${s}`);
const phase = (s) => console.log(`\n${bold(s)}`);

class Fail extends Error {}
const fail = (msg, hint) => {
  throw new Fail(hint ? `${msg}\n    ${dim(hint)}` : msg);
};

// ── helpers ───────────────────────────────────────────────────────────────────
const rel = (p) => relative(ROOT, p) || '.';

function run(cmd, args, { quiet = true } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
    fail(`${cmd} ${args.join(' ')} failed`, out.split('\n').slice(-4).join('\n    '));
  }
  return (r.stdout ?? '').trim();
}

function tryRun(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const answers = () => (existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, 'utf8')) : {});
const remember = (k, v) =>
  writeFileSync(ANSWERS, JSON.stringify({ ...answers(), [k]: v }, null, 2) + '\n');

/** Pickers remember the previous answer, and scripted runs never hang on a question. */
async function confirm(key, question, fallback) {
  const prior = answers()[key];
  if (NON_INTERACTIVE) return prior ?? fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const def = prior ?? fallback;
  const a = (await rl.question(`  ${question} ${dim(def ? '[Y/n]' : '[y/N]')} `))
    .trim()
    .toLowerCase();
  rl.close();
  const value = a === '' ? def : a.startsWith('y');
  remember(key, value);
  return value;
}

function envFiles() {
  const out = [];
  for (const group of ['apps', 'packages', 'tooling']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const example = join(base, name, '.env.example');
      if (existsSync(example)) out.push({ example, env: join(base, name, '.env') });
    }
  }
  return out;
}

/** Ports published by running containers, whatever Docker runtime is in use. */
function dockerPublishedPorts() {
  const { ok, out } = tryRun('docker', ['ps', '--format', '{{.Ports}}']);
  const ports = new Set();
  if (ok) for (const m of out.matchAll(/:(\d+)->/g)) ports.add(Number(m[1]));
  return ports;
}

/** Names the process holding a port — the single most common first-run failure. */
function portHolder(port) {
  const { ok, out } = tryRun('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (!ok || !out) return null;
  const line = out.split('\n')[1];
  if (!line) return null;
  const [command, pid] = line.trim().split(/\s+/);
  return { command, pid };
}

const portOpen = (port) =>
  new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' })
      .on('connect', () => (s.destroy(), res(true)))
      .on('error', () => res(false));
    setTimeout(() => (s.destroy(), res(false)), 500);
  });

async function waitFor(label, check, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${label} did not become ready`);
}

const projectId = () => {
  const m = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8').match(
    /^project_id\s*=\s*"([^"]+)"/m,
  );
  return m ? m[1] : 'relay';
};

// ── phase: env:setup ──────────────────────────────────────────────────────────
function envSetup() {
  phase('env:setup');
  let copied = 0;
  for (const { example, env } of envFiles()) {
    if (existsSync(env)) {
      skip(`${rel(env)} exists, left alone`);
      continue;
    }
    copyFileSync(example, env); // never overwrites — an existing .env is the developer's
    step(`${rel(env)}`);
    copied++;
  }
  if (!copied) skip('nothing to copy');
}

// ── phase: setup ──────────────────────────────────────────────────────────────
function setup() {
  phase('setup');
  run('pnpm', ['install'], { quiet: true });
  step('workspace dependencies installed');
  // Nothing to build: every package ships uncompiled TypeScript and each app bundles it.
  skip('no shared packages to build (packages ship source)');
}

// ── phase: secrets ────────────────────────────────────────────────────────────
function secrets() {
  phase('secrets');

  // Two markers, because they mean different things:
  //   generate-me  a local-only value; a random one is always correct
  //   set-me       comes from outside (a dashboard, a provider). Generating a random value
  //                here would produce a credential that looks set and fails at the first
  //                call — worse than an obvious placeholder.
  let filled = 0;
  const outstanding = [];
  for (const { env } of envFiles()) {
    if (!existsSync(env)) continue;
    const before = readFileSync(env, 'utf8');
    const after = before.replace(/^(\w+)=generate-me$/gm, (_, k) => {
      filled++;
      return `${k}=${randomBytes(32).toString('base64url')}`;
    });
    if (after !== before) writeFileSync(env, after);
    for (const m of after.matchAll(/^(\w+)=set-me$/gm)) outstanding.push(`${rel(env)} → ${m[1]}`);
  }

  if (filled) step(`${filled} local secret${filled === 1 ? '' : 's'} generated`);
  else skip('no `generate-me` placeholders left');

  if (outstanding.length) {
    warn(`${outstanding.length} value${outstanding.length === 1 ? '' : 's'} you must supply:`);
    for (const o of outstanding) console.log(`      ${yellow(o)}`);
  }
}

// ── the localhost guard ───────────────────────────────────────────────────────
/**
 * Invariant 7: the stack runs locally with no managed-service dependency.
 *
 * The invariant names three things — "a production Postgres, Electric project or R2 bucket"
 * — because the hazard is H1: a stray replication slot on a managed Postgres grows the WAL
 * without bound, and Supabase disk grows and never shrinks. Those are a hard refusal.
 *
 * Everything else is a warning, not a block. A real WorkOS environment is the second tier
 * the architecture explicitly prescribes, and provider OAuth cannot be local at all — so
 * refusing every non-local URL would forbid a workflow the design calls for. Print where it
 * points, loudly, and let it through.
 */
const LOCAL =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|.*\.(test|local|localhost))$/i;
const HARD = /^(ELECTRIC_|R2_)/;

function assertEverythingIsLocal() {
  const blocked = [];
  const remote = [];
  for (const { env } of envFiles()) {
    if (!existsSync(env)) continue;
    for (const line of readFileSync(env, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=((?:https?|postgres(?:ql)?):\/\/\S+)$/);
      if (!m) continue;
      let url;
      try {
        url = new URL(m[2]);
      } catch {
        continue;
      }
      if (LOCAL.test(url.hostname)) continue;
      const isData = url.protocol.startsWith('postgres') || HARD.test(m[1]);
      (isData ? blocked : remote).push(`${rel(env)} → ${m[1]} points at ${url.hostname}`);
    }
  }

  if (blocked.length) {
    fail(
      `refusing to start: ${blocked.length} non-local data URL${blocked.length === 1 ? '' : 's'}\n    ` +
        blocked.join('\n    '),
      'A local run must never reach a managed Postgres, Electric project or R2 bucket.\n    ' +
        'A stray replication slot grows the WAL without bound and the disk never shrinks (H1).',
    );
  }

  if (remote.length) {
    warn(`${remote.length} service${remote.length === 1 ? ' is' : 's are'} remote, not local:`);
    for (const r of remote) console.log(`      ${yellow(r)}`);
  } else {
    step('every configured URL is local');
  }
}

// ── phase: services ───────────────────────────────────────────────────────────
async function services() {
  phase('services');

  if (!tryRun('docker', ['info', '--format', '{{.ServerVersion}}']).ok) {
    fail('Docker is not running', 'Start Docker Desktop and run `pnpm run up services` again.');
  }
  step('docker is running');

  assertEverythingIsLocal();

  // Ask Docker which ports it publishes rather than guessing from the holder's process
  // name — that is `com.docke` on Docker Desktop, `OrbStack` here, `dockerd` on Linux, and
  // something else on colima. A container we already run is not a conflict.
  const ours = dockerPublishedPorts();
  for (const [port, what] of [
    [54322, 'Postgres'],
    [54323, 'Supabase Studio'],
  ]) {
    if (ours.has(port)) {
      skip(`:${port} already served by ${what}`);
      continue;
    }
    const holder = portHolder(port);
    if (!holder) continue;
    fail(
      `port ${port} (${what}) is held by ${holder.command} (pid ${holder.pid})`,
      `Stop it, or run \`kill ${holder.pid}\`, then try again.`,
    );
  }

  // Postgres
  run('pnpm', ['exec', 'supabase', 'start']);
  await waitFor('Postgres', () => portOpen(54322));
  step('postgres :54322 · studio :54323');

  // `supabase start` can restore a cached snapshot and silently skip pending migrations, so
  // compare the ledger against what is on disk rather than trusting that it ran them.
  const onDisk = readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.split('_')[0]);
  const ledger = tryRun('docker', [
    'exec',
    `supabase_db_${projectId()}`,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-Atc',
    'select version from supabase_migrations.schema_migrations',
  ]);
  const applied = new Set(ledger.ok ? ledger.out.split('\n').filter(Boolean) : []);
  const pending = onDisk.filter((v) => !applied.has(v));

  if (!pending.length) {
    skip(`${onDisk.length} migration${onDisk.length === 1 ? '' : 's'} already applied`);
  } else {
    const wipes = applied.size > 0;
    if (wipes) warn(`${pending.length} pending migration(s); a reset will drop local data`);
    const go = wipes ? await confirm('db.reset', 'Reset the local database?', true) : true;
    if (go) {
      run('pnpm', ['exec', 'supabase', 'db', 'reset']);
      step(`${pending.length} migration(s) applied, seed.sql run`);
    } else {
      warn('skipped — schema is behind the migrations on disk');
    }
  }

  const server = readEnv(join(ROOT, 'apps/server/.env'));
  if (!server.WORKOS_API_KEY || server.WORKOS_API_KEY === 'set-me') {
    fail(
      'WORKOS_API_KEY is not set in apps/server/.env',
      'Get it from the WorkOS dashboard (API Keys), in an environment that never serves\n    ' +
        'production traffic. WorkOS is the one service this stack does not run locally.',
    );
  }
  step(`workos: ${server.WORKOS_API_URL}`);
}

function readEnv(file) {
  const map = {};
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

// ── phase: dev ────────────────────────────────────────────────────────────────
function dev() {
  phase('dev');
  step('pnpm dev       — server :8787, client :5173, and the Electron window');
  step('pnpm dev:web   — the same without the window');
  step('pnpm dev:shell — restart only Electron, against a dev server already running');
  skip('apps/site, broker and runtime are still Phase 0 stubs');
}

// ── main ──────────────────────────────────────────────────────────────────────
const PHASES = {
  'env:setup': envSetup,
  setup,
  secrets,
  services,
  dev,
};

const argv = process.argv.slice(2);
if (argv.includes('--reconfigure') && existsSync(ANSWERS)) rmSync(ANSWERS);
const asked = argv.filter((a) => !a.startsWith('-'));
const unknown = asked.filter((a) => !(a in PHASES));
if (unknown.length) {
  console.error(
    `unknown phase: ${unknown.join(', ')}\navailable: ${Object.keys(PHASES).join(', ')}`,
  );
  process.exit(2);
}
const selected = asked.length ? asked : Object.keys(PHASES);

console.log(bold('\n  relay') + dim(` — ${selected.join(' → ')}`));

try {
  for (const name of selected) await PHASES[name]();
} catch (e) {
  console.error(`\n  ${red('✗')} ${e instanceof Fail ? e.message : (e.stack ?? e)}\n`);
  process.exit(1);
}

console.log(`\n  ${green('ready')}`);
console.log(`    studio    ${bold('http://localhost:54323')} ${dim('— browse the database here')}`);
console.log(dim('    postgres  postgresql://postgres:postgres@localhost:54322/postgres'));
console.log(dim('    workos    remote, from apps/server/.env'));
console.log(dim('\n    check it with `pnpm health`, stop it with `pnpm services:stop`\n'));
