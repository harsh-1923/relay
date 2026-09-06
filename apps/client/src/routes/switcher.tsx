import { useNavigate } from 'react-router';

import { useOpenWorkspace } from '@/lib/open';
import { paths } from '@/lib/paths';
import type { Account, Session, SwitchTarget } from '@/lib/session';
import { WorkspaceMenu } from '@/routes/workspace-menu';

/**
 * The workspace and account switcher, with the in-flight state it needs.
 *
 * Built once and handed to whichever screen shows it, because the screen that needs it most
 * is the one that has nothing else on it: an organization with no workspace can only be left
 * by switching away from it.
 */
export function Switcher({
  session,
  workspaces,
  currentWorkspaceId,
  onSwitch,
  accounts,
  onSwitchAccount,
  onAddAccount,
}: {
  session: Session;
  workspaces: SwitchTarget[];
  currentWorkspaceId: string | null;
  onSwitch: (organizationId: string) => Promise<string | null>;
  accounts: Account[];
  onSwitchAccount: (userId: string) => void;
  onAddAccount: () => void;
}) {
  const navigate = useNavigate();
  const open = useOpenWorkspace(session.organizationId, onSwitch);

  return (
    <>
      <WorkspaceMenu
        workspaces={workspaces}
        currentWorkspaceId={currentWorkspaceId}
        // Only a cross-organization open is ever in flight long enough to say so; within one
        // organization it is a navigation and lands immediately.
        busy={open.isPending ? (open.variables?.workspaceId ?? null) : null}
        onOpen={(target) => open.mutate(target)}
        onNewWorkspace={session.canInvite ? () => void navigate(paths.newWorkspace()) : undefined}
        accounts={accounts}
        onSwitchAccount={onSwitchAccount}
        onAddAccount={onAddAccount}
      />
      {open.isError && (
        <p role="alert" className="text-destructive mt-4 text-sm">
          {open.error.message}
        </p>
      )}
    </>
  );
}
