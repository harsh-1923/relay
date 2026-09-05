import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/tables/index';
import { auditTenancy } from '../src/tenancy';

describe('tenancy (H7)', () => {
  it('holds across the real schema', () => {
    expect(auditTenancy(schema)).toEqual([]);
  });

  // The schema is still empty, so these fixtures are what prove the guard actually bites.
  // Delete them only if the real schema ever covers every case below.
  it('flags a tenant table missing both columns', () => {
    const rooms = pgTable('rooms', {
      id: uuid('id').primaryKey(),
      name: text('name').notNull(),
    });

    expect(auditTenancy({ rooms })).toEqual([
      { table: 'rooms', missing: 'organization_id' },
      { table: 'rooms', missing: 'workspace_id' },
    ]);
  });

  it('flags a table that joins to its tenant instead of denormalising it', () => {
    const roomMembers = pgTable('room_members', {
      roomId: uuid('room_id').notNull(),
      organizationId: text('organization_id').notNull(),
    });

    expect(auditTenancy({ roomMembers })).toEqual([
      { table: 'room_members', missing: 'workspace_id' },
    ]);
  });

  it('exempts identity and the tenant root', () => {
    const users = pgTable('users', { id: text('id').primaryKey() });
    const organizations = pgTable('organizations', { id: text('id').primaryKey() });

    expect(auditTenancy({ users, organizations })).toEqual([]);
  });

  it('ignores non-table exports', () => {
    expect(auditTenancy({ auditTenancy, SOME_CONSTANT: 3 })).toEqual([]);
  });
});
