import { Button } from '@/components/ui/button';

export function SignIn() {
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight">relay</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          A workspace where people and agents work in the same room.
        </p>
        {/* A full navigation, not fetch: the server redirects to AuthKit's hosted UI. */}
        <Button className="mt-8 w-full" onClick={() => (window.location.href = '/auth/login')}>
          Sign in
        </Button>
      </div>
    </div>
  );
}
