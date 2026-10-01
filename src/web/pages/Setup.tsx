import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Rocket } from 'lucide-react';
import type { ConnectionTestResult } from '@shared/api';
import { AuthShell } from './Login';
import { AiSection, ConnectionSection, FunctionsSection, ProcessingSection, type Config, type Locked } from '../components/settingsForms';
import { Alert, Button, Field, Input, Spinner } from '../components/ui';
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

  return (
    <AuthShell title="Set up Paperless-AI" subtitle="Connect Paperless-ngx and your AI provider – it only takes a minute." wide>
      <ol className="mb-5 flex items-center gap-2 overflow-x-auto px-1 text-xs">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                i < index ? 'border-accent bg-accent text-white dark:text-[#04140e]' : i === index ? 'border-accent text-accent' : 'border-border text-faint',
              )}
            >
              {i < index ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn('whitespace-nowrap font-medium', i === index ? 'text-fg' : 'text-muted')}>{s.label}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
          </li>
        ))}
      </ol>

      <div className="rounded-2xl border border-border bg-surface p-6 shadow-pop">
        {step === 'account' && (
          <div className="mx-auto max-w-md space-y-4">
            <h2 className="text-lg font-semibold">Create your account</h2>
            <p className="text-sm text-muted">This account protects the Paperless-AI web interface.</p>
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
              <h2 className="text-lg font-semibold">Connect Paperless-ngx</h2>
              <p className="mt-1 text-sm text-muted">Works with Paperless-ngx 2.x and 3.x. The API user needs permission to view and change documents, tags, correspondents, document types and custom fields.</p>
            </div>
            <ConnectionSection draft={draft} set={set} locked={locked} apiBase="setup" />
          </div>
        )}
        {step === 'ai' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">Choose your AI provider</h2>
              <p className="mt-1 text-sm text-muted">Use a local model with Ollama for full privacy, or any OpenAI-compatible service.</p>
            </div>
            <AiSection draft={draft} set={set} locked={locked} apiBase="setup" />
          </div>
        )}
        {step === 'processing' && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">Processing</h2>
              <p className="mt-1 text-sm text-muted">Decide which documents are analyzed and what the AI may change. You can refine everything later in the settings.</p>
            </div>
            <ProcessingSection draft={draft} set={set} locked={locked} />
            <div className="border-t border-border pt-6">
              <h3 className="mb-4 text-sm font-semibold">What should the AI fill in?</h3>
              <FunctionsSection draft={draft} set={set} locked={locked} />
            </div>
          </div>
        )}
        {step === 'finish' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Ready to go</h2>
            <ul className="space-y-2 text-sm">
              <li>
                <span className="text-muted">Paperless-ngx:</span> {draft.paperless.url}
              </li>
              <li>
                <span className="text-muted">AI provider:</span> {draft.ai.provider} –{' '}
                {draft.ai.provider === 'openai' ? draft.ai.openai.model : draft.ai.provider === 'ollama' ? draft.ai.ollama.model : draft.ai.provider === 'custom' ? draft.ai.custom.model : draft.ai.azure.deployment}
              </li>
              <li>
                <span className="text-muted">Automatic processing:</span>{' '}
                {draft.processing.automatic ? `on (${draft.processing.scanInterval})${draft.processing.onlyTagged ? `, only documents tagged ${draft.processing.tags.join(', ') || '–'}` : ', all documents'}` : 'off'}
              </li>
              <li>
                <span className="text-muted">Ask your archive (RAG):</span> {draft.rag.enabled ? `on – embeddings: ${draft.rag.embeddingProvider}` : 'off'}
              </li>
            </ul>
            <p className="text-sm text-muted">No restart required – processing and indexing start right after saving.</p>
          </div>
        )}

        {error && (
          <Alert tone="danger" className="mt-5">
            {error}
          </Alert>
        )}

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-5">
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
              <Button variant="primary" icon={<Rocket className="size-4" />} loading={busy} onClick={() => finish(false)}>
                Finish setup
              </Button>
            </div>
          ) : (
            <Button variant="primary" loading={busy} onClick={next}>
              Continue <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
