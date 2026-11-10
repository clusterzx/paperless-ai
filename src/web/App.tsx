import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { RefreshCw } from 'lucide-react';
import { Layout } from './components/Layout';
import { Button, ConfirmProvider, EmptyState, Spinner, ToastProvider } from './components/ui';
import { SessionProvider, ThemeProvider, useSession } from './lib/session';

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

/** Shows a friendly message instead of a blank page when a page crashes or cannot be loaded (e.g. after an upgrade). */
class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey: string }) {
    // Navigating to another page gives it a fresh start.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="This page could not be displayed"
          action={
            <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        >
          If Paperless-AI was updated in the meantime, reloading loads the new version.
          <span className="mt-2 block font-mono text-xs break-words text-faint">{this.state.error.message}</span>
        </EmptyState>
      </div>
    );
  }
}

function Routes() {
  const { session } = useSession();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (!session) return;
    const target = session.setupRequired
      ? session.needsUser || session.authenticated
        ? '/setup'
        : '/login'
      : !session.authenticated
        ? '/login'
        : null;
    // `next` keeps the raw query string (wouter's useSearch() returns it decoded).
    if (target === '/setup' && location !== '/setup') navigate('/setup', { replace: true });
    else if (target === '/login' && location !== '/login') navigate(`/login?next=${encodeURIComponent(location + window.location.search)}`, { replace: true });
    else if (target === null && (location === '/setup' || location === '/login')) navigate('/', { replace: true });
  }, [session, location, navigate]);

  if (!session) return <FullScreenSpinner />;

  if (!session.authenticated || session.setupRequired) {
    return (
      <ErrorBoundary resetKey={location}>
        <Suspense fallback={<FullScreenSpinner />}>
          <Switch>
            <Route path="/setup" component={SetupPage} />
            <Route path="/login" component={LoginPage} />
            <Route>
              <FullScreenSpinner />
            </Route>
          </Switch>
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <Layout>
      <ErrorBoundary resetKey={location}>
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
      </ErrorBoundary>
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes />
          </ConfirmProvider>
        </ToastProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
