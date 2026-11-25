import { useEffect, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  Bot,
  Braces,
  Copy,
  Eye,
  EyeOff,
  FileCog,
  KeyRound,
  Link2,
  ListChecks,
  LogIn,
  Mail,
  MessageSquareQuote,
  ScanText,
  RefreshCw,
  Save,
  Sparkles,
  UserCog,
  Users,
  Archive as ArchiveIcon,
  Inbox as InboxIcon,
  ScrollText,
  Webhook,
  Workflow,
} from 'lucide-react';
import { ApiKeysCard, AuditLogCard, UsersTab } from '../components/accessAdmin';
import { ArchiveSection, NotificationsSection } from '../components/archiveSettings';
import { Page } from '../components/Layout';
import { TwoFactorCard } from '../components/twoFactor';
import { SingleSignOnCard } from '../components/singleSignOn';
import {
  AiSection,
  ConnectionSection,
  CustomFieldsSection,
  ExternalApiSection,
  FunctionsSection,
  ProcessingSection,
  OcrSection,
  PromptSection,
  RagSection,
  SignInSection,
  type Config,
  type Locked,
} from '../components/settingsForms';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Tabs,
  tabPanelProps,
  useConfirm,
  useToast,
} from '../components/ui';
import type { AccountInfo, LibraryInfo } from '@shared/api';
import { ApiError, errorMessage, get, patch, post, put } from '../lib/api';
import { changedPaths, useDraft } from '../lib/draft';
import { useAsync, useUnsavedChanges } from '../lib/hooks';
import { useMetadata } from '../lib/metadata';
import { useSession } from '../lib/session';

interface SettingsResponse {
  config: Config;
  locked: Locked;
  defaults: { systemPrompt: string };
  localEmbeddings: boolean;
  ocr: { available: boolean; cudaAvailable: boolean };
}

const TAB_IDS = ['archive', 'connection', 'ai', 'processing', 'prompt', 'fields', 'ocr', 'external', 'rag', 'signin', 'notifications', 'integrations', 'users', 'audit', 'keys', 'account'] as const;
/** Tabs members see (everything else is administration). */
const MEMBER_TABS = ['account', 'keys'] as const;
type TabId = (typeof TAB_IDS)[number];

