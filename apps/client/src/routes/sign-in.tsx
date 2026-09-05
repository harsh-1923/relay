import { useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { describeError, signIn } from '@/lib/session';
import { detectPlatform } from '@relay/sync/platform';

export function SignIn({ error }: { error?: string }) {
  const desktop = detectPlatform().session === 'bearer';
  const [params] = useSearchParams();
  const message = error ?? describeError(params.get('error'));

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight">relay</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          A workspace where people and agents work in the same room.
        </p>
        <Button className="mt-8 w-full" onClick={signIn}>
          Sign in
        </Button>
        {message && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {message}
          </p>
        )}
        {desktop && (
          <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
            Sign-in opens in your browser, so passkeys and your existing accounts work. Come back
            here when it&rsquo;s done.
          </p>
        )}
      </div>
    </div>
  );
}
