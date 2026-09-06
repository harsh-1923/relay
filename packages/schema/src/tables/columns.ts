import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * UUIDv7 primary key (RFC 9562). A 48-bit millisecond timestamp then randomness, so ids
 * sort chronologically and insert with locality — which is what lets a message shape be
 * bounded by a primary-key range and history page by keyset rather than by a second
 * ordering column.
 *
 * Ordering is to the millisecond; ids minted in the same millisecond have no defined order
 * relative to each other. The function is ours until Postgres 18, whose built-in of the
 * same name supersedes it. See `20260906144055_uuidv7.sql`.
 */
export const uuidPk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * On the WorkOS mirrors only, so webhook staleness is answerable. Postgres is a read
 * replica of WorkOS — if the webhook path breaks, the mirror drifts silently, and this is
 * the column that makes that visible.
 */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
