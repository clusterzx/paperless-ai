import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Bot, Braces, Copy, Eye, EyeOff, FileCog, KeyRound, Link2, ListChecks, MessageSquareQuote, RefreshCw, Save, Sparkles, UserCog, Workflow } from 'lucide-react';
import { Page } from '../components/Layout';
import {
  AiSection,
  ConnectionSection,
  CustomFieldsSection,
  ExternalApiSection,
  FunctionsSection,
  ProcessingSection,
  PromptSection,
  RagSection,
  type Config,
  type Locked,
} from '../components/settingsForms';
import { Alert, Button, Card, Field, Input, PageHeader, Skeleton, Tabs, useConfirm, useToast } from '../components/ui';
import { ApiError, errorMessage, get, post, put } from '../lib/api';
import { changedPaths, useDraft } from '../lib/draft';
import { useMetadata } from '../lib/metadata';
import { useSession } from '../lib/session';

interface SettingsResponse {
  config: Config;
  locked: Locked;
  defaults: { systemPrompt: string };
  localEmbeddings: boolean;
}

type TabId = 'connection' | 'ai' | 'processing' | 'prompt' | 'fields' | 'external' | 'rag' | 'integrations' | 'account';

function CopyField({ value, secret }: { value: string; secret?: boolean }) {
  const toast = useToast();
  const [visible, setVisible] = useState(!secret);
  return (
    <div className="flex gap-2">
      <Input readOnly value={visible ? value : '•'.repeat(Math.min(value.length, 40))} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
      {secret && (
        <Button variant="ghost" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Hide' : 'Show'}>
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      )}
      <Button
        icon={<Copy className="size-4" />}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast.success('Copied to clipboard');
          } catch {
            toast.error('Copying failed – select the text and copy it manually');
          }
        }}
      >
        Copy
      </Button>
    </div>
  );
}

