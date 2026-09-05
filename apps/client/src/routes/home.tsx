import { Button } from '@/components/ui/button';
import type { Account, Session, SwitchTarget } from '@/lib/session';
import { Invite } from '@/routes/invite';
import { WorkspaceMenu } from '@/routes/workspace-menu';
import { useMutation } from '@tanstack/react-query';
import { detectPlatform } from '@relay/sync/platform';

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-6 py-2">
    <span className="text-muted-foreground text-sm">{label}</span>
    <span className="font-mono text-xs break-all">{value}</span>
  </div>
);

export function Home({
  session,
  onSignOut,
  workspaces,
  onSwitch,
  accounts,
  onSwitchAccount,
  onAddAccount,
}: {
  session: Session;
  onSignOut: () => void;
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

  const platform = detectPlatform();

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="border-border w-full max-w-md rounded-xl border p-7">
        <h1 className="text-lg font-semibold">Signed in</h1>
        <p className="text-muted-foreground mt-1 text-sm">{session.email}</p>

        <div className="divide-border mt-6 divide-y">
          <Row label="user_id" value={session.userId} />
          <Row label="organization_id" value={session.organizationId ?? 'none'} />
          <Row label="surface" value={platform.panels ? 'desktop' : 'browser'} />
        </div>

        {!session.organizationId && (
          <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-xs leading-relaxed">
            No organization yet. The signup path that creates one — org, membership, default
            workspace, room — is the next thing to build, and until it exists nothing scopes this
            user to a tenant.
          </p>
        )}

        <Invite canInvite={session.canInvite ?? false} />

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

        <Button variant="outline" className="mt-6 w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
