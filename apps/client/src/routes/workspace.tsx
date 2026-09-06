import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { detectPlatform } from '@relay/sync/platform';

import { Button } from '@/components/ui/button';
import { resolveWorkspace } from '@/lib/navigation';
import { paths, useWorkspaceParams } from '@/lib/paths';
import type { Session, SwitchTarget } from '@/lib/session';

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-6 py-2">
    <span className="text-muted-foreground text-sm">{label}</span>
    <span className="font-mono text-xs break-all">{value}</span>
  </div>
);

const Panel = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="grid min-h-full place-items-center p-6">
    <div className="border-border w-full max-w-md rounded-xl border p-7">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children}
    </div>
  </div>
);

/**
 * A workspace — the address everything below it is relative to.
 *
 * The workspace id comes from the URL rather than the session, which is invariant 3 read
 * forward: workspace is navigation state, so navigation is where it lives. Rooms land here
 * in Phase 2; until then this is the session it was reached with.
 */
export function Workspace({
  session,
  onSignOut,
  workspaces,
  workspacesPending,
  onSwitch,
}: {
  session: Session;
  onSignOut: () => void;
  workspaces: SwitchTarget[];
  workspacesPending: boolean;
  onSwitch: (organizationId: string) => Promise<string | null>;
}) {
  const { workspaceId } = useWorkspaceParams();

  // Only for the cross-org prompt below; the menu owns its own in-flight state.
  const swap = useMutation({
    mutationFn: async (organizationId: string) => {
      const error = await onSwitch(organizationId);
      if (error) throw new Error(error);
    },
  });

  const platform = detectPlatform();
  const current = workspaces.find((w) => w.workspaceId === workspaceId);
  const resolution = resolveWorkspace(
    workspaceId,
    workspaces,
    session.organizationId,
    workspacesPending,
  );

  if (resolution.status === 'pending') return <div className="min-h-full" />;

  /**
   * Reachable, but through another organization — so opening it re-issues the session. Asked,
   * never done silently. Accepting switches and the strip re-keys with it; the switch and the
   * context change are one event.
   */
  if (resolution.status === 'elsewhere') {
    const { organizationId, name } = resolution;
    return (
      <Panel title={`Switch to ${name}?`}>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          This workspace belongs to another organization. Opening it signs this window into {name};
          anything unsent here stays where it is.
        </p>
        <Button
          className="mt-6 w-full"
          disabled={swap.isPending}
          onClick={() => swap.mutate(organizationId)}
        >
          {swap.isPending ? 'Switching…' : `Switch to ${name}`}
        </Button>
        <Button render={<Link to={paths.root()} />} variant="outline" className="mt-2 w-full">
          Stay here
        </Button>
        {swap.isError && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {swap.error.message}
          </p>
        )}
      </Panel>
    );
  }

  // Says nothing about whether it exists: this account cannot tell that apart, and telling
  // them apart would leak which workspace ids are real.
  if (resolution.status === 'unknown') {
    return (
      <Panel title="Workspace not available">
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          It does not exist, or this account cannot reach it. Another signed-in account might.
        </p>
        <Button render={<Link to={paths.root()} />} variant="outline" className="mt-6 w-full">
          Go to your workspace
        </Button>
      </Panel>
    );
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="border-border w-full max-w-md rounded-xl border p-7">
        <h1 className="text-lg font-semibold">{current?.name ?? 'Workspace'}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{session.email}</p>

        <div className="divide-border mt-6 divide-y">
          <Row label="workspace_id" value={workspaceId} />
          <Row label="organization_id" value={session.organizationId ?? 'none'} />
          <Row label="surface" value={platform.panels ? 'desktop' : 'browser'} />
        </div>

        <div className="mt-6 flex gap-2">
          <Button render={<Link to={paths.settings()} />} variant="outline" className="flex-1">
            Settings
          </Button>
          <Button variant="outline" className="flex-1" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
