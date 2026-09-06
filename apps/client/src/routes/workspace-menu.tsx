import { CheckTickSingle, PlusDefault } from '@relay/icons';

import type { Account, SwitchTarget } from '@/lib/session';
import { cn } from '@/lib/utils';

const row =
  'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm';

/**
 * One menu, two mechanisms.
 *
 * Picking a workspace under the current account re-issues the session into that organization.
 * Picking another account swaps to a different sealed session belonging to a different WorkOS
 * user — a different email, with its own memberships and roles.
 *
 * The user is choosing where to work either way, and is never told which mechanism ran. Slack
 * blends the same two into one rail; Gmail does the same with accounts.
 *
 * Only the active account's workspaces are listed. Fetching every account's would mean a
 * request per seal on every open, to show rows that are one click from being loaded anyway.
 */
export function WorkspaceMenu({
  workspaces,
  currentWorkspaceId,
  busy,
  onOpen,
  onNewWorkspace,
  accounts,
  onSwitchAccount,
  onAddAccount,
}: {
  workspaces: SwitchTarget[];
  currentWorkspaceId: string | null;
  busy: string | null;
  onOpen: (target: SwitchTarget) => void;
  onNewWorkspace?: () => void;
  accounts: Account[];
  onSwitchAccount: (userId: string) => void;
  onAddAccount: () => void;
}) {
  const others = accounts.filter((a) => !a.active);
  // A name is ambiguous only when another organization has a workspace called the same thing.
  const ambiguous = new Set(
    workspaces.map((w) => w.name).filter((name, i, all) => all.indexOf(name) !== i),
  );

  return (
    <div className="border-borderspace-y-4">
      <div>
        <p className="text-muted-foreground mb-2 text-xs select-none">Switch workspace</p>
        <ul className="space-y-1">
          {workspaces.map((w) => {
            const active = w.workspaceId === currentWorkspaceId;
            return (
              <li key={w.workspaceId}>
                <button
                  disabled={active || busy !== null}
                  onClick={() => onOpen(w)}
                  className={cn(
                    row,
                    'disabled:cursor-default',
                    active ? 'text-foreground' : 'hover:bg-muted disabled:opacity-50',
                  )}
                >
                  <span className="truncate">
                    {w.name}
                    {ambiguous.has(w.name) && (
                      <span className="text-muted-foreground"> · {w.organizationName}</span>
                    )}
                  </span>
                  {active && <CheckTickSingle className="size-4 shrink-0" aria-label="current" />}
                  {busy === w.workspaceId && (
                    <span className="text-muted-foreground text-xs">opening…</span>
                  )}
                </button>
              </li>
            );
          })}
          {onNewWorkspace && (
            <li>
              <button
                onClick={onNewWorkspace}
                className={cn(row, 'hover:bg-muted text-muted-foreground')}
              >
                <span className="flex items-center gap-2">
                  <PlusDefault className="size-4 shrink-0" />
                  New workspace
                </span>
              </button>
            </li>
          )}
        </ul>
      </div>

      {accounts.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-2 text-xs">Accounts</p>
          <ul className="space-y-1">
            {accounts.map((a) => (
              <li key={a.userId}>
                <button
                  disabled={a.active}
                  onClick={() => onSwitchAccount(a.userId)}
                  className={cn(
                    row,
                    'disabled:cursor-default',
                    a.active ? 'text-foreground' : 'hover:bg-muted',
                  )}
                >
                  <span className="truncate">{a.email}</span>
                  {a.active && <CheckTickSingle className="size-4 shrink-0" aria-label="current" />}
                </button>
              </li>
            ))}
            <li>
              <button
                onClick={onAddAccount}
                className={cn(row, 'hover:bg-muted text-muted-foreground')}
              >
                <span className="flex items-center gap-2">
                  <PlusDefault className="size-4 shrink-0" />
                  Add another account
                </span>
              </button>
            </li>
          </ul>
          {others.length > 0 && (
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              Each account is a separate sign-in with its own workspaces.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
