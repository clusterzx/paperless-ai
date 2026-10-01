import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, Plug, Rocket, Sparkles, Workflow } from 'lucide-react';
import type { ConnectionTestResult } from '@shared/api';
import { AuthShell } from './Login';
import { AiSection, ConnectionSection, FunctionsSection, ProcessingSection, type Config, type Locked } from '../components/settingsForms';
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
  const { refresh } = useSession();
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
  return <Wizard defaults={defaults} onDone={refresh} />;
}

type StepId = 'account' | 'paperless' | 'ai' | 'processing' | 'finish';

function Wizard({ defaults, onDone }: { defaults: Defaults; onDone: () => Promise<unknown> }) {
  const [draft, set] = useDraft<Config>(defaults.config);
  const locked = defaults.locked;
  const steps = useMemo<{ id: StepId; label: string }[]>(
    () => [
      ...(defaults.needsUser ? [{ id: 'account' as const, label: 'Account' }] : []),
      { id: 'paperless', label: 'Paperless-ngx' },
      { id: 'ai', label: 'AI provider' },
      { id: 'processing', label: 'Processing' },
      { id: 'finish', label: 'Finish' },
    ],
    [defaults.needsUser],
  );
  const [index, setIndex] = useState(0);
  const step = steps[index].id;
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [canForce, setCanForce] = useState(false);
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
        config: { paperless: draft.paperless, ai: draft.ai, processing: draft.processing, rag: draft.rag },
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
    paperless: 'Connect Paperless-ngx',
    ai: 'Choose your AI provider',
    processing: 'Processing',
    finish: 'Ready to go',
  };
  const descriptions: Record<StepId, string> = {
    account: 'Protects the web interface',
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
        {step === 'account' && (
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
                { icon: <Plug />, label: 'Paperless-ngx', value: draft.paperless.url },
                {
                  icon: <Bot />,
                  label: 'AI provider',
                  value: `${draft.ai.provider} · ${draft.ai.provider === 'openai' ? draft.ai.openai.model : draft.ai.provider === 'ollama' ? draft.ai.ollama.model : draft.ai.provider === 'custom' ? draft.ai.custom.model : draft.ai.azure.deployment}`,
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
          ) : (
            <Button variant="primary" size="lg" loading={busy} onClick={next}>
              Continue <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
