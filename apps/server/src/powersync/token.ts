import { SignJWT } from 'jose';

import { actorFor } from '../actors';
import { db, type DbEnv } from '../db';
import type { Session } from '../auth/session';

/**
 * The credential a device presents to PowerSync.
 *
 * This is the *entire* authority behind every read. `tooling/powersync/sync-config.yaml`
 * resolves what a client may see from three claims and nothing else, so what is minted here
 * decides what leaves the database — and a claim taken from the request rather than from the
 * session would be a client choosing its own tenant.
 *
 * | Claim             | From                          | Used by the streams as            |
 * | ----------------- | ----------------------------- | --------------------------------- |
 * | `sub`             | the sealed session's user      | `auth.user_id()`                  |
 * | `organization_id` | the sealed session             | `auth.parameter('organization_id')` |
 * | `actor_id`        | resolved from the two above    | `auth.parameter('actor_id')`      |
 *
 * `actor_id` is a claim rather than a subquery because the streams need it in a `WHERE` and
 * resolving it there would be a join on every stream evaluation. It is derived server-side
 * from `(user_id, organization_id)` against the `actors_org_user_key` constraint — the same
 * hop `access.ts`'s `Viewer` makes, for the same reason.
 *
 * Short-lived by design. PowerSync caps a token at 24 hours and recommends 60 minutes; the
 * client re-mints through `fetchCredentials()` whenever one expires, which is also how a
 * revoked WorkOS session stops syncing — the next mint fails to unseal and the device drops
 * off. That is the revocation story, and it is why the lifetime is not longer.
 */

export interface Env extends DbEnv {
  /** The PowerSync instance URL. Also the JWT audience — PowerSync rejects a token minted for
   *  a different instance, so this must not drift from what the client connects to. */
  POWERSYNC_URL: string;
  /**
   * Base64url shared secret, HS256.
   *
   * **Development only.** PowerSync supports HS256 for local work and asymmetric signing
   * (RS256/EdDSA/ES256) with a JWKS endpoint for production, which is what a deployed relay
   * must use: a symmetric secret has to exist on both sides, so PowerSync holding it means a
   * PowerSync compromise can mint sessions for any user in any organization. Moving to
   * asymmetric changes this file and nothing else — see the note in `powersync.md`.
   */
  POWERSYNC_JWT_SECRET: string;
}

/** An hour. PowerSync's own recommendation, and well inside its 24-hour cap. */
const LIFETIME = '60m';

export interface Credentials {
  endpoint: string;
  token: string;
}

export type TokenResult =
  { ok: true; credentials: Credentials } | { ok: false; reason: 'no_organization' | 'no_actor' };

/**
 * Mint a token for an already-unsealed session.
 *
 * Takes the `Session` rather than the `Request` so that unsealing stays in one place
 * (`unsealSession` is the only thing that parses a seal) and this cannot be called with
 * anything a client supplied.
 */
export async function powerSyncCredentials(env: Env, session: Session): Promise<TokenResult> {
  // A session with no organization has no tenant to scope a stream by. Signup creates one, so
  // this is the pre-signup state rather than an error worth a 500.
  if (!session.organizationId) return { ok: false, reason: 'no_organization' };

  const actorId = await actorFor(db(env), {
    userId: session.userId,
    organizationId: session.organizationId,
  });
  /**
   * No actor means a real account that is in no room and can be added to none (R6). Signup
   * and the WorkOS webhook both write one inside the transaction that creates the membership,
   * so this is a repair case rather than a normal one — and it is reported rather than
   * silently issuing a token whose `actor_id` claim would be null and would match nothing.
   */
  if (!actorId) return { ok: false, reason: 'no_actor' };

  const token = await new SignJWT({
    organization_id: session.organizationId,
    actor_id: actorId,
  })
    .setProtectedHeader({ alg: 'HS256', kid: 'relay-dev' })
    .setSubject(session.userId)
    .setAudience(env.POWERSYNC_URL)
    .setIssuedAt()
    .setExpirationTime(LIFETIME)
    .sign(Buffer.from(env.POWERSYNC_JWT_SECRET, 'base64url'));

  return { ok: true, credentials: { endpoint: env.POWERSYNC_URL, token } };
}
