import { useEffect, useMemo, useState } from 'react';
import { Archive, ArrowLeft, ArrowRight, Bot, Check, Plug, Rocket, Sparkles, Workflow } from 'lucide-react';
import type { ConnectionTestResult, SessionInfo } from '@shared/api';
import { AuthShell, OrDivider } from './Login';
import { SsoButton } from '../components/singleSignOn';
import { AiSection, ConnectionSection, FunctionsSection, modelOf, ProcessingSection, type Config, type Locked } from '../components/settingsForms';
import { Alert, Button, Field, IconChip, Input, Spinner } from '../components/ui';
import { ApiError, errorMessage, get, post } from '../lib/api';
import { useDraft } from '../lib/draft';
import { cn } from '../lib/format';
import { useSession } from '../lib/session';

interface Defaults {
  config: Config;
  locked: Locked;
  defaults: { systemPrompt: string };
  localEmbeddings: boolean;
  needsUser: boolean;
  archive?: { defaultStorageDir: string; networkWarning: string | null };
}

function ModeCard({ active, onClick, icon, title, children, disabled }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-full flex-col gap-3 rounded-2xl border p-5 text-left transition disabled:opacity-60',
        active ? 'border-accent bg-accent-soft/40 ring-4 ring-accent/15' : 'border-border bg-surface hover:border-border-strong',
      )}
    >
      <div className="flex items-center gap-3">
        <IconChip tone={active ? 'accent' : 'neutral'}>{icon}</IconChip>
        <span className="font-semibold text-fg">{title}</span>
        {active && <Check className="ml-auto size-4 text-accent" />}
      </div>
      <div className="text-sm text-muted">{children}</div>
    </button>
  );
}

function passwordScore(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
  return { score, label: pw.length < 8 ? labels[0] : labels[score] };
}

export default function SetupPage() {
  const { session, refresh } = useSession();
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    get<Defaults>('/api/setup/defaults')
      .then(setDefaults)
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  if (loadError) {
    return (
      <AuthShell title="Setup">
        <Alert tone="danger">{loadError}</Alert>
      </AuthShell>
    );
  }
  if (!defaults) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  return <Wizard defaults={defaults} login={session?.login ?? { password: true, sso: null }} onDone={refresh} />;
}

type StepId = 'account' | 'archive' | 'paperless' | 'ai' | 'processing' | 'finish';

