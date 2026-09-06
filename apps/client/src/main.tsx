import { HotkeysProvider } from '@tanstack/react-hotkeys';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { useDefaultLayout, usePanelRef, type LayoutStorage } from 'react-resizable-panels';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, matchPath, Navigate, Route, Routes, useLocation } from 'react-router';

import { AppSidebar } from '@/components/app-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { ShortcutsSheet } from '@/components/shortcuts-sheet';
import { TitleBar } from '@/components/title-bar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useShellCommands } from '@/lib/app-commands';
import { useDeepLinkNavigation } from '@/lib/deep-links';
import { paths, patterns } from '@/lib/paths';
import { queryClient } from '@/lib/query';
import { useSession, type Session, type SessionApi, type SwitchTarget } from '@/lib/session';
import { TabsProvider, titleFor, useTabs } from '@/lib/tabs';
import { CreateWorkspace } from '@/routes/create-workspace';
import { Settings } from '@/routes/settings';
import { SignIn } from '@/routes/sign-in';
import { Switcher } from '@/routes/switcher';
import { Workspace } from '@/routes/workspace';
import './styles.css';

/**
 * Where the sidebar layout is remembered. Per device, like the tab strip: how things are
 * arranged is local. Guarded the way `webStore` is, because `localStorage` throws outright in
 * a private window and a layout not being remembered is not worth taking the app down for.
 */
const layoutStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Out of quota, or storage refused. The layout stays correct for this run.
    }
  },
};

/**
 * `/` is not a place — it resolves to one.
 *
 * With no organization there is nothing scoping this user to a tenant, so the only thing to
 * do is create one. Otherwise land in the current organization's default workspace, which is
 * the address every room is relative to.
 */
function Root({
  session,
  workspaces,
  workspacesPending,
  onCreate,
}: {
  session: Session;
  workspaces: SwitchTarget[];
  workspacesPending: boolean;
  onCreate: (name: string) => Promise<string | null>;
}) {
  if (!session.organizationId) return <CreateWorkspace onCreate={onCreate} />;

  const inOrg = workspaces.filter((w) => w.organizationId === session.organizationId);
  const target = inOrg.find((w) => w.isDefault) ?? inOrg[0];
  if (target?.workspaceId) return <Navigate to={paths.workspace(target.workspaceId)} replace />;
  if (workspacesPending) return <div className="min-h-full" />;

  /**
   * Signup always creates a workspace alongside the organization, so this is either a mirror
   * that has not caught up or an organization that predates that path.
   *
   * The switcher is the point of this screen. Landing here means the organization the session
   * happens to hold is the one organization that cannot be opened — which is exactly when
   * being unable to reach another one is worst.
   */
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="border-border w-full max-w-md rounded-xl border p-7">
        <h1 className="text-lg font-semibold">No workspace here</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          This organization has no workspace. If you have just signed up, reload in a moment —
          otherwise switch to a different one from the sidebar.
        </p>
      </div>
    </div>
  );
}

function App({ api }: { api: SessionApi }) {
  const {
    state,
    signIn,
    cancelSignIn,
    signOut,
    createWorkspace,
    addWorkspace,
    workspaces,
    workspacesPending,
    switchTo,
  } = api;

  if (state.status === 'loading') return <div className="min-h-full" />;

  if (state.status !== 'in') {
    return (
      <Routes>
        <Route
          path={patterns.signIn}
          element={
            <SignIn
              pending={state.status === 'pending'}
              error={state.status === 'out' ? state.error : undefined}
              onSignIn={signIn}
              onCancel={cancelSignIn}
            />
          }
        />
        <Route path="*" element={<Navigate to={paths.signIn()} replace />} />
      </Routes>
    );
  }

  const { session } = state;
  const inOrg = workspaces.filter((w) => w.organizationId === session.organizationId);
  const home = inOrg.find((w) => w.isDefault) ?? inOrg[0];

  return (
    <Routes>
      <Route
        path={patterns.root}
        element={
          <Root
            session={session}
            workspaces={workspaces}
            workspacesPending={workspacesPending}
            onCreate={createWorkspace}
          />
        }
      />
      <Route
        path={patterns.workspace}
        element={
          <Workspace
            session={session}
            onSignOut={signOut}
            workspaces={workspaces}
            workspacesPending={workspacesPending}
            onSwitch={switchTo}
          />
        }
      />
      <Route
        path={patterns.newWorkspace}
        element={
          <CreateWorkspace
            heading="New workspace"
            blurb="A separate space inside this organization. Only people you add to it can see it."
            cancelTo={home?.workspaceId ? paths.workspace(home.workspaceId) : paths.root()}
            onCreate={async (name) => {
              try {
                await addWorkspace(name);
                return null;
              } catch (e) {
                return e instanceof Error ? e.message : 'Could not create the workspace.';
              }
            }}
          />
        }
      />
      <Route
        path={patterns.settings}
        element={
          <Settings
            session={session}
            backTo={home?.workspaceId ? paths.workspace(home.workspaceId) : paths.root()}
          />
        }
      />
      {/* Signed in, so the sign-in page is not a place to be; anything unrecognised resolves
          at the root rather than 404ing into a dead end. */}
      <Route path="*" element={<Navigate to={paths.root()} replace />} />
    </Routes>
  );
}

/**
 * The window chrome wraps every route, so it does not remount on navigation — and the strip
 * has to outlive the routes it points at.
 *
 * The session lives here rather than in `App` because the strip is scoped to exactly what the
 * session pins: account and organization, and nothing below them (D7).
 */
