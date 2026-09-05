import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { queryClient } from '@/lib/query';
import { useSession } from '@/lib/session';
import { CreateWorkspace } from '@/routes/create-workspace';
import { Home } from '@/routes/home';
import { SignIn } from '@/routes/sign-in';
import './styles.css';

function App() {
  const {
    state,
    signIn,
    cancelSignIn,
    signOut,
    createWorkspace,
    workspaces,
    switchTo,
    accounts,
    switchAccount,
    addAccount,
  } = useSession();

  if (state.status === 'loading') return <div className="min-h-full" />;

  return (
    <Routes>
      {state.status === 'in' ? (
        <>
          <Route
            path="/"
            element={
              /* No organization yet: nothing scopes this user to a tenant, so the only
                 thing to do is create one. */
              state.session.organizationId ? (
                <Home
                  session={state.session}
                  onSignOut={signOut}
                  workspaces={workspaces}
                  onSwitch={switchTo}
                  accounts={accounts}
                  onSwitchAccount={switchAccount}
                  onAddAccount={addAccount}
                />
              ) : (
                <CreateWorkspace onCreate={createWorkspace} />
              )
            }
          />
          <Route path="/sign-in" element={<Navigate to="/" replace />} />
        </>
      ) : (
        <>
          <Route
            path="/sign-in"
            element={
              <SignIn
                pending={state.status === 'pending'}
                error={state.status === 'out' ? state.error : undefined}
                onSignIn={signIn}
                onCancel={cancelSignIn}
              />
            }
          />
          <Route path="*" element={<Navigate to="/sign-in" replace />} />
        </>
      )}
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
