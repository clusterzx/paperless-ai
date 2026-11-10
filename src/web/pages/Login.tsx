import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { ArrowRight, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { Logo, Wordmark } from '../components/Brand';
import { Alert, Button, Field, Input } from '../components/ui';
import { errorMessage, post } from '../lib/api';
import { useSession } from '../lib/session';

/** Default content of the brand panel: what Paperless-AI does, with a small sample answer. */
function BrandPitch() {
  const features = [
    { icon: <Wand2 />, text: 'Titles, tags, correspondents, dates and custom fields – filled in automatically' },
    { icon: <Sparkles />, text: 'Ask your whole archive in plain language, answers cite their sources' },
    { icon: <ShieldCheck />, text: 'Paperless-ngx 2.x and 3.x · fully local with Ollama if you like' },
  ];
  return (
    <div className="max-w-md">
      <h2 className="text-[34px] leading-[1.1] font-semibold tracking-[-0.035em] text-fg">
        Your documents,
        <br />
        <span className="text-gradient">organised and answerable.</span>
      </h2>
      <ul className="mt-8 space-y-4">
        {features.map((f) => (
          <li key={f.text} className="flex gap-3 text-[14.5px] leading-relaxed text-muted">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/8 text-accent-text ring-1 ring-white/10 [&_svg]:size-4">{f.icon}</span>
            {f.text}
          </li>
        ))}
      </ul>
      <div aria-hidden className="mt-10 rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-pop backdrop-blur-md">
        <div className="text-[13px] font-medium text-fg">When does my car insurance renew?</div>
        <div className="mt-2.5 flex gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-linear-to-br from-accent to-accent-2 text-white">
            <Sparkles className="size-3" />
          </span>
          <p className="text-[13px] leading-relaxed text-muted">
            Your policy with HUK-COBURG renews on <b className="text-fg">1 January 2026</b>
            <span className="mx-1 inline-flex size-4 -translate-y-px items-center justify-center rounded-full bg-accent-soft font-mono text-[9.5px] font-semibold text-accent-text">1</span>, the
            annual premium is 486.20 EUR
            <span className="mx-1 inline-flex size-4 -translate-y-px items-center justify-center rounded-full bg-accent-soft font-mono text-[9.5px] font-semibold text-accent-text">2</span>.
          </p>
        </div>
      </div>
    </div>
  );
}

export function AuthShell({ title, subtitle, children, wide, aside }: { title: string; subtitle?: string; children: ReactNode; wide?: boolean; aside?: ReactNode }) {
  return (
    <div className="flex min-h-full bg-sheet">
      {/* The brand panel is always dark – data-theme scopes the dark tokens to it. */}
      <aside data-theme="dark" className="relative hidden w-[44%] max-w-[640px] shrink-0 overflow-hidden bg-canvas text-fg lg:flex">
        <div className="aurora absolute inset-0" />
        <div className="dot-grid absolute inset-0 opacity-40 [mask-image:radial-gradient(70%_60%_at_30%_40%,black,transparent)]" />
        <div className="relative flex min-h-full w-full flex-col p-10 xl:p-14">
          <Wordmark />
          <div className="my-auto py-12">{aside ?? <BrandPitch />}</div>
          <p className="text-xs text-faint">Open source · runs on your own server</p>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 items-center justify-center px-5 py-10 sm:px-10">
        <div className={wide ? 'w-full max-w-2xl' : 'w-full max-w-[360px]'}>
          <div className="mb-8">
            <Logo className="mb-8 size-10 lg:hidden" />
            <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.03em] text-fg">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Where to go after signing in: only paths on this origin ("/…" – not "//host" or "/\\host"). */
function nextPath(): string {
  // Read the raw query string – wouter's useSearch() returns it decoded, which breaks "&" inside `next`.
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  try {
    return new URL(next, window.location.origin).origin === window.location.origin ? next : '/';
  } catch {
    return '/';
  }
}

export default function LoginPage() {
  const { refresh } = useSession();
  const [, navigate] = useLocation();
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
      const next = nextPath();
      const s = await refresh();
      if (s && !s.setupRequired) navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Sign in to continue to Paperless-AI.">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Username" htmlFor="username">
          <Input id="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" loading={busy}>
          Sign in <ArrowRight className="size-4" />
        </Button>
      </form>
    </AuthShell>
  );
}
