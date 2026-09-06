import { isShapeName, shapes, type ShapeParams } from '@relay/schema';

import { actorFor } from '../actors';
import {
  isWorkspaceMember,
  mayReadConversation,
  mayReadRoom,
  workspaceInOrg,
  type Viewer,
} from '../access';
import { unsealSession, type Env as AuthEnv } from '../auth/session';
import { db, type DbEnv } from '../db';

export type Env = AuthEnv &
  DbEnv & {
    ELECTRIC_URL: string;
    ELECTRIC_SECRET: string;
  };

/**
 * The shape proxy.
 *
 * Electric is unauthenticated by design — it "exposes access to any data that its database user
 * can access to any client that can connect", and is meant to run behind an authorizing proxy.
 * This is that proxy, and it has exactly one job: decide whether this human may read this
 * shape, then add the secret and forward.
 *
 * The client never names a table or writes a where clause. It names a shape from the registry
 * in `packages/schema` and passes parameters, and this builds the query. A client-supplied
 * `table`, `where`, `columns` or `secret` is ignored rather than rejected — rejecting would
 * confirm the parameter exists.
 *
 * Only humans are authorised here. Agents never open a shape: the agent service authenticates
 * as a service and each of its writes is authorised by the `runs` row it references.
 */

/**
 * The log-position parameters, and the only ones passed through from the client.
 *
 * These are Electric's cursor into the shape log — they say *where the client is*, not *what it
 * may see*, so forwarding them verbatim gives away nothing. Everything else in the query string
 * is discarded.
 */
const PASSTHROUGH = ['offset', 'handle', 'live', 'cursor', 'replica'] as const;

/** Electric's own headers, which the client's Electric library reads to resume. */
const ELECTRIC_HEADERS = [
  'electric-handle',
  'electric-offset',
  'electric-schema',
  'electric-cursor',
  'electric-up-to-date',
  'electric-has-data',
  'retry-after',
];

/**
 * The one place a `workspaceId` is checked before it reaches a query, rather than after. The
 * 'workspace' scope needs two DB round trips ahead of the where clause — the org check and the
 * membership check — and letting a malformed id reach either as a bind parameter would 500
 * instead of 400, same reasoning as the `uuid()` guard in the shape registry itself.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleShape(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (!isShapeName(name)) return json({ error: 'unknown_shape' }, 404);

  const unsealed = await unsealSession(request, env);
  if (!unsealed) return json({ error: 'unauthenticated' }, 401);

  const { userId, organizationId } = unsealed.session;
  if (!organizationId) return json({ error: 'no_organization' }, 400);

  const d = db(env);
  const actorId = await actorFor(d, { userId, organizationId });
  // A session without an actor is a real account that has not been projected yet. It cannot be
  // a member of anything, so there is nothing it could be authorised to read.
  if (!actorId) return json({ error: 'no_actor' }, 403);

  const viewer: Viewer = { userId, organizationId, actorId };
  const shape = shapes[name];
  const url = new URL(request.url);
  const params: ShapeParams = {
    organizationId,
    roomId: url.searchParams.get('roomId') ?? undefined,
    conversationId: url.searchParams.get('conversationId') ?? undefined,
    workspaceId: url.searchParams.get('workspaceId') ?? undefined,
    // Server-resolved. The room-directory where clause needs it to join against
    // `room_members`; no other shape reads it, so setting it unconditionally is harmless.
    actorId,
  };

  /**
   * The two 'workspace' shapes need a fact the where clause itself no longer computes now
   * that neither uses a subquery (see the shape registry's comment on why): is this viewer
   * allowed to see this workspace's directory at all. Both require same-org; `rooms` — the
   * public half — additionally requires workspace membership, matching D3's union. Resolved
   * ahead of `shape.where()` because it needs a DB round trip the where builder cannot make.
   */
  if (shape.scope === 'workspace') {
    if (!params.workspaceId || !UUID.test(params.workspaceId)) {
      return json({ error: 'invalid_parameters' }, 400);
    }
    if (!(await workspaceInOrg(d, viewer, params.workspaceId))) {
      return json({ error: 'forbidden' }, 403);
    }
    if (name === 'rooms' && !(await isWorkspaceMember(d, viewer, params.workspaceId))) {
      return json({ error: 'forbidden' }, 403);
    }
  }

  /**
   * Build the where clause *before* authorising the other scopes, because building it is what
   * validates their parameters — and an unvalidated id would otherwise reach Postgres as a
   * bind parameter and fail there. Drizzle parameterises, so that was never an injection; it
   * was a 500 where a 400 belongs, and a malformed id is a client bug worth naming as one.
   */
  let where: string;
  try {
    where = shape.where(params);
  } catch {
    return json({ error: 'invalid_parameters' }, 400);
  }

  const allowed = await authorize(d, viewer, shape.scope, params);
  if (!allowed) return json({ error: 'forbidden' }, 403);

  const upstream = new URL('/v1/shape', env.ELECTRIC_URL);
  upstream.searchParams.set('table', shape.table);
  upstream.searchParams.set('where', where);
  if ('columns' in shape && shape.columns) {
    upstream.searchParams.set('columns', shape.columns.join(','));
  }
  upstream.searchParams.set('secret', env.ELECTRIC_SECRET);
  for (const key of PASSTHROUGH) {
    const value = url.searchParams.get(key);
    if (value !== null) upstream.searchParams.set(key, value);
  }

  const response = await fetch(upstream, {
    // A live request long-polls; nothing else about the client's request is forwarded.
    signal: request.signal,
  });

  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ELECTRIC_HEADERS) {
    const value = response.headers.get(h);
    if (value !== null) headers.set(h, value);
  }
  headers.set('Access-Control-Expose-Headers', ELECTRIC_HEADERS.join(','));

  /**
   * `private`, deliberately, even though Electric answers `public`.
   *
   * The response body is the same for every member of a room, so it *is* shareable — but the
   * request URL does not identify the viewer, so a shared cache in front of this Worker would
   * serve a hit to someone who never passed the check above. The sharing has to happen on the
   * far side of authorisation: the Worker caching its own fetch of `upstream`, keyed on the
   * Electric URL. That is a deployment concern (Cache API) rather than a correctness one, and
   * until it exists the browser may cache and nothing else may.
   */
  const maxAge = response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1];
  headers.set('Cache-Control', maxAge ? `private, max-age=${maxAge}` : 'private, no-store');

  return new Response(response.body, { status: response.status, headers });
}

/** Each scope resolves to the check `access.ts` already defines for it. */
async function authorize(
  d: ReturnType<typeof db>,
  viewer: Viewer,
  scope: 'organization' | 'room' | 'conversation' | 'workspace',
  params: ShapeParams,
): Promise<boolean> {
  switch (scope) {
    // The session already names the organization, and every shape is built with that id rather
    // than one the client supplied — so there is nothing further to check.
    case 'organization':
      return true;
    case 'room':
      return params.roomId ? mayReadRoom(d, viewer, params.roomId) : false;
    case 'conversation':
      return params.conversationId ? mayReadConversation(d, viewer, params.conversationId) : false;
    // Already decided above — the org check and the membership lookup happen before the where
    // clause is built, because the where clause needs the membership fact.
    case 'workspace':
      return true;
  }
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
