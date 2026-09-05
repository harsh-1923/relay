import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { organizationMemberships, organizations, users } from '@relay/schema';

/**
 * The WorkOS mirror, in one place.
 *
 * Invariant 4: WorkOS is upstream, Postgres is a read replica. These rows are written here
 * and nowhere else. Two callers use them — the webhook, which is authoritative, and signup,
 * which writes the same rows from the API response because it cannot wait for a webhook that
 * may take seconds or, without a tunnel, never arrive.
 *
 * That is not a second source of truth: the response *is* WorkOS's data, keyed on WorkOS's
 * id, and the webhook that follows finds the row and changes nothing. Every write is an
 * upsert for that reason, and because WorkOS retries and delivers out of order.
 */

export interface MirrorUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

export interface MirrorOrganization {
  id: string;
  name: string;
}

export interface MirrorMembership {
  id: string;
  userId: string;
  organizationId: string;
  status: string;
  role?: { slug?: string };
}

type Db = PostgresJsDatabase<Record<string, unknown>>;

export async function applyUser(d: Db, u: MirrorUser): Promise<void> {
  const row = {
    id: u.id,
    email: u.email,
    firstName: u.firstName ?? null,
    lastName: u.lastName ?? null,
    profilePic: u.profilePictureUrl ?? null,
    updatedAt: new Date(),
  };
  await d.insert(users).values(row).onConflictDoUpdate({ target: users.id, set: row });
}

export async function applyOrganization(d: Db, o: MirrorOrganization): Promise<void> {
  const row = { id: o.id, name: o.name, updatedAt: new Date() };
  await d
    .insert(organizations)
    .values(row)
    .onConflictDoUpdate({ target: organizations.id, set: row });
}

export async function applyMembership(d: Db, m: MirrorMembership): Promise<void> {
  const row = {
    id: m.id,
    userId: m.userId,
    organizationId: m.organizationId,
    roles: [m.role?.slug ?? 'member'],
    status: m.status,
    updatedAt: new Date(),
  };
  await d
    .insert(organizationMemberships)
    .values(row)
    .onConflictDoUpdate({ target: organizationMemberships.id, set: row });
}

export const deleteUser = (d: Db, id: string) => d.delete(users).where(eq(users.id, id));
export const deleteOrganization = (d: Db, id: string) =>
  d.delete(organizations).where(eq(organizations.id, id));
export const deleteMembership = (d: Db, id: string) =>
  d.delete(organizationMemberships).where(eq(organizationMemberships.id, id));
