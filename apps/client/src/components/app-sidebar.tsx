import { eq } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import type { ComponentProps, ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { HomeDefault, LogOutRight, SearchDefault, Settings01 } from '@relay/icons';

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { BackgroundSync } from '@/components/background-sync';
import { usePublicRoomsSync, useRoomHeaderSync, useRoomMembershipsSync } from '@/lib/sync';
import { paths } from '@/lib/paths';
import type { SwitchTarget } from '@/lib/session';

/**
 * The navigation rail, shaped after the `sidebar-10` block.
 *
 * `collapsible="none"`: this component no longer owns its width or whether it is open. It sits
 * inside a `ResizablePanel`, which is what makes the edge a real drag handle — resize by
 * dragging, close by dragging past the minimum, all from `react-resizable-panels` rather than
 * from anything written here. The upstream `SidebarRail` is gone for the same reason: it wore
 * a resize cursor while only ever toggling on click.
 *
 * Deliberately thin for now. The rooms group below is the point of a sidebar and arrives with
 * the `rooms` table; starred rooms become a group above it, since those sync per user while
 * the open tabs do not.
 */
export function AppSidebar({
  workspace,
  email,
  onSignOut,
  switcher,
  ...props
}: ComponentProps<typeof Sidebar> & {
  workspace: SwitchTarget | undefined;
  email: string;
  onSignOut: () => void;
  switcher: ReactNode;
}) {
  const { pathname } = useLocation();
  const home = workspace?.workspaceId ? paths.workspace(workspace.workspaceId) : paths.root();

  return (
    <Sidebar collapsible="none" className="w-full border-r-0" {...props}>
      <SidebarHeader>
        {switcher}
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Nothing to search until there are rooms and messages to search through. */}
            <SidebarMenuButton disabled>
              <SearchDefault />
              <span>Search</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === home} render={<Link to={home} />}>
              <HomeDefault />
              <span>Home</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Rooms</SidebarGroupLabel>
          <SidebarGroupContent>
            <RoomList workspaceId={workspace?.workspaceId} pathname={pathname} />
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Pinned to the bottom, the way the block puts its secondary nav. */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === paths.settings()}
                  render={<Link to={paths.settings()} />}
                >
                  <Settings01 />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={onSignOut}>
                  <LogOutRight />
                  <span className="truncate">{email}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

/**
 * Public rooms in the workspace, plus the private ones this actor was explicitly added to —
 * D3's visibility union, reconciled here rather than in a single shape. `rooms` (public) and
 * `roomMemberships` (this actor's, any visibility) are two independent shapes; a membership
 * whose room is not already in the public set is a private room, rendered by opening that
 * room's own row.
 */
function RoomList({
  workspaceId,
  pathname,
}: {
  workspaceId: string | undefined;
  pathname: string;
}) {
  const publicRooms = usePublicRoomsSync(workspaceId);
  const memberships = useRoomMembershipsSync(workspaceId);

  const { data: pub } = useLiveQuery(
    (q) => (publicRooms ? q.from({ r: publicRooms }).orderBy(({ r }) => r.name) : null),
    [publicRooms],
  );
  const { data: mine } = useLiveQuery(
    (q) => (memberships ? q.from({ m: memberships }) : null),
    [memberships],
  );

  if (!workspaceId) return null;
  // Captured so the closure below keeps the narrowing this guard just established.
  const ws = workspaceId;

  const publicIds = new Set((pub ?? []).map((r) => r.id));
  const privateIds = (mine ?? []).map((m) => m.room_id).filter((id) => !publicIds.has(id));

  return (
    <>
      {/*
        Above the loading and empty branches on purpose. Background sync is not part of
        rendering the list — it is what keeps the rooms you are in current while you look
        elsewhere — so it must not be switched off by whatever the list happens to be showing.
        The membership list, not the public one: "rooms you are in" is the requirement.
      */}
      <BackgroundSync roomIds={(mine ?? []).map((m) => m.room_id)} />
      {renderList()}
    </>
  );

  function renderList() {
    if (pub === undefined || mine === undefined) {
      return <p className="text-muted-foreground px-2 py-1 text-xs">Loading rooms…</p>;
    }
    if (pub.length === 0 && privateIds.length === 0) {
      return (
        <p className="text-muted-foreground px-2 py-1 text-xs">
          No rooms yet — create one to get started.
        </p>
      );
    }
    return (
      <SidebarMenu>
        {pub.map((room) => (
          <RoomEntry
            key={room.id}
            workspaceId={ws}
            roomId={room.id}
            name={room.name}
            isPrivate={false}
            pathname={pathname}
          />
        ))}
        {privateIds.map((roomId) => (
          <PrivateRoomEntry key={roomId} workspaceId={ws} roomId={roomId} pathname={pathname} />
        ))}
      </SidebarMenu>
    );
  }
}

function RoomEntry({
  workspaceId,
  roomId,
  name,
  isPrivate,
  pathname,
}: {
  workspaceId: string;
  roomId: string;
  name: string;
  isPrivate: boolean;
  pathname: string;
}) {
  const to = paths.room(workspaceId, roomId);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={pathname === to} render={<Link to={to} />}>
        <span className="truncate">{name}</span>
        {isPrivate ? (
          <span className="text-muted-foreground ml-auto text-[10px]">private</span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * A private room's directory entry. Its own component, not a loop body calling hooks, because
 * `useRoomHeaderSync` and `useLiveQuery` must run once per room — a `.map()` calling hooks
 * inside the callback would break React's hook-order rule the moment the private-room count
 * changed between renders.
 */
function PrivateRoomEntry({
  workspaceId,
  roomId,
  pathname,
}: {
  workspaceId: string;
  roomId: string;
  pathname: string;
}) {
  const room = useRoomHeaderSync(roomId);
  const { data } = useLiveQuery((q) => q.from({ r: room }).where(({ r }) => eq(r.id, roomId)));
  const row = data?.[0];
  if (!row || row.archived_at) return null;
  return (
    <RoomEntry
      workspaceId={workspaceId}
      roomId={roomId}
      name={row.name}
      isPrivate={row.is_private}
      pathname={pathname}
    />
  );
}
