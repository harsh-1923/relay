import { timestamp } from 'drizzle-orm/pg-core';

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * On the WorkOS mirrors only, so webhook staleness is answerable. Postgres is a read
 * replica of WorkOS — if the webhook path breaks, the mirror drifts silently, and this is
 * the column that makes that visible.
 */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
