import { and, eq } from 'drizzle-orm';

import { conversations, messages } from '@relay/schema';

import { actorFor } from '../actors';
import { mayReadConversation, type Viewer } from '../access';
import { db, type DbEnv } from '../db';
import type { Session } from '../auth/session';

/**
 * The write path, and the only gate in front of it.
 *
 * **The client's local database is not a trust boundary.** PowerSync lets a device write to
 * its own SQLite freely and queues the result; nothing is checked until the queue is uploaded
 * here. So a hostile client can enqueue any row, in any table, claiming any author — and this
 * file is the entire reason that does not work. It is the counterpart to
 * `tooling/powersync/sync-config.yaml`: that decides what may be read, this decides what may
 * be written, and between them they are the whole authorisation surface (P2).
 *
 * Three rules, applied to every operation without exception:
 *
 *   1. **The table must be on the allow-list.** Anything else is not a write we support, and
 *      an unrecognised table is rejected rather than attempted.
 *   2. **Tenancy is derived, never accepted.** `organization_id`, `workspace_id` and
 *      `author_id` are read from the session and from the row being written *into* — never
 *      from the payload, which is why a client claiming another org's ids achieves nothing.
 *   3. **Read access is a precondition for writing.** `mayReadConversation` is the same check
 *      the streams encode, so a conversation you cannot see is one you cannot post to.
 *
 * **A rejected operation is dropped, not retried.** PowerSync re-uploads a batch until the
 * server accepts it, so answering a forbidden write with an error would wedge the device's
 * queue forever. Instead the batch always completes and rejections are reported: the local
 * optimistic row then disappears on its own when authoritative state syncs back down, which
 * is exactly the correction the user should see. Only genuine server faults throw.
 */

export type Env = DbEnv;

export type Op = 'PUT' | 'PATCH' | 'DELETE';

export interface Mutation {
  op: Op;
  table: string;
  id: string;
  data?: Record<string, unknown>;
}

export interface Rejection {
  index: number;
  id: string;
  reason: string;
}

export interface Result {
  applied: number;
  rejected: Rejection[];
}

/** What a client may write at all. Everything else in the schema is server-written. */
const WRITABLE = new Set(['messages']);

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * `body` is jsonb in Postgres and TEXT in SQLite, so it arrives as a JSON string. Parsed here
 * rather than stored as a string, or every reader would have to know which side wrote it.
 */
function parseBody(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Plain text for the search index, derived server-side — the column never leaves the server
 *  and a client has no business setting it. */
const searchTextOf = (body: Record<string, unknown>): string =>
  typeof body.text === 'string' ? body.text : '';

export async function applyMutations(
  env: Env,
  session: Session,
  batch: Mutation[],
): Promise<Result | { error: string }> {
  if (!session.organizationId) return { error: 'no_organization' };

  const d = db(env);
  const actorId = await actorFor(d, {
    userId: session.userId,
    organizationId: session.organizationId,
  });
  if (!actorId) return { error: 'no_actor' };

  const viewer: Viewer = {
    userId: session.userId,
    organizationId: session.organizationId,
    actorId,
  };

  const rejected: Rejection[] = [];
  let applied = 0;

  /**
   * One transaction for the whole batch. PowerSync uploads a batch as a unit and re-sends it
   * on failure, so a partial apply would be re-applied on the retry — and half-written
   * batches are exactly the state no reader can reason about.
   */
  await d.transaction(async (tx) => {
    for (const [index, m] of batch.entries()) {
      const reject = (reason: string) => rejected.push({ index, id: m.id, reason });

      if (!WRITABLE.has(m.table)) {
        reject(`table_not_writable:${m.table}`);
        continue;
      }
      if (!asString(m.id)) {
        reject('missing_id');
        continue;
      }

      const outcome = await applyMessage(tx, viewer, m);
      if (outcome === true) applied++;
      else reject(outcome);
    }
  });

  return { applied, rejected };
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * A message insert, edit or delete.
 *
 * Ids are client-generated — UUIDv7, minted on the device so an optimistic row already has
 * its final identity and reconciliation is an id match rather than a guess. That is safe
 * because an id is not an authority: it names a row, it does not grant anything.
 */
async function applyMessage(tx: Tx, viewer: Viewer, m: Mutation): Promise<true | string> {
  if (m.op === 'PUT') {
    const conversationId = asString(m.data?.conversation_id);
    if (!conversationId) return 'missing_conversation_id';

    // The same check the read streams encode. A conversation you cannot see is one you
    // cannot post to, and this is where those two agree (P7).
    if (!(await mayReadConversation(tx, viewer, conversationId))) return 'forbidden_conversation';

    const body = parseBody(m.data?.body);
    if (!body) return 'invalid_body';

    /**
     * Tenancy comes from the conversation, not the payload. This is the one lookup that makes
     * rule 2 true: whatever `workspace_id` or `organization_id` the client sent is discarded.
     */
    const [conversation] = await tx
      .select({
        workspaceId: conversations.workspaceId,
        organizationId: conversations.organizationId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conversation) return 'unknown_conversation';

    await tx
      .insert(messages)
      .values({
        id: m.id,
        conversationId,
        workspaceId: conversation.workspaceId,
        organizationId: conversation.organizationId,
        // Always the writer. A client naming another author is not an error to report, it is
        // a field we do not read.
        authorId: viewer.actorId,
        parentMessageId: asString(m.data?.parent_message_id) ?? undefined,
        // Never 'system'. Those are written by the server, and letting a client claim the
        // kind would let it forge the one message type the UI renders as not-from-a-person.
        kind: 'message',
        body,
        searchText: searchTextOf(body),
      })
      // A retried batch re-sends operations the first attempt already applied.
      .onConflictDoNothing();
    return true;
  }

  // Edit and delete are the author's alone. Room membership is not enough — otherwise anyone
  // in a room could rewrite anyone else's message.
  const [existing] = await tx
    .select({
      authorId: messages.authorId,
      conversationId: messages.conversationId,
      organizationId: messages.organizationId,
    })
    .from(messages)
    .where(eq(messages.id, m.id))
    .limit(1);
  if (!existing) return 'unknown_message';
  if (existing.organizationId !== viewer.organizationId) return 'wrong_organization';
  if (existing.authorId !== viewer.actorId) return 'not_the_author';
  if (!(await mayReadConversation(tx, viewer, existing.conversationId)))
    return 'forbidden_conversation';

  if (m.op === 'DELETE') {
    /**
     * A tombstone, not a row removal. `messages.parent_message_id` cascades, so a hard delete
     * would take a whole thread with it — and a reply outliving the message it answers is the
     * behaviour every chat product settles on.
     */
    await tx
      .update(messages)
      .set({ deletedAt: new Date(), body: {}, searchText: '' })
      .where(and(eq(messages.id, m.id), eq(messages.authorId, viewer.actorId)));
    return true;
  }

  const body = parseBody(m.data?.body);
  if (!body) return 'invalid_body';
  await tx
    .update(messages)
    .set({ body, searchText: searchTextOf(body), editedAt: new Date() })
    .where(and(eq(messages.id, m.id), eq(messages.authorId, viewer.actorId)));
  return true;
}
