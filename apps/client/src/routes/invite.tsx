import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { authed } from '@/lib/session';
import { invitationKeys } from '@/lib/query';
import { cn } from '@/lib/utils';

interface Pending {
  id: string;
  email: string;
  expiresAt: string;
}

/**
 * Inviting someone to the workspace.
 *
 * WorkOS sends the mail and owns the invitation; the role on it decides what our webhook
 * handler does when it is accepted. `member` joins the default workspace — `guest` will get
 * rooms instead, once rooms exist.
 */
export function Invite({ canInvite }: { canInvite: boolean }) {
  const qc = useQueryClient();

  const pending = useQuery({
    queryKey: invitationKeys.all,
    queryFn: async () => {
      const r = await authed('/auth/invitations');
      if (!r?.ok) throw new Error('could not load invitations');
      return (r.body as { invitations: Pending[] }).invitations;
    },
  });

  const invite = useMutation({
    mutationFn: async (email: string) => {
      const r = await authed('/auth/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'member' }),
      });
      if (!r?.ok) {
        const code = (r?.body as { error?: string } | null)?.error;
        throw new Error(
          code === 'forbidden'
            ? 'Only an owner or admin can invite people.'
            : code === 'email_required'
              ? 'Enter an email address.'
              : 'Could not send the invitation.',
        );
      }
      return r.body as Pending;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: invitationKeys.all }),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await authed('/auth/invitations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: invitationKeys.all }),
  });

  const form = useForm({
    defaultValues: { email: '' },
    onSubmit: async ({ value, formApi }) => {
      await invite.mutateAsync(value.email.trim());
      formApi.reset();
    },
  });

  if (!canInvite) return null;

  return (
    <div className="border-border mt-6 border-t pt-4">
      <p className="text-muted-foreground mb-2 text-xs">Invite to this workspace</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex gap-2"
      >
        <form.Field
          name="email"
          validators={{
            onSubmit: ({ value }) =>
              /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim()) ? undefined : 'Enter a valid email',
          }}
        >
          {(field) => (
            <input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="teammate@example.com"
              aria-label="Email to invite"
              disabled={invite.isPending}
              className={cn(
                'border-border bg-background h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-sm',
                'focus-visible:ring-ring/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:outline-none',
                'disabled:opacity-50',
              )}
            />
          )}
        </form.Field>
        <Button type="submit" size="sm" disabled={invite.isPending}>
          {invite.isPending ? 'Sending…' : 'Invite'}
        </Button>
      </form>

      <form.Subscribe selector={(s) => s.errorMap.onSubmit}>
        {(error) =>
          error ? (
            <p role="alert" className="text-destructive mt-2 text-xs">
              {String(error)}
            </p>
          ) : null
        }
      </form.Subscribe>

      {invite.isError && (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {invite.error.message}
        </p>
      )}

      {pending.data && pending.data.length > 0 && (
        <ul className="mt-3 space-y-1">
          {pending.data.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground truncate">{p.email}</span>
              <button
                onClick={() => revoke.mutate(p.id)}
                disabled={revoke.isPending}
                className="text-muted-foreground hover:text-foreground shrink-0 underline underline-offset-2"
              >
                revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
