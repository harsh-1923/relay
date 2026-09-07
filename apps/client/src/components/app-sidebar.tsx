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
import { paths } from '@/lib/paths';
import type { SwitchTarget } from '@/lib/session';
import { useCollections } from '@/lib/sync';

/**
 * The navigation rail, shaped after the `sidebar-10` block.
 *
 * `collapsible="none"`: this component no longer owns its width or whether it is open. It sits
 * inside a `ResizablePanel`, which is what makes the edge a real drag handle — resize by
 * dragging, close by dragging past the minimum, all from `react-resizable-panels` rather than
 * from anything written here. The upstream `SidebarRail` is gone for the same reason: it wore
 * a resize cursor while only ever toggling on click.
 *
 * Starred rooms become a group above the rooms list when they exist, since those sync per
 * user while the open tabs do not.
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
 * Every room this device holds, read straight from local SQLite.
 *
 * There is no fetch here and no loading state worth showing: the sync streams decided what
 * reaches this device long before the sidebar rendered, so a room is either on disk or it is
 * not one this actor can see. That is also why the visibility union is absent — `rooms` in
 * `sync-config.yaml` already resolved "public in a workspace I belong to, plus private rooms
 * I was added to" server-side, and the client just lists what arrived.
 *
 * `is_private` is an integer because SQLite has no boolean.
 */
function RoomList({
  workspaceId,
  pathname,
}: {
  workspaceId: string | undefined;
  pathname: string;
}) {
  const collections = useCollections();
  const { data: rooms } = useLiveQuery(
    (q) =>
      collections && workspaceId
        ? q
            .from({ r: collections.rooms })
            .where(({ r }) => eq(r.workspace_id, workspaceId))
            .orderBy(({ r }) => r.name)
        : null,
    [collections, workspaceId],
  );

  if (!workspaceId) return null;
  if (!rooms?.length) {
    return (
      <p className="text-muted-foreground px-2 py-1 text-xs">
        {collections ? 'No rooms yet — create one to get started.' : 'Opening local database…'}
      </p>
    );
  }

  return (
    <SidebarMenu>
      {rooms.map((room) => {
        const to = paths.room(workspaceId, room.id);
        return (
          <SidebarMenuItem key={room.id}>
            <SidebarMenuButton isActive={pathname === to} render={<Link to={to} />}>
              <span className="truncate">{room.name}</span>
              {room.is_private ? (
                <span className="text-muted-foreground ml-auto text-[10px]">private</span>
              ) : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
