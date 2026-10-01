import { lazy, Suspense, useEffect } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { Layout } from './components/Layout';
import { ConfirmProvider, Spinner, ToastProvider } from './components/ui';
import { SessionProvider, useSession, useTheme } from './lib/session';

const LoginPage = lazy(() => import('./pages/Login'));
const SetupPage = lazy(() => import('./pages/Setup'));
const DashboardPage = lazy(() => import('./pages/Dashboard'));
const AskPage = lazy(() => import('./pages/Ask'));
const ChatPage = lazy(() => import('./pages/Chat'));
const ReviewPage = lazy(() => import('./pages/Review'));
const PlaygroundPage = lazy(() => import('./pages/Playground'));
const HistoryPage = lazy(() => import('./pages/History'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const LogsPage = lazy(() => import('./pages/Logs'));

function FullScreenSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

function Routes() {
  const { session } = useSession();
  const [location, navigate] = useLocation();
  useTheme(); // keep "system" theme in sync with the OS

  useEffect(() => {
    if (!session) return;
    const target = session.setupRequired
      ? session.needsUser || session.authenticated
        ? '/setup'
        : '/login'
      : !session.authenticated
        ? '/login'
        : null;
    if (target === '/setup' && location !== '/setup') navigate('/setup', { replace: true });
    else if (target === '/login' && location !== '/login') navigate(`/login?next=${encodeURIComponent(location)}`, { replace: true });
    else if (target === null && (location === '/setup' || location === '/login')) navigate('/', { replace: true });
  }, [session, location, navigate]);

  if (!session) return <FullScreenSpinner />;

  if (!session.authenticated || session.setupRequired) {
    return (
      <Suspense fallback={<FullScreenSpinner />}>
        <Switch>
          <Route path="/setup" component={SetupPage} />
          <Route path="/login" component={LoginPage} />
          <Route>
            <FullScreenSpinner />
          </Route>
        </Switch>
      </Suspense>
    );
  }

  return (
    <Layout>
      <Suspense fallback={<FullScreenSpinner />}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/ask" component={AskPage} />
          <Route path="/chat" component={ChatPage} />
          <Route path="/review" component={ReviewPage} />
          <Route path="/playground" component={PlaygroundPage} />
          <Route path="/history" component={HistoryPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/logs" component={LogsPage} />
          {/* Old URLs of Paperless-AI ≤ 3.x */}
          <Route path="/dashboard">
            <Redirect to="/" />
          </Route>
          <Route path="/rag">
            <Redirect to="/ask" />
          </Route>
          <Route path="/manual">
            <Redirect to="/review" />
          </Route>
          <Route path="/debug">
            <Redirect to="/logs" />
          </Route>
          <Route path="/login">
            <Redirect to="/" />
          </Route>
          <Route>
            <div className="p-10 text-center text-muted">Page not found.</div>
          </Route>
        </Switch>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <ConfirmProvider>
          <Routes />
        </ConfirmProvider>
      </ToastProvider>
    </SessionProvider>
  );
}
