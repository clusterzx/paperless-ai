import { useState, type FormEvent } from 'react';
import { useLocation, useSearch } from 'wouter';
import { LogIn } from 'lucide-react';
import { Logo } from '../components/Layout';
import { Alert, Button, Field, Input } from '../components/ui';
import { errorMessage, post } from '../lib/api';
import { useSession } from '../lib/session';

export function AuthShell({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(ellipse_at_top,var(--accent-soft),transparent_60%)] px-4 py-10">
      <div className={wide ? 'w-full max-w-3xl' : 'w-full max-w-sm'}>
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 size-12 rounded-xl shadow-card" />
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

export default function LoginPage() {
  const { refresh } = useSession();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { username, password });
      const s = await refresh();
      const next = new URLSearchParams(search).get('next');
      if (s && !s.setupRequired) navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to Paperless-AI">
      <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-surface p-6 shadow-pop">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Username" htmlFor="username">
          <Input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<LogIn className="size-4" />}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
