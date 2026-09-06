import { Table, getTableColumns, getTableName, is } from 'drizzle-orm';

/**
 * H7 — a missing `organization_id` is a cross-tenant leak.
 *
 * Invariant 2: `organization_id` sits on every tenant table, and `workspace_id` on
 * everything below the workspace — including where either is derivable by join. The shape
 * proxy authorises on every request and must never join to do it, so a denormalised column
 * that looks redundant is load-bearing.
 *
 * Exemption is deliberate, not inferred: adding a table to a set below is an edit someone
 * has to justify in review, which is the point.
 */

/** Identity, and the tenant root itself. Neither can carry an `organization_id`. */
const NO_ORGANIZATION_ID = new Set(['users', 'organizations']);

/**
 * At or above the workspace line. Everything below it must carry `workspace_id`.
 *
 * `actors` is the deliberate one: a human belongs to the organization, not to a workspace —
 * a guest holds an org membership and no workspace membership at all — and one actor row per
 * person per workspace would fragment authorship across them. `connections` will need the
 * same exemption when Phase 7 lands, for the same reason.
 */
const NO_WORKSPACE_ID = new Set([
  'actors',
  'users',
  'organizations',
  'organization_memberships',
  'workspaces',
]);

export interface TenancyViolation {
  table: string;
  missing: 'organization_id' | 'workspace_id';
}

/** Audits a Drizzle schema module. Non-table exports are ignored. */
export function auditTenancy(schema: Record<string, unknown>): TenancyViolation[] {
  const violations: TenancyViolation[] = [];

  for (const value of Object.values(schema)) {
    if (!is(value, Table)) continue;

    const table = getTableName(value);
    const columns = new Set(Object.values(getTableColumns(value)).map((column) => column.name));

    if (!NO_ORGANIZATION_ID.has(table) && !columns.has('organization_id')) {
      violations.push({ table, missing: 'organization_id' });
    }
    if (!NO_WORKSPACE_ID.has(table) && !columns.has('workspace_id')) {
      violations.push({ table, missing: 'workspace_id' });
    }
  }

  return violations;
}
