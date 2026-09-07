import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/session';
import { Invite } from '@/routes/invite';

/**
 * Organization settings — members, invitations, roles.
 *
 * Org-shaped, not account-shaped, so it belongs to whichever organization the session is
 * currently in and changes when that changes. An account-level surface (profile, notification
 * preferences) wants to be a dialog instead, or it will appear to vanish on an org switch —
 * see `docs/plans/navigation.md` (N4).
 */
export function Settings({ session, backTo }: { session: Session; backTo: string }) {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="border-border w-full max-w-md rounded-xl border p-7">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {session.organizationId ? 'This organization' : 'No organization'}
        </p>

        <Invite canInvite={session.canInvite ?? false} />

        <Button
          nativeButton={false}
          render={<Link to={backTo} />}
          variant="outline"
          className="mt-6 w-full"
        >
          Back
        </Button>
      </div>
    </div>
  );
}
