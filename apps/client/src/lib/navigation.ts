import type { SwitchTarget } from './session';

/**
 * Where a workspace sits relative to the session you are holding.
 *
 * `here`: same organization — just render it.
 * `elsewhere`: reachable, but in another organization. Opening it re-issues the session, so
 *   it is asked rather than done: switching under someone with an unsent draft is not a
 *   navigation, it is a surprise.
 * `unknown`: not in any organization this account can reach. Says nothing about whether it
 *   exists — this account cannot tell those apart, and should not.
 * `pending`: the list has not arrived. Distinct from `unknown`, or every deep link would
 *   flash "no access" before resolving.
 *
 * See `docs/plans/navigation.md` (D12).
 */
export type Resolution =
  | { status: 'pending' }
  | { status: 'here' }
  | { status: 'elsewhere'; organizationId: string; name: string }
  | { status: 'unknown' };

/**
 * Pure so the branch can be tested without a router or a session. The org comes from the
 * session and the workspace from the URL — this is the one place they are reconciled.
 */
export function resolveWorkspace(
  workspaceId: string,
  workspaces: SwitchTarget[],
  currentOrganizationId: string | null,
  workspacesPending: boolean,
): Resolution {
  const target = workspaces.find((w) => w.workspaceId === workspaceId);
  if (target) {
    return target.organizationId === currentOrganizationId
      ? { status: 'here' }
      : { status: 'elsewhere', organizationId: target.organizationId, name: target.name };
  }
  // Still loading is not the same as not yours; only answer once the list is in.
  return workspacesPending ? { status: 'pending' } : { status: 'unknown' };
}
