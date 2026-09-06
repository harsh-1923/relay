import { useMutation } from '@tanstack/react-query';

import type { Account, Session, SwitchTarget } from '@/lib/session';
import { WorkspaceMenu } from '@/routes/workspace-menu';

/**
 * The org and account switcher, with the in-flight state it needs.
 *
 * Built once and handed to whichever screen shows it, because the screen that needs it most
 * is the one that has nothing else on it: an organization with no workspace can only be left
 * by switching away from it.
 */
export function Switcher({
  session,
  workspaces,
  onSwitch,
  accounts,
  onSwitchAccount,
  onAddAccount,
}: {
  session: Session;
  workspaces: SwitchTarget[];
  onSwitch: (organizationId: string) => Promise<string | null>;
  accounts: Account[];
  onSwitchAccount: (userId: string) => void;
  onAddAccount: () => void;
}) {
  // The mutation carries which org is in flight, so the menu can show it without a second
  // piece of state tracking the same thing.
  const swap = useMutation({
    mutationFn: async (organizationId: string) => {
      const error = await onSwitch(organizationId);
      if (error) throw new Error(error);
    },
  });

  return (
    <>
      <WorkspaceMenu
        workspaces={workspaces}
        current={session.organizationId}
        busy={swap.isPending ? swap.variables : null}
        onSwitch={(organizationId) => swap.mutate(organizationId)}
        accounts={accounts}
        onSwitchAccount={onSwitchAccount}
        onAddAccount={onAddAccount}
      />
      {swap.isError && (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {swap.error.message}
        </p>
      )}
    </>
  );
}
