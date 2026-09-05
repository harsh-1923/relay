import { useForm } from '@tanstack/react-form';
import { useMutation } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Signup, as the user sees it: name a workspace.
 *
 * The org is created too, with the same name, and is never mentioned — Slack hides that level
 * until Enterprise Grid and so do we. Both rows always exist, so the level can be revealed
 * later without a migration.
 *
 * `onCreate` stays a callback rather than a query key: it re-issues the session, which is
 * state the session hook owns. The mutation is here for its pending and error handling, not
 * for caching — there is nothing to cache about creating something once.
 */
export function CreateWorkspace({
  onCreate,
}: {
  onCreate: (name: string) => Promise<string | null>;
}) {
  const create = useMutation({
    mutationFn: async (name: string) => {
      const error = await onCreate(name);
      // The server answers with a reason rather than a status the client should interpret,
      // so a returned string is a failure even though the request itself resolved.
      if (error) throw new Error(error);
    },
  });

  const form = useForm({
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(value.name.trim());
    },
  });

  return (
    <div className="grid min-h-full place-items-center p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="w-full max-w-sm"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Create a workspace</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Where you and your agents work. You can invite people once it exists.
        </p>

        <form.Field
          name="name"
          validators={{
            // Inline for now. When `packages/schema` exports validators, this takes the
            // workspace schema instead, so the client and the write endpoint agree by
            // construction rather than by both being edited.
            onSubmit: ({ value }) => (value.trim() ? undefined : 'Give the workspace a name'),
          }}
        >
          {(field) => (
            <input
              autoFocus
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Acme"
              aria-label="Workspace name"
              disabled={create.isPending}
              className={cn(
                'border-border bg-background mt-8 h-9 w-full rounded-lg border px-3 text-sm',
                'focus-visible:ring-ring/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:outline-none',
                'disabled:opacity-50',
              )}
            />
          )}
        </form.Field>

        <form.Subscribe selector={(s) => [s.values.name, s.isSubmitting] as const}>
          {([name, submitting]) => (
            <Button
              type="submit"
              disabled={!String(name).trim() || Boolean(submitting) || create.isPending}
              className="mt-4 w-full"
            >
              {create.isPending ? 'Creating…' : 'Create workspace'}
            </Button>
          )}
        </form.Subscribe>

        <form.Subscribe selector={(s) => s.errorMap.onSubmit}>
          {(invalid) =>
            invalid ? (
              <p role="alert" className="text-destructive mt-4 text-sm">
                {String(invalid)}
              </p>
            ) : null
          }
        </form.Subscribe>

        {create.isError && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {create.error.message}
          </p>
        )}
      </form>
    </div>
  );
}
