import type { Session } from './auth/session';

const shell = (body: string) => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>relay — auth check</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#666; --line:#e5e5e5; --ok:#0a7; --bad:#c33; --bg:#fafafa; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --dim:#999; --line:#333; --bg:#111; --card:#1a1a1a; } }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg);
         margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 24px; }
  main { width: 100%; max-width: 34rem; background: var(--card); border: 1px solid var(--line);
         border-radius: 12px; padding: 28px 32px; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  p.sub { color: var(--dim); margin: 0 0 20px; font-size: .9rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 0 0 20px; font-size: .88rem; }
  dt { color: var(--dim); }
  dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  a.btn { display: inline-block; background: var(--fg); color: var(--bg); text-decoration: none;
          padding: 9px 18px; border-radius: 8px; font-size: .9rem; font-weight: 500; }
  a.ghost { color: var(--dim); text-decoration: none; font-size: .85rem; margin-left: 14px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  .note { border-top: 1px solid var(--line); margin-top: 22px; padding-top: 16px; color: var(--dim); font-size: .82rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .95em; }
</style>
<main>${body}</main>`;

export const signedOut = () =>
  shell(`
  <h1>relay</h1>
  <p class="sub">Phase 1 — verifying the AuthKit round trip.</p>
  <p><a class="btn" href="/auth/login">Sign in with AuthKit</a></p>
  <div class="note">
    Sign-in redirects to WorkOS's hosted UI and back to <code>/auth/callback</code>.
    The session cookie is sealed by WorkOS and read only by <code>unsealSession()</code>.
  </div>`);

export const signedIn = (s: Session) =>
  shell(`
  <h1>Signed in <span class="ok">✓</span></h1>
  <p class="sub">The AuthKit round trip works end to end.</p>
  <dl>
    <dt>user_id</dt><dd>${s.userId}</dd>
    <dt>email</dt><dd>${s.email}</dd>
    <dt>organization_id</dt><dd>${s.organizationId ?? '<span class="bad">none</span>'}</dd>
    <dt>session_id</dt><dd>${s.sessionId}</dd>
  </dl>
  <a class="btn" href="/auth/logout">Sign out</a>
  <a class="ghost" href="/auth/session">raw session</a>
  <div class="note">
    <strong>The session carries no workspace</strong>, deliberately — it is
    <code>{user_id, organization_id}</code> only (invariant 3).
    ${
      s.organizationId
        ? ''
        : '<br><br>No <code>organization_id</code>: this user belongs to no organization yet, so nothing scopes them to a tenant. Phase 1&rsquo;s signup path is what creates that membership.'
    }
    <br><br>Postgres has no row for this user yet — the mirror is fed by WorkOS webhooks,
    which Phase 1 builds. <code>pnpm health</code> reports that gap.
  </div>`);

export const failed = (reason: string) =>
  shell(`
  <h1>Sign-in failed <span class="bad">✗</span></h1>
  <p class="sub">${reason}</p>
  <p><a class="btn" href="/">Back</a></p>`);
