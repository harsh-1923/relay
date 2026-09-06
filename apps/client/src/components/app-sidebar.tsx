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
            <p className="text-muted-foreground px-2 py-1 text-xs">
              None yet — rooms arrive with the schema.
            </p>
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