function Shell() {
  const api = useSession();
  const { pathname } = useLocation();
  // Which workspace is on screen, read from the address rather than the session — the session
  // does not hold one, by design (invariant 3).
  const currentWorkspaceId = matchPath(patterns.workspace, pathname)?.params.workspaceId ?? null;

  const session = api.state.status === 'in' ? api.state.session : null;
  const key =
    session?.organizationId != null
      ? { accountId: session.userId, organizationId: session.organizationId }
      : null;

  const inOrg = api.workspaces.filter((w) => w.organizationId === session?.organizationId);
  const home = inOrg.find((w) => w.isDefault) ?? inOrg[0];
  const homeLocation = home?.workspaceId ? paths.workspace(home.workspaceId) : paths.root();

  const tabs = useTabs(key, api.workspaces, homeLocation);

  // The panel's imperative handle: what the toggle button and ⌘B act on.
  const panel = usePanelRef();
  /**
   * The sidebar's live width in pixels. The title bar keeps a gutter this wide so the tabs
   * begin where the content column does.
   *
   * Observed on a div of our own that fills the panel, with a ResizeObserver. Two library
   * routes were tried first and both came up empty in v4: the panel's `onResize` fired once at
   * mount and never for a pointer drag (it is destructured upstream as `onResizeUnstable`),
   * and its `elementRef` never delivered the element to a callback ref. A plain React ref on a
   * plain element has no such semantics to get wrong, and the observer reports every real
   * width change — drag frames, collapse, restore, window resize — which is exactly the
   * contract the gutter needs.
   */
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [sidebarEl, setSidebarEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sidebarEl) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSidebarWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(sidebarEl);
    return () => ro.disconnect();
  }, [sidebarEl]);
  // v4 does not persist on its own: this hands back a `defaultLayout` to start from and an
  // `onLayoutChanged` that writes every user-driven change. Panel ids tie the saved sizes to
  // the panels they belong to.
  const layout = useDefaultLayout({
    id: 'relay.sidebar',
    storage: layoutStorage,
    panelIds: ['sidebar', 'content'],
  });
  const togglePanel = useCallback(() => {
    const p = panel.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, [panel]);
  useShellCommands({
    tabs,
    session,
    workspaces: api.workspaces,
    onToggleSidebar: togglePanel,
  });
  useDeepLinkNavigation(
    tabs.strip
      ? (path) => tabs.open(path, titleFor(path.split('?')[0]!, api.workspaces))
      : undefined,
  );

  // One switcher: the sidebar header holds it, and the screens that have nothing else on
  // them still need it to be reachable.
  const menu = session ? (
    <Switcher
      session={session}
      workspaces={api.workspaces}
      currentWorkspaceId={currentWorkspaceId}
      onSwitch={api.switchTo}
      accounts={api.accounts}
      onSwitchAccount={api.switchAccount}
      onAddAccount={api.addAccount}
    />
  ) : null;

  const content = <App api={api} />;

  return (
    <TabsProvider value={tabs}>
      <div className="flex h-full flex-col">
        {/* Both read the command store, so they list what is actually declared. Mounted at the
            shell so they outlive the routes whose commands they show. */}
        <ShortcutsSheet />
        <CommandPalette />
        {/* Above the sidebar, not beside it: the tabs belong to the window, not to a
            workspace, and the traffic lights sit in this strip. */}
        <TitleBar
          tabs={tabs}
          gutterWidth={sidebarWidth}
          onToggleSidebar={togglePanel}
          hasSidebar={session != null}
        />
        {session ? (
          /**
           * `open` is pinned: the provider is here for the menu's context, not for layout.
           * Width and whether the sidebar is open belong to the panel group below, which
           * persists them under its `id` and makes the divider a real drag handle.
           */
          <SidebarProvider open className="min-h-0 flex-1">
            <ResizablePanelGroup
              orientation="horizontal"
              id="relay.sidebar"
              className="min-h-0 flex-1"
              defaultLayout={layout.defaultLayout}
              onLayoutChanged={layout.onLayoutChanged}
            >
              {/**
               * The sidebar keeps its pixel width when the window is resized; the content
               * panel absorbs the difference.
               *
               * The library's default is `preserve-relative-size`, which holds each panel's
               * percentage of the group — so dragging the window edge scales the sidebar too,
               * and a chrome element the user has deliberately sized drifts on every resize.
               * The rule for every group we build: the fixed-width chrome preserves pixels,
               * and the flexible content panel keeps the default. A group needs at least one
               * of the latter, which is what makes this the right way round.
               */}
              <ResizablePanel
                id="sidebar"
                panelRef={panel}
                defaultSize={256}
                minSize={230}
                maxSize={320}
                groupResizeBehavior="preserve-pixel-size"
                collapsible
                collapsedSize={0}
              >
                {/* Fills the panel, so its width is the panel's — see `sidebarWidth`. */}
                <div ref={setSidebarEl} className="h-full min-h-0">
                  <AppSidebar
                    workspace={home}
                    email={session.email}
                    onSignOut={api.signOut}
                    switcher={menu}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="content" className="flex min-h-0 flex-col">
                <div className="min-h-0 flex-1">{content}</div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </SidebarProvider>
        ) : (
          // Signed out there is nothing to navigate; the sign-in screen owns the window.
          <div className="min-h-0 flex-1">{content}</div>
        )}
      </div>
    </TabsProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <HotkeysProvider>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </HotkeysProvider>
    </QueryClientProvider>
  </StrictMode>,
);
