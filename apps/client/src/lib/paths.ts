import { useParams } from 'react-router';

/**
 * The only module that spells a route.
 *
 * **Path is identity, query is view state.** `/w/:id/r/:id` is a place; `?at=` is a permalink
 * into that place, and dropping it does not move you. A path segment is never optional and a
 * query parameter always is — that is the test for which one something belongs in.
 *
 * **Ids, never slugs.** `rooms` has no slug column, and `workspaces.slug` is unique only
 * within its organization, which would drag the org into the path. Ids also survive renames.
 *
 * **The org never appears.** It lives in the session; reading it from a URL is the retrofit
 * Phase 1 warns about. A link whose workspace belongs to another org is resolved against the
 * session, not spelled in the address.
 *
 * See `docs/plans/navigation.md` (D1–D4).
 */
export const paths = {
  root: () => '/',
  signIn: () => '/sign-in',
  settings: () => '/settings',
  /** Creating one, which is a place: you can link to it and land back on it. */
  newWorkspace: () => '/workspaces/new',
  workspace: (workspaceId: string) => `/w/${workspaceId}`,
  room: (workspaceId: string, roomId: string) => `/w/${workspaceId}/r/${roomId}`,
  /** A message is a permalink into a room, not a place of its own — hence the query. */
  message: (workspaceId: string, roomId: string, messageId: string) =>
    `${paths.room(workspaceId, roomId)}?at=${encodeURIComponent(messageId)}`,
} as const;

/** Route patterns, kept beside the builders so the two cannot drift apart. */
export const patterns = {
  root: '/',
  signIn: '/sign-in',
  settings: '/settings',
  newWorkspace: '/workspaces/new',
  workspace: '/w/:workspaceId',
  room: '/w/:workspaceId/r/:roomId',
} as const;

/**
 * Typed params. The route pattern guarantees the segment is there, so its absence is a
 * routing bug rather than bad user input — worth a throw rather than a null branch every
 * caller has to handle.
 */
export function useWorkspaceParams(): { workspaceId: string } {
  const { workspaceId } = useParams();
  if (!workspaceId) throw new Error('useWorkspaceParams() used outside a workspace route');
  return { workspaceId };
}

export function useRoomParams(): { workspaceId: string; roomId: string } {
  const { workspaceId, roomId } = useParams();
  if (!workspaceId || !roomId) throw new Error('useRoomParams() used outside a room route');
  return { workspaceId, roomId };
}
