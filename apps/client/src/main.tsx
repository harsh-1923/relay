import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { TitleBar } from '@/components/title-bar';
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
  menu,
}: {
  session: Session;
  workspaces: SwitchTarget[];
  workspacesPending: boolean;
  onCreate: (name: string) => Promise<string | null>;
  menu: ReactNode;
}) {
  if (!session.organizationId) return <CreateWorkspace onCreate={onCreate} />;

  const target = workspaces.find((w) => w.organizationId === session.organizationId);
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
          otherwise open a different one below.
        </p>
        {menu}
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
    workspaces,
    workspacesPending,
    switchTo,
    accounts,
    switchAccount,
    addAccount,
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
  const home = workspaces.find((w) => w.organizationId === session.organizationId);

  // One switcher, rendered by whichever screen is up — including the one that has nothing
  // else on it.
  const menu = (
    <Switcher
      session={session}
      workspaces={workspaces}
      onSwitch={switchTo}
      accounts={accounts}
      onSwitchAccount={switchAccount}
      onAddAccount={addAccount}
    />
  );

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
            menu={menu}
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
            menu={menu}
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

  const session = api.state.status === 'in' ? api.state.session : null;
  const key =
    session?.organizationId != null
      ? { accountId: session.userId, organizationId: session.organizationId }
      : null;

  const tabs = useTabs(key, api.workspaces);
  const home = api.workspaces.find((w) => w.organizationId === session?.organizationId);

  useDeepLinkNavigation(
    tabs.strip
      ? (path) => tabs.open(path, titleFor(path.split('?')[0]!, api.workspaces))
      : undefined,
  );

  return (
    <TabsProvider value={tabs}>
      <div className="flex h-full flex-col">
        <TitleBar
          tabs={tabs}
          onNew={
            home?.workspaceId
              ? () => tabs.open(paths.workspace(home.workspaceId!), home.name)
              : undefined
          }
        />
        <div className="min-h-0 flex-1">
          <App api={api} />
        </div>
      </div>
    </TabsProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
