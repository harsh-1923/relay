import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/session';
import { detectPlatform } from '@relay/sync/platform';

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-6 py-2">
    <span className="text-muted-foreground text-sm">{label}</span>
    <span className="font-mono text-xs break-all">{value}</span>
  </div>
);

export function Home({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
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

        <Button variant="outline" className="mt-6 w-full" onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
