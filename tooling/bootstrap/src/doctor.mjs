#!/usr/bin/env node
/**
 * `pnpm health` — is this checkout actually working?
 *
 * Reports what is true, not what should be. The most valuable check here is the last one:
 * WorkOS and Postgres describe the same world, and a mismatch means every foreign key from
 * a real login dangles. That failure is silent at runtime and obvious here.
 *
 * Exit 0 clean, 1 if anything failed. Warnings do not fail. Named `health` rather than
 * `doctor` because `pnpm doctor` is a pnpm builtin and would shadow it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const c = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = c(2);
const bold = c(1);

let failures = 0;
let warnings = 0;
const ok = (s) => console.log(`  ${c(32)('✓')} ${s}`);
const bad = (s, hint) => {
  failures++;
  console.log(`  ${c(31)('✗')} ${s}`);
  if (hint) console.log(`      ${dim(hint)}`);
};
const meh = (s, hint) => {
  warnings++;
  console.log(`  ${c(33)('!')} ${s}`);
  if (hint) console.log(`      ${dim(hint)}`);
};
const group = (s) => console.log(`\n${bold(s)}`);

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim(), err: `${r.stderr ?? ''}`.trim() };
};

const envFiles = () =>
  ['apps', 'packages', 'tooling'].flatMap((g) => {
    const base = join(ROOT, g);
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .map((n) => join(base, n, '.env'))
      .filter((p) => existsSync(join(dirname(p), '.env.example')));
  });

const readEnv = (file) => {
  const map = {};
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
};

const projectId = () => {
  const f = join(ROOT, 'supabase/config.toml');
  const m = existsSync(f) ? readFileSync(f, 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m) : null;
  return m ? m[1] : 'relay';
};

const psql = (sql) =>
  sh('docker', [
    'exec',
    `supabase_db_${projectId()}`,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-Atc',
    sql,
  ]);

async function workosGet(base, key, path) {
  try {
    const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

console.log(bold('\n  relay health'));

// ── environment ───────────────────────────────────────────────────────────────
group('environment');

const docker = sh('docker', ['info', '--format', '{{.ServerVersion}}']);
if (docker.ok) ok(`docker running (${docker.out})`);
else bad('docker is not running', 'Start Docker, then re-run.');

const envs = envFiles();
const missing = envs.filter((f) => !existsSync(f));
if (missing.length) bad(`${missing.length} .env file(s) missing`, 'Run `pnpm run up env:setup`.');
else ok(`${envs.length} .env files present`);

// Two markers, two meanings. `generate-me` means the bootstrap has not run;
// `set-me` means a human still owes us a value from somewhere outside this repo.
const unsupplied = [];
const ungenerated = [];
for (const f of envs) {
  if (!existsSync(f)) continue;
  const short = f.replace(`${ROOT}/`, '');
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/^(\w+)=set-me$/gm)) unsupplied.push(`${m[1]} (${short})`);
  for (const m of text.matchAll(/^(\w+)=generate-me$/gm)) ungenerated.push(`${m[1]} (${short})`);
}
if (ungenerated.length)
  bad(
    `${ungenerated.length} local secret(s) not generated`,
    `${ungenerated.join(', ')}\n      Run \`pnpm run up secrets\`.`,
  );
else ok('local secrets generated');
// `env:setup` never overwrites an existing .env, which is correct — but it means a
// variable added to .env.example later never reaches a developer who already has one.
// Nothing else would notice.
const drifted = [];
for (const f of envs) {
  const exPath = f.replace(/\.env$/, '.env.example');
  if (!existsSync(exPath) || !existsSync(f)) continue;
  const keys = (t) => new Set([...t.matchAll(/^(\w+)=/gm)].map((m) => m[1]));
  const missing = [...keys(readFileSync(exPath, 'utf8'))].filter(
    (k) => !keys(readFileSync(f, 'utf8')).has(k),
  );
  for (const k of missing) drifted.push(`${k} (${f.replace(`${ROOT}/`, '')})`);
}
if (drifted.length)
  bad(
    `${drifted.length} variable(s) in .env.example missing from .env`,
    `${drifted.join(', ')}\n      Added to the example after your .env was created. Copy them across.`,
  );
else ok('.env files match their examples');

if (unsupplied.length)
  bad(
    `${unsupplied.length} value(s) you must supply`,
    `${unsupplied.join(', ')}\n      These come from outside the repo — the WorkOS dashboard, a provider console.`,
  );
else ok('externally-supplied values all set');

// ── postgres ──────────────────────────────────────────────────────────────────
group('postgres');

const alive = psql('select 1');
if (!alive.ok) {
  bad('not reachable on :54322', 'Run `pnpm run up services`.');
} else {
  ok('reachable on :54322');

  const onDisk = existsSync(join(ROOT, 'supabase/migrations'))
    ? readdirSync(join(ROOT, 'supabase/migrations'))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => f.split('_')[0])
    : [];
  const ledger = psql('select version from supabase_migrations.schema_migrations');
  const applied = new Set(ledger.ok ? ledger.out.split('\n').filter(Boolean) : []);
  const pending = onDisk.filter((v) => !applied.has(v));
  if (pending.length)
    bad(
      `${pending.length}/${onDisk.length} migrations pending`,
      'Run `pnpm db:reset` (drops local data).',
    );
  else ok(`${onDisk.length}/${onDisk.length} migrations applied`);

  const counts = psql(
    "select (select count(*) from users) || ' ' || (select count(*) from organizations) || ' ' || (select count(*) from workspaces) || ' ' || (select count(*) from workspace_memberships)",
  );
  if (counts.ok) {
    const [u, o, w, wm] = counts.out.split(' ').map(Number);
    if (u + o + w + wm === 0) ok('tables empty — rows arrive from the real flow, not a seed');
    else ok(`${u} user(s), ${o} org(s), ${w} workspace(s), ${wm} membership(s)`);
  }
}

// ── electric ──────────────────────────────────────────────────────────────────
group('electric');

const health = sh('curl', ['-fsS', '-m', '3', 'http://localhost:54330/v1/health']);
if (!health.ok) {
  bad('not reachable on :54330', 'Run `pnpm run up services`.');
} else {
  const status = (health.out.match(/"status"\s*:\s*"(\w+)"/) ?? [])[1];
  if (status === 'active') ok('reachable on :54330 — replication active');
  else meh(`reachable, but status is "${status}"`, 'Still connecting. Re-run in a few seconds.');

  /**
   * H1, the hazard most likely to cause an unrecoverable incident. An inactive slot holds WAL
   * forever, and Supabase disk grows and never shrinks — so an Electric that has stopped while
   * its slot remains is worse than one that was never started. `wal_status` says whether the
   * database is still keeping every segment the slot has not consumed.
   */
  const slot = psql(
    // `|` rather than a space: pg_size_pretty returns "232 bytes", which a space would split.
    "select active || '|' || coalesce(wal_status,'?') || '|' || " +
      "coalesce(pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)),'0') " +
      "from pg_replication_slots where slot_name like 'electric%'",
  );
  if (!slot.ok || !slot.out) {
    meh('no replication slot yet', 'Electric creates it on first connect.');
  } else {
    const [active, walStatus, lag] = slot.out.split('|');
    if (active !== 'true')
      bad(
        `replication slot is INACTIVE (retaining ${lag} of WAL)`,
        'Nothing is consuming it and the WAL will grow without bound. Start Electric, or\n    ' +
          "drop the slot: select pg_drop_replication_slot('electric_slot_relay_local');",
      );
    else if (walStatus !== 'reserved')
      bad(`slot wal_status is "${walStatus}" (retaining ${lag})`, 'Replication is falling behind.');
    else ok(`slot active, ${lag} of WAL retained`);
  }
}

