import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/session';
import { detectPlatform } from '@relay/sync/platform';

export function SignIn({
  pending,
  error,
  onSignIn,
  onCancel,
}: {
  pending: boolean;
  error?: string;
  onSignIn: () => void;
  onCancel: () => void;
}) {
  const desktop = detectPlatform().session === 'bearer';
  const [params] = useSearchParams();
  const message = error ?? describeError(params.get('error'));

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight">relay</h1>

        {pending ? (
          <>
            <p className="text-muted-foreground mt-2 text-sm" role="status">
              Waiting for you to finish signing in…
            </p>
            <div
              className="border-border mt-8 flex items-center justify-center gap-3 rounded-md border py-3"
              aria-hidden
            >
              <span className="bg-foreground/60 size-2 animate-pulse rounded-full" />
              <span className="text-muted-foreground text-sm">Your browser is open</span>
            </div>
            <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
              Complete sign-in in the browser tab that opened. This window updates on its own when
              you&rsquo;re done.
            </p>
            <button
              onClick={onCancel}
              className="text-muted-foreground hover:text-foreground mt-6 text-xs underline underline-offset-4"
            >
              Cancel and start over
            </button>
          </>
        ) : (
          <>
            <p className="text-muted-foreground mt-2 text-sm">
              A workspace where people and agents work in the same room.
            </p>
            <Button className="mt-8 w-full" onClick={onSignIn}>
              Sign in
            </Button>
            {message && (
              <p role="alert" className="text-destructive mt-4 text-sm">
                {message}
              </p>
            )}
            {desktop && (
              <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
                Sign-in opens in your browser, so passkeys and your existing accounts work.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
