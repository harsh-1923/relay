import { Check, Plus } from 'lucide-react';

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
  current,
  busy,
  onSwitch,
  accounts,
  onSwitchAccount,
  onAddAccount,
}: {
  workspaces: SwitchTarget[];
  current: string | null;
  busy: string | null;
  onSwitch: (organizationId: string) => void;
  accounts: Account[];
  onSwitchAccount: (userId: string) => void;
  onAddAccount: () => void;
}) {
  const others = accounts.filter((a) => !a.active);
  // On the browser `accounts` is empty, so this collapses to the org switcher alone.
  if (workspaces.length < 2 && accounts.length === 0) return null;

  return (
    <div className="border-border mt-6 space-y-4 border-t pt-4">
      {workspaces.length > 1 && (
        <div>
          <p className="text-muted-foreground mb-2 text-xs">Switch workspace</p>
          <ul className="space-y-1">
            {workspaces.map((w) => {
              const active = w.organizationId === current;
              return (
                <li key={w.organizationId}>
                  <button
                    disabled={active || busy !== null}
                    onClick={() => onSwitch(w.organizationId)}
                    className={cn(
                      row,
                      'disabled:cursor-default',
                      active ? 'text-foreground' : 'hover:bg-muted disabled:opacity-50',
                    )}
                  >
                    <span className="truncate">{w.name}</span>
                    {active && <Check className="size-4 shrink-0" aria-label="current" />}
                    {busy === w.organizationId && (
                      <span className="text-muted-foreground text-xs">switching…</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

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
                  {a.active && <Check className="size-4 shrink-0" aria-label="current" />}
                </button>
              </li>
            ))}
            <li>
              <button
                onClick={onAddAccount}
                className={cn(row, 'hover:bg-muted text-muted-foreground')}
              >
                <span className="flex items-center gap-2">
                  <Plus className="size-4 shrink-0" />
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