function CopyField({ value, secret }: { value: string; secret?: boolean }) {
  const toast = useToast();
  const [visible, setVisible] = useState(!secret);
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        value={visible ? value : '•'.repeat(Math.min(value.length, 40))}
        className="font-mono text-xs"
        onFocus={(e) => e.target.select()}
      />
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
      <Card
        title="Global API key"
        icon={<KeyRound className="size-4" />}
        description="The key of earlier versions: full administrator access. Prefer personal keys with limited permissions (Settings → API keys) – this one keeps the browser extension and existing webhooks working."
      >
        {apiKey === null ? <Skeleton className="h-9" /> : <CopyField value={apiKey} secret />}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            icon={<RefreshCw className="size-4" />}
            loading={busy}
            disabled={Boolean(locked['security.apiKey'])}
            onClick={async () => {
              if (
                !(await confirm({
                  title: 'Generate a new API key?',
                  message: 'The current key stops working immediately. Update your webhooks and integrations afterwards.',
                  confirmLabel: 'Generate',
                  danger: true,
                }))
              )
                return;
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
            In Paperless-ngx open <b className="text-fg">Workflows</b> → <b className="text-fg">Add workflow</b>, trigger{' '}
            <b className="text-fg">Document Added</b>.
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
            Enable <b className="text-fg">Use parameters for webhook body</b> and add the parameter{' '}
            <code className="kbd">url</code> = <code className="kbd">{'{{ doc_url }}'}</code> – or send JSON{' '}
            <code className="kbd">{'{"url": "{{ doc_url }}"}'}</code>. Older Paperless-ngx versions write the placeholder with single braces:{' '}
            <code className="kbd">{'{doc_url}'}</code>.
          </li>
          <li>
            Add the header <code className="kbd">x-api-key</code> with the API key above.
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted">
          Optional body fields: <code className="kbd">prompt</code> (custom prompt for this document) and{' '}
          <code className="kbd">force</code> (process even if already processed).
        </p>
      </Card>
    </div>
  );
}

function PasswordCard() {
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
      await post('/api/account/password', {
        currentPassword: current,
        newPassword: next,
        username: username.trim() || undefined,
      });
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

/** Built-in archive: where the user's uploads go without a chosen library (share, WebDAV, apps, API). */
function UploadsCard({ account, onChange }: { account: AccountInfo; onChange: () => void }) {
  const toast = useToast();
  const libraries = useAsync((signal) => get<LibraryInfo[]>('/api/libraries', signal), []);
  const writable = (libraries.data ?? []).filter((l) => l.role === 'owner' || l.role === 'editor').sort((a, b) => a.id - b.id);
  const [busy, setBusy] = useState(false);
  const save = async (value: string) => {
    setBusy(true);
    try {
      await patch('/api/account/profile', { defaultLibraryId: value ? Number(value) : null });
      toast.success('Default library saved');
      onChange();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  if (libraries.data && writable.length < 2) return null;
  return (
    <Card title="Uploads" icon={<InboxIcon className="size-4" />} className="max-w-xl">
      <Field
        label="Default library"
        hint="Where your documents go when no library is chosen: sharing from the phone, the WebDAV inbox root, scanner apps and API uploads without a library. An API key limited to libraries uses its own."
      >
        <Select value={account.defaultLibraryId ?? ''} disabled={busy || !libraries.data} onChange={(e) => void save(e.target.value)}>
          <option value="">{writable[0] ? `The oldest one I can add to (${writable[0].name})` : 'The oldest one I can add to'}</option>
          {writable.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>
    </Card>
  );
}

/** Settings → Account: password, single sign-on, two-factor authentication. */
function AccountTab() {
  const toast = useToast();
  const search = useSearch();
  const [, navigate] = useLocation();
  const account = useAsync((signal) => get<AccountInfo>('/api/account', signal), []);
  const { session } = useSession();
  // Back from linking at the provider: ?sso=linked or ?sso_error=…
  const [ssoError] = useState(() => new URLSearchParams(search).get('sso_error'));
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get('sso') === 'linked') toast.success('Your account is now linked with single sign-on');
    if (params.has('sso') || params.has('sso_error')) navigate('/settings?tab=account', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (account.error) return <Alert tone="danger">{account.error}</Alert>;
  const a = account.data;
  if (!a) return <Skeleton className="h-64 max-w-xl rounded-xl" />;
  return (
    <div className="space-y-6">
      {a.hasPassword ? (
        <PasswordCard />
      ) : (
        <Card title="Your account" icon={<UserCog className="size-4" />} className="max-w-xl">
          <p className="text-sm">
            Signed in as <strong>{a.user?.username}</strong>.
          </p>
          <p className="mt-1 text-sm text-muted">This account was created by single sign-on – it has no password; the provider takes care of it (including multi-factor authentication).</p>
        </Card>
      )}
      {session?.archive?.capabilities.libraries && <UploadsCard account={a} onChange={() => void account.reload()} />}
      {(a.sso.available || a.sso.linked || ssoError) && <SingleSignOnCard account={a} error={ssoError} onChange={() => void account.reload()} />}
      {a.hasPassword && <TwoFactorCard />}
    </div>
  );
}

/** Settings of members: their account and their API keys. */
function MemberSettings() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const requested = new URLSearchParams(search).get('tab');
  const tab = MEMBER_TABS.find((t) => t === requested) ?? 'account';
  return (
    <Page>
      <PageHeader title="Settings" description="Your account and your API keys." />
      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Tabs
            id="settings"
            vertical
            value={tab}
            onChange={(t) => navigate(`/settings?tab=${t}`, { replace: true })}
            tabs={[
              { id: 'account', label: 'Account', icon: <UserCog className="size-4" /> },
              { id: 'keys', label: 'API keys', icon: <KeyRound className="size-4" /> },
            ]}
          />
        </div>
        <div className="mt-6 min-w-0 pb-24 lg:mt-0" {...tabPanelProps('settings', tab)}>
          {tab === 'account' && <AccountTab />}
          {tab === 'keys' && <ApiKeysCard />}
        </div>
      </div>
    </Page>
  );
}

export default function SettingsPage() {
  const { session } = useSession();
  return session?.user?.role === 'admin' ? <AdminSettings /> : <MemberSettings />;
}

function AdminSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const { refresh } = useSession();
  const meta = useMetadata();
  const search = useSearch();
  const [, navigate] = useLocation();
  const requested = new URLSearchParams(search).get('tab');
  // Unknown tabs (old links, typos) show the first tab instead of an empty page.
  const { session } = useSession();
  const builtin = session?.archive?.mode === 'builtin';
  const tab: TabId = TAB_IDS.find((t) => t === requested && (t !== 'archive' || builtin)) ?? (builtin ? 'archive' : 'connection');
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, set, setDraft] = useDraft<Config | null>(null);
  const [saving, setSaving] = useState(false);
  // Whether the signed-in account is linked with single sign-on (needed to switch off the password login).
  const account = useAsync((signal) => (tab === 'signin' ? get<AccountInfo>('/api/account', signal) : Promise.resolve(null)), [tab]);

  useEffect(() => {
    get<SettingsResponse>('/api/settings')
      .then((r) => {
        setLoaded(r);
        setDraft(r.config);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [setDraft]);

  const dirty = loaded && draft ? changedPaths(loaded.config, draft).length > 0 : false;
  useUnsavedChanges(dirty);

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
          title:
            err.body.step === 'paperless'
              ? 'Paperless-ngx connection failed'
              : err.body.step === 'oidc'
                ? 'Sign-in provider not reachable'
                : 'AI connection failed',
          message: (
            <>
              <span className="block text-danger">{err.message}</span>
              <span className="mt-2 block">Save the settings anyway?</span>
            </>
          ),
          confirmLabel: 'Save anyway',
          danger: true,
        });
        // Awaited, so `finally` below does not reset `saving` while the forced save runs.
        if (ok) return await save(true);
      } else toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loadError)
    return (
      <Page>
        <Alert tone="danger">{loadError}</Alert>
      </Page>
    );
  if (!loaded || !draft)
    return (
      <Page>
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    );

  const locked = loaded.locked;
  const tagNames = meta.tags.map((t) => t.name);
  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    ...(builtin ? [{ id: 'archive' as const, label: 'Archive', icon: <ArchiveIcon className="size-4" /> }] : []),
    { id: 'connection', label: builtin ? 'Paperless-ngx (import)' : 'Paperless', icon: <Link2 className="size-4" /> },
    { id: 'ai', label: 'AI provider', icon: <Bot className="size-4" /> },
    { id: 'processing', label: 'Processing', icon: <ListChecks className="size-4" /> },
    { id: 'prompt', label: 'Prompt', icon: <MessageSquareQuote className="size-4" /> },
    { id: 'fields', label: 'Custom fields', icon: <FileCog className="size-4" /> },
    { id: 'ocr', label: 'OCR', icon: <ScanText className="size-4" /> },
    { id: 'external', label: 'External data', icon: <Braces className="size-4" /> },
    { id: 'rag', label: 'Ask your archive', icon: <Sparkles className="size-4" /> },
    { id: 'signin', label: 'Sign-in', icon: <LogIn className="size-4" /> },
    { id: 'notifications', label: 'Notifications', icon: <Mail className="size-4" /> },
    { id: 'integrations', label: 'API & webhooks', icon: <Webhook className="size-4" /> },
    { id: 'users', label: 'Users & groups', icon: <Users className="size-4" /> },
    { id: 'audit', label: 'Audit log', icon: <ScrollText className="size-4" /> },
    { id: 'keys', label: 'API keys', icon: <KeyRound className="size-4" /> },
    { id: 'account', label: 'Account', icon: <UserCog className="size-4" /> },
  ];
  const props = { draft, set, locked };
  const formTab = !['integrations', 'users', 'audit', 'keys', 'account'].includes(tab);

  return (
    <Page>
      <PageHeader title="Settings" description="All changes take effect immediately after saving – no restart required." />
      <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Tabs
            id="settings"
            vertical
            value={tab}
            onChange={(t) => navigate(`/settings?tab=${t}`, { replace: true })}
            tabs={tabs}
          />
        </div>
        <div className="mt-6 min-w-0 pb-24 lg:mt-0" {...tabPanelProps('settings', tab)}>
          {Object.keys(locked).length > 0 && formTab && (
            <Alert tone="warn" className="mb-6">
              Some settings are defined by environment variables (marked with a lock) and cannot be changed here.
            </Alert>
          )}
          {tab === 'archive' && <ArchiveSection draft={draft} set={set} locked={locked} />}
          {tab === 'notifications' && <NotificationsSection draft={draft} set={set} locked={locked} dirty={dirty} />}
          {tab === 'connection' && (
            <Card
              title="Paperless-ngx connection"
              description="Compatible with Paperless-ngx 2.x and 3.x (API version is detected automatically)."
            >
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
          {tab === 'ocr' && (
            <Card title="OCR (PaddleOCR)" description="Text recognition for scans and photos – runs locally on CPU or NVIDIA GPU.">
              <OcrSection {...props} available={loaded.ocr.available} cudaAvailable={loaded.ocr.cudaAvailable} />
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
          {tab === 'signin' && (
            <Card title="Sign-in" description="How you sign in to Paperless-AI: user name and password, single sign-on (OpenID Connect) or both.">
              <SignInSection {...props} linked={Boolean(account.data?.sso.linked)} />
            </Card>
          )}
          {tab === 'integrations' && <IntegrationsTab locked={locked} />}
          {tab === 'users' && <UsersTab />}
          {tab === 'audit' && <AuditLogCard />}
          {tab === 'keys' && <ApiKeysCard />}
          {tab === 'account' && <AccountTab />}
        </div>
      </div>

      {formTab && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-5 lg:pl-[252px]">
          <div
            // Hidden: invisible + no pointer events, so it does not block clicks on the page below.
            className={`flex w-full max-w-2xl items-center justify-between gap-3 rounded-full border border-border bg-surface/90 py-2 pr-2 pl-5 shadow-pop backdrop-blur-xl transition duration-300 ${dirty ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none invisible translate-y-4 opacity-0'}`}
            aria-hidden={!dirty}
          >
            <span className="flex items-center gap-2 text-sm text-muted">
              <span className="status-dot live bg-warn" /> You have unsaved changes
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(loaded.config)}>
                Discard
              </Button>
              <Button
                variant="primary"
                icon={<Save className="size-4" />}
                loading={saving}
                disabled={!dirty}
                onClick={() => save()}
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