function Wizard({ defaults, login, onDone }: { defaults: Defaults; login: SessionInfo['login']; onDone: () => Promise<unknown> }) {
  const [draft, set] = useDraft<Config>(defaults.config);
  const locked = defaults.locked;
  const builtin = draft.archive.mode === 'builtin';
  const [libraryName, setLibraryName] = useState('Archive');
  const steps = useMemo<{ id: StepId; label: string }[]>(
    () => [
      ...(defaults.needsUser ? [{ id: 'account' as const, label: 'Account' }] : []),
      { id: 'archive', label: 'Archive' },
      ...(builtin ? [] : [{ id: 'paperless' as const, label: 'Paperless-ngx' }]),
      { id: 'ai', label: 'AI provider' },
      { id: 'processing', label: 'Processing' },
      { id: 'finish', label: 'Finish' },
    ],
    [defaults.needsUser, builtin],
  );
  const [index, setIndex] = useState(0);
  const step = steps[index].id;
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // A failed single sign-on on a fresh installation comes back as /setup?sso_error=…
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get('sso_error'));
  const [busy, setBusy] = useState(false);
  const [canForce, setCanForce] = useState(false);
  /** Without the password login the first account can only come from single sign-on. */
  const ssoOnly = !login.password && Boolean(login.sso);
  const pw = passwordScore(password);

  const next = async () => {
    setError(null);
    if (step === 'account') {
      if (!username.trim()) return setError('Please choose a username');
      if (password.length < 8) return setError('The password must be at least 8 characters long');
      if (password !== confirm) return setError('The passwords do not match');
    }
    if (step === 'paperless') {
      setBusy(true);
      try {
        const res = await post<ConnectionTestResult>('/api/setup/test-paperless', { url: draft.paperless.url, token: draft.paperless.token });
        if (!res.ok) return setError(res.message);
      } catch (err) {
        return setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    }
    setIndex((i) => Math.min(i + 1, steps.length - 1));
  };

  const finish = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/setup', {
        username: defaults.needsUser ? username.trim() : undefined,
        password: defaults.needsUser ? password : undefined,
        config: {
          archive: draft.archive,
          ...(builtin ? { libraryName, ocr: locked['ocr.enabled'] ? {} : { enabled: true, mode: draft.ocr.mode } } : { paperless: draft.paperless }),
          ai: draft.ai,
          processing: draft.processing,
          rag: draft.rag,
        },
        force,
      });
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
      setCanForce(err instanceof ApiError && Boolean(err.body?.canForce));
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<StepId, string> = {
    account: 'Create your account',
    archive: 'Where do your documents live?',
    paperless: 'Connect Paperless-ngx',
    ai: 'Choose your AI provider',
    processing: 'Processing',
    finish: 'Ready to go',
  };
  const descriptions: Record<StepId, string> = {
    account: 'Protects the web interface',
    archive: 'Paperless-ngx or the built-in archive',
    paperless: 'URL and API token',
    ai: 'Cloud, compatible API or local',
    processing: 'What the AI may change',
    finish: 'Review and start',
  };
  const stepper = (
    <div className="max-w-sm">
      <h2 className="text-[30px] leading-[1.1] font-semibold tracking-[-0.035em] text-fg">
        Let&apos;s get you <span className="text-gradient">set up.</span>
      </h2>
      <p className="mt-3 text-[15px] text-muted">A few steps and Paperless-AI starts organising your documents – no restart needed.</p>
      <ol className="mt-10">
        {steps.map((s, i) => (
          <li key={s.id} className="relative flex gap-4 pb-7 last:pb-0">
            {i < steps.length - 1 && <span className={cn('absolute top-8 bottom-1 left-[13px] w-px', i < index ? 'bg-accent' : 'bg-white/12')} />}
            <span
              className={cn(
                'relative flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 transition',
                i < index ? 'bg-accent text-on-accent ring-accent' : i === index ? 'bg-accent-soft text-accent-text ring-accent/60' : 'text-faint ring-white/15',
              )}
            >
              {i < index ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <div className="pt-0.5">
              <div className={cn('text-sm font-medium', i <= index ? 'text-fg' : 'text-faint')}>{s.label}</div>
              <div className="text-xs text-faint">{descriptions[s.id]}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );

  return (
    <AuthShell title={titles[step]} subtitle={`Step ${index + 1} of ${steps.length} · ${descriptions[step]}`} wide aside={stepper}>
      <div className="mb-8 h-1 overflow-hidden rounded-full bg-surface-3 lg:hidden">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
      </div>

      <div>
        {step === 'account' && login.sso && (
          <div className="max-w-md">
            <p className="mb-4 text-sm text-muted">
              {ssoOnly
                ? 'Sign in with your single sign-on account – it becomes the first Paperless-AI account. You come back here afterwards.'
                : 'Sign in with your single sign-on account – or create a local account with a password below.'}
            </p>
            <SsoButton label={login.sso} next="/setup" primary={ssoOnly} />
            {!ssoOnly && <OrDivider />}
          </div>
        )}
        {step === 'account' && !ssoOnly && (
          <div className="max-w-md space-y-4">
            <Field label="Username">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
            </Field>
            <Field label="Password" hint={password ? `Strength: ${pw.label}` : 'At least 8 characters'}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <div className="mt-2 flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className={cn('h-1 flex-1 rounded-full', i < pw.score ? (pw.score >= 3 ? 'bg-accent' : 'bg-warn') : 'bg-surface-3')} />
                ))}
              </div>
            </Field>
            <Field label="Confirm password" error={confirm && confirm !== password ? 'The passwords do not match' : null}>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
        )}
        {step === 'archive' && (
          <div className="space-y-6">
            <div role="radiogroup" aria-label="Archive" className="grid gap-4 sm:grid-cols-2">
              <ModeCard active={!builtin} onClick={() => set('archive.mode', 'paperless')} icon={<Plug />} title="With Paperless-ngx" disabled={Boolean(locked['archive.mode'])}>
                Paperless-AI runs next to your Paperless-ngx: it analyses, enriches and searches the documents there. Nothing changes in how you use Paperless-ngx.
              </ModeCard>
              <ModeCard active={builtin} onClick={() => set('archive.mode', 'builtin')} icon={<Archive />} title="Built-in archive" disabled={Boolean(locked['archive.mode'])}>
                Paperless-AI is the archive: upload, watch folder, e-mail and WebDAV, versions, libraries for several users, workflows. No Paperless-ngx, Redis or Postgres needed.
              </ModeCard>
            </div>
            {builtin && (
              <div className="space-y-4">
                {defaults.archive?.networkWarning && <Alert tone="warn">{defaults.archive.networkWarning}</Alert>}
                <Field label="Name of the first library" hint="More libraries (e.g. per family member) can be added later.">
                  <Input value={libraryName} onChange={(e) => setLibraryName(e.target.value)} />
                </Field>
                <Field label="File storage" hint={`Where the files are kept. Empty: ${defaults.archive?.defaultStorageDir ?? 'data/library'}`} locked={locked['archive.builtin.storageDir']}>
                  <Input value={draft.archive.builtin.storageDir} onChange={(e) => set('archive.builtin.storageDir', e.target.value)} placeholder={defaults.archive?.defaultStorageDir} disabled={Boolean(locked['archive.builtin.storageDir'])} />
                </Field>
                <Field label="Watch folder (optional)" hint="Files dropped here (e.g. by a scanner) are imported and removed from the folder." locked={locked['archive.builtin.consumeDir']}>
                  <Input value={draft.archive.builtin.consumeDir} onChange={(e) => set('archive.builtin.consumeDir', e.target.value)} placeholder="/consume" disabled={Boolean(locked['archive.builtin.consumeDir'])} />
                </Field>
                <p className="text-xs text-muted">OCR is switched on for the built-in archive: scans are read with PaddleOCR, digital PDFs keep their own text.</p>
              </div>
            )}
          </div>
        )}
        {step === 'paperless' && (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted">Works with Paperless-ngx 2.x and 3.x. The API user needs permission to view and change documents, tags, correspondents, document types and custom fields.</p>
            </div>
            <ConnectionSection draft={draft} set={set} locked={locked} apiBase="setup" />
          </div>
        )}
        {step === 'ai' && (
          <div className="space-y-4">
            <div>
              <p className="text-sm text-muted">Use a local model with Ollama for full privacy, or any OpenAI-compatible service.</p>
            </div>
            <AiSection draft={draft} set={set} locked={locked} apiBase="setup" />
          </div>
        )}
        {step === 'processing' && (
          <div className="space-y-6">
            <div>
              <p className="text-sm text-muted">Decide which documents are analyzed and what the AI may change. You can refine everything later in the settings.</p>
            </div>
            <ProcessingSection draft={draft} set={set} locked={locked} />
            <div className="border-t border-border pt-6">
              <h3 className="mb-4 text-sm font-semibold">What should the AI fill in?</h3>
              <FunctionsSection draft={draft} set={set} locked={locked} />
            </div>
          </div>
        )}
        {step === 'finish' && (
          <div className="space-y-5">
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
              {[
                builtin
                  ? { icon: <Archive />, label: 'Archive', value: `Built-in · library “${libraryName}”${draft.archive.builtin.consumeDir ? ` · watch folder ${draft.archive.builtin.consumeDir}` : ''}` }
                  : { icon: <Plug />, label: 'Paperless-ngx', value: draft.paperless.url },
                {
                  icon: <Bot />,
                  label: 'AI provider',
                  value: `${draft.ai.provider} · ${modelOf(draft.ai)}`,
                },
                {
                  icon: <Workflow />,
                  label: 'Automatic processing',
                  value: draft.processing.automatic
                    ? `On (${draft.processing.scanInterval})${draft.processing.onlyTagged ? ` · only documents tagged ${draft.processing.tags.join(', ') || '–'}` : ' · all documents'}`
                    : 'Off',
                },
                { icon: <Sparkles />, label: 'Ask your archive', value: draft.rag.enabled ? `On · embeddings: ${draft.rag.embeddingProvider}` : 'Off' },
              ].map((r) => (
                <li key={r.label} className="flex items-center gap-3.5 px-4 py-3.5">
                  <IconChip tone="accent">{r.icon}</IconChip>
                  <div className="min-w-0">
                    <div className="text-xs text-muted">{r.label}</div>
                    <div className="truncate text-sm font-medium text-fg">{r.value}</div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">No restart required – processing and indexing start right after saving.</p>
          </div>
        )}

        {error && (
          <Alert tone="danger" className="mt-5">
            {error}
          </Alert>
        )}

        <div className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-6">
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} disabled={index === 0 || busy} onClick={() => setIndex((i) => i - 1)}>
            Back
          </Button>
          {step === 'finish' ? (
            <div className="flex gap-2">
              {canForce && (
                <Button variant="ghost" onClick={() => finish(true)} disabled={busy}>
                  Save anyway
                </Button>
              )}
              <Button variant="primary" size="lg" icon={<Rocket className="size-4" />} loading={busy} onClick={() => finish(false)}>
                Finish setup
              </Button>
            </div>
          ) : step === 'account' && ssoOnly ? null : (
            <Button variant="primary" size="lg" loading={busy} onClick={next}>
              Continue <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
