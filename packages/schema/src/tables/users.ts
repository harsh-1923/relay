import { pgTable, text } from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from './columns';

/**
 * WorkOS mirror — read-only in application code. Rows arrive by `user.created` webhook;
 * a direct write is silently overwritten by the next one.
 *
 * One row per WorkOS user, not per human. `harsh@personal.com` and `harsh@acme.com` are
 * two rows and that is correct: AuthKit keys identity on email. There is no `person` table
 * and no server-side account linking — linking identities server-side creates a path around
 * an enterprise's SSO enforcement, which is the exact thing they are paying for. The
 * account switcher is client-side.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(), // WorkOS user_...
  email: text('email').notNull().unique(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  profilePic: text('profile_pic'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