// ── workos ────────────────────────────────────────────────────────────────────
const server = readEnv(join(ROOT, 'apps/server/.env'));
const base = (server.WORKOS_API_URL ?? '').replace(/\/$/, '');
const isLocal = /localhost|127\.0\.0\.1/.test(base);
group(
  `workos  ${dim(isLocal ? '(local emulator)' : `(remote — ${base.replace(/^https?:\/\//, '')})`)}`,
);

if (!base) {
  bad('WORKOS_API_URL is not set in apps/server/.env');
} else {
  // The picker decides whether the container runs; the .env decides what the code talks to.
  // Disagreement between them is exactly the kind of thing that wastes an afternoon.
  const answersFile = join(ROOT, '.relay-bootstrap.json');
  const picked = existsSync(answersFile)
    ? JSON.parse(readFileSync(answersFile, 'utf8'))['workos.local']
    : undefined;
  if (picked !== undefined && picked !== isLocal) {
    meh(
      `bootstrap is set to the ${picked ? 'emulator' : 'remote'} but .env points at the ${isLocal ? 'emulator' : 'remote'}`,
      'Run `pnpm run up:reconfigure` to reconcile them.',
    );
  }

  const orgs = await workosGet(base, server.WORKOS_API_KEY, '/organizations?limit=50');
  if (!orgs.ok) {
    bad(
      `cannot reach WorkOS (${orgs.status ?? orgs.error})`,
      isLocal ? 'Run `pnpm run up services`.' : 'Check WORKOS_API_KEY in apps/server/.env.',
    );
  } else {
    ok('credentials valid');
    if (!server.WORKOS_CLIENT_ID)
      meh('WORKOS_CLIENT_ID is not set', 'Needed for the AuthKit login flow in Phase 1.');

    // Is the local callback registered? WorkOS answers this without the worker running,
    // and an unregistered uri is invisible until someone clicks Sign in and gets a wall.
    if (server.WORKOS_CLIENT_ID && server.WORKOS_CLIENT_ID !== 'set-me') {
      // The client is the origin the browser sees; the Vite proxy forwards /auth to the
      // worker without rewriting Host, which is also how production behaves.
      const callback = 'http://localhost:5173/auth/callback';
      const authorize =
        `${base}/user_management/authorize?response_type=code&provider=authkit` +
        `&client_id=${encodeURIComponent(server.WORKOS_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(callback)}`;
      try {
        const body = await (await fetch(authorize, { redirect: 'follow' })).text();
        if (body.includes('invalid_redirect_uri')) {
          bad(
            'AuthKit redirect URI not registered',
            `Add ${callback} in the WorkOS dashboard under Redirects.\n` +
              '      Until then the hosted login page refuses the round trip.',
          );
        } else {
          ok('AuthKit redirect URI registered');
        }
      } catch {
        meh('could not check the redirect URI');
      }
    }

    // Webhooks are how the Postgres mirror stays in step with WorkOS. An endpoint that has
    // been disabled, or whose tunnel has died, fails silently — delivery just stops and the
    // mirror drifts with nothing to notice it.
    const endpoints = await workosGet(base, server.WORKOS_API_KEY, '/webhook_endpoints');
    if (endpoints.ok) {
      const eps = endpoints.body.data ?? [];
      if (!eps.length) {
        meh(
          'no webhook endpoint registered',
          'The mirror will never populate. Needs a publicly reachable URL — a tunnel locally,\n' +
            '      or a deployed worker.',
        );
      } else {
        for (const ep of eps) {
          const host = ep.endpoint_url.replace(/^https?:\/\//, '').split('/')[0];
          if (ep.status !== 'enabled') {
            bad(
              `webhook endpoint is ${ep.status} (${host})`,
              'WorkOS disables an endpoint after sustained delivery failure. Re-enable it, or\n' +
                '      delete it and register the current URL.',
            );
            continue;
          }
          if (!server.WORKOS_WEBHOOK_SECRET || server.WORKOS_WEBHOOK_SECRET === 'set-me') {
            bad(
              'webhook endpoint exists but WORKOS_WEBHOOK_SECRET is unset',
              'Every delivery will be rejected as unsigned.',
            );
            continue;
          }
          // A 400 is the right answer: it reached our handler, which refused an unsigned POST.
          // Retry once — a freshly started quick tunnel takes a moment to register with the
          // edge, and warning during that window is a false alarm.
          const reach = async (url, ms) => {
            try {
              const r = await fetch(url, {
                method: 'POST',
                body: '{}',
                signal: AbortSignal.timeout(ms),
              });
              return r.status !== 404 && r.status < 500;
            } catch {
              return false;
            }
          };

          let reachable = await reach(ep.endpoint_url, 12000);
          if (!reachable) {
            await new Promise((r) => setTimeout(r, 1500));
            reachable = await reach(ep.endpoint_url, 12000);
          }

          if (reachable) {
            ok(`webhook endpoint enabled and reachable (${host})`);
            continue;
          }

          // Do not guess at the cause. A tunnel forwards to the local worker, so a dead
          // worker looks exactly like a dead tunnel from outside — and telling someone to
          // restart a tunnel that is already running wastes their time.
          const workerUp = await reach('http://localhost:8787/webhooks/workos', 3000);
          if (!workerUp)
            meh(
              `${host} is not answering, and neither is the local worker`,
              'The tunnel forwards to :8787, so start `pnpm dev` first. Auth is unaffected;\n' +
                '      only the mirror stops updating.',
            );
          else
            meh(
              `the worker is running but ${host} is not answering`,
              'The tunnel is down or has a new hostname. `pnpm tunnel` restarts it and\n' +
                '      re-points WorkOS in one step.',
            );
        }
      }
    }

    const users = await workosGet(base, server.WORKOS_API_KEY, '/user_management/users?limit=50');
    const remoteOrgs = orgs.body.data.map((o) => o.id);
    const remoteUsers = users.ok ? users.body.data.map((u) => u.id) : [];

    const pgOrgs = psql('select id from organizations');
    const pgUsers = psql('select id from users');
    const dbOrgs = pgOrgs.ok ? pgOrgs.out.split('\n').filter(Boolean) : [];
    const dbUsers = pgUsers.ok ? pgUsers.out.split('\n').filter(Boolean) : [];

    // The mirror check. Postgres is a read replica of WorkOS, so every id our tables
    // reference must exist upstream — otherwise a real login hands us a user_… that is a
    // foreign key to nothing.
    const orphanUsers = dbUsers.filter((id) => !remoteUsers.includes(id));
    const orphanOrgs = dbOrgs.filter((id) => !remoteOrgs.includes(id));

    if (!dbUsers.length && !dbOrgs.length) {
      ok(
        `mirror empty — ${remoteUsers.length} user(s), ${remoteOrgs.length} org(s) upstream, nothing mirrored yet`,
      );
    } else if (!orphanUsers.length && !orphanOrgs.length) {
      ok(`mirror aligned: ${dbUsers.length} user(s), ${dbOrgs.length} org(s) exist upstream`);
    } else {
      bad(
        `mirror not aligned — ${orphanUsers.length} user(s) and ${orphanOrgs.length} org(s) in Postgres do not exist in WorkOS`,
        `WorkOS has ${remoteUsers.length} user(s), ${remoteOrgs.length} org(s). Postgres has ${dbUsers.length} and ${dbOrgs.length}.\n` +
          '      Every id in Postgres must exist upstream — it is a read replica. Rows that do\n' +
          '      not are dangling foreign keys waiting for a real login to hit them.',
      );
    }
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────
const parts = [];
if (failures) parts.push(c(31)(`${failures} problem${failures === 1 ? '' : 's'}`));
if (warnings) parts.push(c(33)(`${warnings} warning${warnings === 1 ? '' : 's'}`));
console.log(`\n  ${parts.length ? parts.join(', ') : c(32)('all good')}\n`);
process.exit(failures ? 1 : 0);