function IntegrationsTab({ locked }: { locked: Locked }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ apiKey: string }>('/api/settings/api-key')
      .then((r) => setApiKey(r.apiKey))
      .catch((err) => toast.error(errorMessage(err)));
  }, [toast]);
  const origin = window.location.origin;
  return (
    <div className="space-y-6">
      <Card title="API key" icon={<KeyRound className="size-4" />} description="Use it in the x-api-key header for the REST API, webhooks and the browser extension.">
        {apiKey === null ? <Skeleton className="h-9" /> : <CopyField value={apiKey} secret />}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            icon={<RefreshCw className="size-4" />}
            loading={busy}
            disabled={Boolean(locked['security.apiKey'])}
            onClick={async () => {
              if (!(await confirm({ title: 'Generate a new API key?', message: 'The current key stops working immediately. Update your webhooks and integrations afterwards.', confirmLabel: 'Generate', danger: true }))) return;
              setBusy(true);
              try {
                setApiKey((await post<{ apiKey: string }>('/api/settings/api-key/regenerate')).apiKey);
                toast.success('New API key generated');
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Regenerate
          </Button>
          <a href="/api-docs" target="_blank" rel="noreferrer" className="text-sm text-accent-text hover:underline">
            API documentation →
          </a>
        </div>
      </Card>
      <Card title="Process documents instantly with a Paperless workflow" icon={<Workflow className="size-4" />}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>
            In Paperless-ngx open <b className="text-fg">Workflows</b> → <b className="text-fg">Add workflow</b>, trigger <b className="text-fg">Document Added</b>.
          </li>
          <li>
            Add the action <b className="text-fg">Webhook</b> with this URL:
          </li>
        </ol>
        <div className="my-3">
          <CopyField value={`${origin}/api/webhook/document`} />
        </div>
        <ol start={3} className="list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>
            Enable <b className="text-fg">Use parameters for webhook body</b> and add the parameter <code className="kbd">url</code> = <code className="kbd">{'{doc_url}'}</code> – or send JSON <code className="kbd">{'{"url": "{doc_url}"}'}</code>.
          </li>
          <li>
            Add the header <code className="kbd">x-api-key</code> with the API key above.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted">Optional body fields: <code className="kbd">prompt</code> (custom prompt for this document) and <code className="kbd">force</code> (process even if already processed).</p>
      </Card>
    </div>
  );
}

function AccountTab() {
  const toast = useToast();
  const { session, refresh } = useSession();
  const [username, setUsername] = useState(session?.user?.username ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    if (next && next !== confirmPw) return setError('The new passwords do not match');
    setBusy(true);
    try {
      await post('/api/account/password', { currentPassword: current, newPassword: next, username: username.trim() || undefined });
      toast.success('Account updated');
      setCurrent('');
      setNext('');
      setConfirmPw('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Your account" icon={<UserCog className="size-4" />} className="max-w-xl">
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="New password" hint="Leave empty to keep the current password. Changing it signs out all other sessions.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        {next && (
          <Field label="Confirm new password">
            <Input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
          </Field>
        )}
        <Field label="Current password" hint="Required to confirm the change.">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
        <Button variant="primary" loading={busy} disabled={!current} onClick={submit}>
          Update account
        </Button>
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useSession();
  const meta = useMetadata();
  const search = useSearch();
  const [, navigate] = useLocation();
  const tab = ((new URLSearchParams(search).get('tab') as TabId) || 'connection') as TabId;
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, set, setDraft] = useDraft<Config | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get<SettingsResponse>('/api/settings')
      .then((r) => {
        setLoaded(r);
        setDraft(r.config);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [setDraft]);

  const dirty = loaded && draft ? changedPaths(loaded.config, draft).length > 0 : false;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = async (force = false) => {
    if (!draft || !loaded) return;
    setSaving(true);
    try {
      const res = await put<{ config: Config; locked: Locked; warnings: string[] }>('/api/settings', { config: draft, force });
      setLoaded({ ...loaded, config: res.config, locked: res.locked });
      setDraft(res.config);
      toast.success('Settings saved – changes are active immediately');
      for (const w of res.warnings) toast.error(w);
      await refresh();
      meta.reload();
    } catch (err) {
      if (err instanceof ApiError && err.body?.canForce && !force) {
        const ok = await confirm({
          title: err.body.step === 'paperless' ? 'Paperless-ngx connection failed' : 'AI connection failed',
          message: (
            <>
              <span className="block text-danger">{err.message}</span>
              <span className="mt-2 block">Save the settings anyway?</span>
            </>
          ),
          confirmLabel: 'Save anyway',
          danger: true,
        });
        if (ok) {
          setSaving(false);
          return save(true);
        }
      } else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) return <Page><Alert tone="danger">{loadError}</Alert></Page>;
  if (!loaded || !draft) return <Page><Skeleton className="h-96 rounded-xl" /></Page>;

  const locked = loaded.locked;
  const tagNames = meta.tags.map((t) => t.name);
  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: 'connection', label: 'Paperless', icon: <Link2 className="size-4" /> },
    { id: 'ai', label: 'AI provider', icon: <Bot className="size-4" /> },
    { id: 'processing', label: 'Processing', icon: <ListChecks className="size-4" /> },
    { id: 'prompt', label: 'Prompt', icon: <MessageSquareQuote className="size-4" /> },
    { id: 'fields', label: 'Custom fields', icon: <FileCog className="size-4" /> },
    { id: 'external', label: 'External data', icon: <Braces className="size-4" /> },
    { id: 'rag', label: 'Ask your archive', icon: <Sparkles className="size-4" /> },
    { id: 'integrations', label: 'API & webhooks', icon: <KeyRound className="size-4" /> },
    { id: 'account', label: 'Account', icon: <UserCog className="size-4" /> },
  ];
  const props = { draft, set, locked };
  const formTab = !['integrations', 'account'].includes(tab);

  return (
    <Page>
      <PageHeader title="Settings" description="All changes take effect immediately after saving – no restart required." />
      <Tabs value={tab} onChange={(t) => navigate(`/settings?tab=${t}`, { replace: true })} tabs={tabs} />
      <div className="mt-6 pb-24">
        {Object.keys(locked).length > 0 && formTab && (
          <Alert tone="warn" className="mb-6">
            Some settings are defined by environment variables (marked with a lock) and cannot be changed here.
          </Alert>
        )}
        {tab === 'connection' && (
          <Card title="Paperless-ngx connection" description="Compatible with Paperless-ngx 2.x and 3.x (API version is detected automatically).">
            <ConnectionSection {...props} apiBase="settings" />
          </Card>
        )}
        {tab === 'ai' && (
          <Card title="AI provider" description="Used for document analysis and both chats.">
            <AiSection {...props} apiBase="settings" />
          </Card>
        )}
        {tab === 'processing' && (
          <div className="space-y-6">
            <Card title="Automatic processing">
              <ProcessingSection {...props} tagSuggestions={tagNames} />
            </Card>
            <Card title="What the AI may change">
              <FunctionsSection {...props} />
            </Card>
          </div>
        )}
        {tab === 'prompt' && (
          <Card title="Prompt">
            <PromptSection {...props} defaultPrompt={loaded.defaults.systemPrompt} tagSuggestions={tagNames} />
          </Card>
        )}
        {tab === 'fields' && (
          <Card title="Custom fields" description="Values the AI should extract into Paperless custom fields.">
            <CustomFieldsSection {...props} />
          </Card>
        )}
        {tab === 'external' && (
          <Card title="External data">
            <ExternalApiSection {...props} />
          </Card>
        )}
        {tab === 'rag' && (
          <Card title="Ask your archive (RAG)" description="Semantic search and question answering over all documents.">
            <RagSection {...props} localEmbeddings={loaded.localEmbeddings} />
          </Card>
        )}
        {tab === 'integrations' && <IntegrationsTab locked={locked} />}
        {tab === 'account' && <AccountTab />}
      </div>

      {formTab && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 lg:pl-64">
          <div
            className={`pointer-events-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-pop backdrop-blur transition ${dirty ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'}`}
            aria-hidden={!dirty}
          >
            <span className="text-sm text-muted">You have unsaved changes</span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(loaded.config)}>
                Discard
              </Button>
              <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={() => save()}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
