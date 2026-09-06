import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';

import { paths } from './paths';
import type { SwitchTarget } from './session';

/**
 * Opening a workspace.
 *
 * Within the organization the session already holds, this is a navigation and nothing else —
 * no request, no re-auth. Across organizations it is a session re-issue first, because the
 * target may demand a stronger authentication than this session has. That asymmetry is
 * invariant 3 stated directly: workspace is navigation state, organization is a claim.
 *
 * `switchTo` awaits its own cache invalidation, so by the time this navigates, the session
 * naming the new organization has actually loaded. Navigating before that lands the user back
 * where they started — see `docs/plans/navigation.md` (N10).
 */
export function useOpenWorkspace(
  currentOrganizationId: string | null,
  switchTo: (organizationId: string) => Promise<string | null>,
) {
  const navigate = useNavigate();

  return useMutation({
    mutationFn: async (target: SwitchTarget) => {
      if (target.organizationId !== currentOrganizationId) {
        const error = await switchTo(target.organizationId);
        if (error) throw new Error(error);
      }
      return target;
    },
    onSuccess: (target) => {
      void navigate(paths.workspace(target.workspaceId), { replace: true });
    },
  });
}
