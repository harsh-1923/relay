import { QueryClient } from '@tanstack/react-query';

/**
 * For server state Electric does not sync — `/auth/*`, and later history paging.
 *
 * Anything arriving over an Electric shape belongs to TanStack DB instead. Two caches for
 * one row is a stale read that only shows up under a race, so the boundary is worth keeping
 * sharp: if a shape carries it, DB owns it.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // These are small and change rarely; refetching on every focus is noise.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export const keys = {
  session: ['session'] as const,
  workspaces: ['workspaces'] as const,
  invitations: ['invitations'] as const,
  accounts: ['accounts'] as const,
};

/** Kept for the invite form's existing imports. */
export const invitationKeys = { all: keys.invitations };
