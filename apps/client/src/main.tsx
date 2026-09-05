import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';

import { useSession } from '@/lib/session';
import { Home } from '@/routes/home';
import { SignIn } from '@/routes/sign-in';
import './styles.css';

function App() {
  const { state, signIn, cancelSignIn, signOut } = useSession();

  if (state.status === 'loading') return <div className="min-h-full" />;

  return (
    <Routes>
      {state.status === 'in' ? (
        <>
          <Route path="/" element={<Home session={state.session} onSignOut={signOut} />} />
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
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
