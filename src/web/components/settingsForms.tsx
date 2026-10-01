import { useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Bot, Cloud, Cpu, Plug, Plus, Server, Trash2, Wand2 } from 'lucide-react';
import type { AppConfig } from '../../server/config/schema';
import type { ConnectionTestResult } from '@shared/api';
import { errorMessage, post } from '../lib/api';
import { getIn, SECRET_MASK, type Setter } from '../lib/draft';
import { cn } from '../lib/format';
import { Alert, Badge, Button, Field, Input, NumberInput, Select, Switch, TagInput, Textarea } from './ui';

export type Config = AppConfig;
export type Locked = Record<string, string>;
/** Which endpoints to use for connection tests (wizard before login vs. settings). */
export type ApiBase = 'setup' | 'settings';

interface SectionProps {
  draft: Config;
  set: Setter;
  locked: Locked;
}

function useTest() {
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<ConnectionTestResult>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await fn());
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return { result, busy, run, clear: () => setResult(null) };
}

export function TestResult({ result }: { result: ConnectionTestResult | null }) {
  if (!result) return null;
  return (
    <Alert tone={result.ok ? 'accent' : 'danger'} className="mt-3">
      {result.message}
    </Alert>
  );
}

/**
 * Password-style input for secrets; an already stored secret is shown as a placeholder.
 * Emptying the field keeps the stored secret – only "Clear" removes it.
 */
export function SecretInput({ value, onChange, disabled, placeholder, id }: { value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; id?: string }) {
  const stored = value === SECRET_MASK;
  // Remembered while the user types over the stored secret; reset by "Clear", set again by discard/save.
  const [hasStored, setHasStored] = useState(stored);
  const [cleared, setCleared] = useState(false);
  if (stored && !hasStored) {
    setHasStored(true);
    setCleared(false);
  }
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        value={stored ? '' : value}
        placeholder={stored ? 'Stored – leave empty to keep the current value' : cleared ? 'Removed when you save' : placeholder}
        onChange={(e) => onChange(e.target.value === '' && hasStored ? SECRET_MASK : e.target.value)}
      />
      {hasStored && !disabled && (
        <Button
          variant="ghost"
          title="Remove the stored value"
          onClick={() => {
            setHasStored(false);
            setCleared(true);
            onChange('');
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}

function bind(draft: Config, set: Setter, locked: Locked, path: string) {
  return {
    value: (getIn(draft, path) as string | number | undefined) ?? '',
    onChange: (e: { target: { value: string } }) => set(path, e.target.value),
    disabled: Boolean(locked[path]),
  };
}

function bindNumber(draft: Config, set: Setter, locked: Locked, path: string) {
  return { value: Number(getIn(draft, path) ?? 0), onChange: (v: number) => set(path, v), disabled: Boolean(locked[path]) };
}

export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-5 sm:grid-cols-2', className)}>{children}</div>;
}

// ------------------------------------------------------------------ Paperless connection

export function ConnectionSection({ draft, set, locked, apiBase }: SectionProps & { apiBase: ApiBase }) {
  const test = useTest();
  return (
    <div className="space-y-5">
      <FormGrid>
        <Field label="Paperless-ngx URL" locked={locked['paperless.url']} hint="Address Paperless-AI uses to reach Paperless-ngx, e.g. http://paperless:8000 (without /api).">
          <Input placeholder="http://paperless-ngx:8000" {...bind(draft, set, locked, 'paperless.url')} />
        </Field>
        <Field label="API token" locked={locked['paperless.token']} hint="Paperless → profile menu → “My Profile” → API Auth Token.">
          <SecretInput value={draft.paperless.token} onChange={(v) => set('paperless.token', v)} disabled={Boolean(locked['paperless.token'])} placeholder="Token of the Paperless user" />
        </Field>
        <Field label="Public URL (optional)" locked={locked['paperless.publicUrl']} hint="Used for links that open in your browser, if it differs from the URL above.">
          <Input placeholder="https://paperless.example.com" {...bind(draft, set, locked, 'paperless.publicUrl')} />
        </Field>
      </FormGrid>
      <div>
        <Button
          icon={<Plug className="size-4" />}
          loading={test.busy}
          onClick={() => test.run(() => post<ConnectionTestResult>(`/api/${apiBase}/test-paperless`, { url: draft.paperless.url, token: draft.paperless.token }))}
        >
          Test connection
        </Button>
        <TestResult result={test.result} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ AI provider

const PROVIDERS: { id: Config['ai']['provider']; label: string; description: string; icon: ReactNode }[] = [
  { id: 'openai', label: 'OpenAI', description: 'GPT models via api.openai.com', icon: <Bot className="size-5" /> },
  { id: 'ollama', label: 'Ollama', description: 'Local models, fully private', icon: <Cpu className="size-5" /> },
  { id: 'custom', label: 'OpenAI-compatible', description: 'DeepSeek, OpenRouter, LiteLLM, vLLM, Gemini, LM Studio …', icon: <Server className="size-5" /> },
  { id: 'azure', label: 'Azure OpenAI', description: 'Deployments in Azure', icon: <Cloud className="size-5" /> },
];

const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'o4-mini'];

export function AiSection({ draft, set, locked, apiBase }: SectionProps & { apiBase: ApiBase }) {
  const test = useTest();
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const provider = draft.ai.provider;
  const modelPath = provider === 'openai' ? 'ai.openai.model' : provider === 'ollama' ? 'ai.ollama.model' : provider === 'custom' ? 'ai.custom.model' : 'ai.azure.deployment';

  const loadModels = async () => {
    setLoadingModels(true);
    setModelError(null);
    try {
      const res = await post<{ models: string[]; error?: string }>(`/api/${apiBase}/models`, { ai: draft.ai });
      setModels(res.models);
      if (res.error) setModelError(res.error);
      else if (!res.models.length) setModelError('The provider returned no models');
    } catch (err) {
      setModelError(errorMessage(err));
    } finally {
      setLoadingModels(false);
    }
  };

  const suggestions = models.length ? models : provider === 'openai' ? OPENAI_MODELS : [];
  const modelInput = (label: string, placeholder: string, hint?: ReactNode) => (
    <Field label={label} locked={locked[modelPath]} hint={modelError ? <span className="text-danger">{modelError}</span> : hint}>
      <div className="flex gap-2">
        <Input list="model-suggestions" placeholder={placeholder} {...bind(draft, set, locked, modelPath)} />
        {provider !== 'azure' && (
          <Button onClick={loadModels} loading={loadingModels} title="Load the models offered by the provider">
            Load
          </Button>
        )}
      </div>
      <datalist id="model-suggestions">
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </Field>
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4" role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={provider === p.id}
            disabled={Boolean(locked['ai.provider'])}
            onClick={() => {
              set('ai.provider', p.id);
              setModels([]);
              test.clear();
            }}
            className={cn(
              'flex items-start gap-3 rounded-xl border p-3.5 text-left transition disabled:cursor-not-allowed',
              provider === p.id ? 'border-accent bg-accent-soft/60 ring-4 ring-accent/15' : 'border-border bg-surface hover:border-border-strong',
            )}
          >
            <span className={cn('mt-0.5', provider === p.id ? 'text-accent' : 'text-faint')}>{p.icon}</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-fg">{p.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{p.description}</span>
            </span>
          </button>
        ))}
      </div>
      {locked['ai.provider'] && <Badge tone="warn">Provider set by {locked['ai.provider']}</Badge>}

      <FormGrid>
        {provider === 'openai' && (
          <>
            <Field label="API key" locked={locked['ai.openai.apiKey']}>
              <SecretInput value={draft.ai.openai.apiKey} onChange={(v) => set('ai.openai.apiKey', v)} disabled={Boolean(locked['ai.openai.apiKey'])} placeholder="sk-…" />
            </Field>
            {modelInput('Model', 'gpt-4o-mini', 'gpt-4o-mini and gpt-4.1-mini offer the best value for document analysis.')}
          </>
        )}
        {provider === 'ollama' && (
          <>
            <Field label="Ollama URL" locked={locked['ai.ollama.url']} hint="From Docker use e.g. http://host.docker.internal:11434">
              <Input placeholder="http://localhost:11434" {...bind(draft, set, locked, 'ai.ollama.url')} />
            </Field>
            {modelInput('Model', 'llama3.2', 'Models with JSON/structured output support work best, e.g. qwen3, llama3.x, mistral, gemma3.')}
            <Field label="Keep model loaded (optional)" locked={locked['ai.ollama.keepAlive']} hint='Ollama keep_alive, e.g. "5m", "1h" or "0" to unload right after each request.'>
              <Input placeholder="Ollama default" {...bind(draft, set, locked, 'ai.ollama.keepAlive')} />
            </Field>
          </>
        )}
        {provider === 'custom' && (
          <>
            <Field label="Base URL" locked={locked['ai.custom.baseUrl']} hint="OpenAI-compatible endpoint including the version, e.g. https://api.deepseek.com/v1 or https://openrouter.ai/api/v1">
              <Input placeholder="https://api.example.com/v1" {...bind(draft, set, locked, 'ai.custom.baseUrl')} />
            </Field>
            <Field label="API key" locked={locked['ai.custom.apiKey']} hint="Leave empty if the endpoint needs no key.">
              <SecretInput value={draft.ai.custom.apiKey} onChange={(v) => set('ai.custom.apiKey', v)} disabled={Boolean(locked['ai.custom.apiKey'])} />
            </Field>
            {modelInput('Model', 'deepseek-chat')}
          </>
        )}
        {provider === 'azure' && (
          <>
            <Field label="Endpoint" locked={locked['ai.azure.endpoint']}>
              <Input placeholder="https://my-resource.openai.azure.com" {...bind(draft, set, locked, 'ai.azure.endpoint')} />
            </Field>
            <Field label="API key" locked={locked['ai.azure.apiKey']}>
              <SecretInput value={draft.ai.azure.apiKey} onChange={(v) => set('ai.azure.apiKey', v)} disabled={Boolean(locked['ai.azure.apiKey'])} />
            </Field>
            {modelInput('Deployment name', 'gpt-4o-mini')}
            <Field label="API version" locked={locked['ai.azure.apiVersion']}>
              <Input placeholder="2024-10-21" {...bind(draft, set, locked, 'ai.azure.apiVersion')} />
            </Field>
          </>
        )}
      </FormGrid>

      <details className="group rounded-xl border border-border bg-surface-2/50 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium text-fg select-none">Advanced model settings</summary>
        <FormGrid className="mt-4 lg:grid-cols-4">
          <Field label="Context window (tokens)" locked={locked['ai.tokenLimit']} hint="Long documents are truncated to fit.">
            <NumberInput min={1024} {...bindNumber(draft, set, locked, 'ai.tokenLimit')} />
          </Field>
          <Field label="Answer tokens" locked={locked['ai.responseTokens']} hint="Reserved for the model's answer.">
            <NumberInput min={100} {...bindNumber(draft, set, locked, 'ai.responseTokens')} />
          </Field>
          <Field label="Temperature" locked={locked['ai.temperature']} hint="Low values = consistent results.">
            <NumberInput min={0} max={2} step={0.1} {...bindNumber(draft, set, locked, 'ai.temperature')} />
          </Field>
          <Field label="Timeout (seconds)" locked={locked['ai.timeoutSeconds']}>
            <NumberInput min={10} {...bindNumber(draft, set, locked, 'ai.timeoutSeconds')} />
          </Field>
        </FormGrid>
      </details>

      <div>
        <Button icon={<Plug className="size-4" />} loading={test.busy} onClick={() => test.run(() => post<ConnectionTestResult>(`/api/${apiBase}/test-ai`, { ai: draft.ai }))}>
          Test AI connection
        </Button>
        <TestResult result={test.result} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ processing

const SCAN_PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily at 02:00', value: '0 2 * * *' },
];

export function ProcessingSection({ draft, set, locked, tagSuggestions = [] }: SectionProps & { tagSuggestions?: string[] }) {
  const p = draft.processing;
  return (
    <div className="space-y-6">
      <Switch
        label="Process new documents automatically"
        description="Scan Paperless on a schedule and analyze documents that have not been processed yet. You can also trigger processing from Paperless workflows via the webhook."
        checked={p.automatic}
        locked={locked['processing.automatic']}
        onChange={(v) => set('processing.automatic', v)}
      />
      <FormGrid>
        <Field label="Scan interval (cron)" locked={locked['processing.scanInterval']} hint="Five-field cron expression, e.g. */30 * * * * = every 30 minutes.">
          <div className="flex gap-2">
            <Input className="font-mono" {...bind(draft, set, locked, 'processing.scanInterval')} />
            <Select
              className="w-44 shrink-0"
              value=""
              disabled={Boolean(locked['processing.scanInterval'])}
              onChange={(e) => e.target.value && set('processing.scanInterval', e.target.value)}
              aria-label="Presets"
            >
              <option value="">Presets…</option>
              {SCAN_PRESETS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="Parallel analyses" locked={locked['processing.concurrency']} hint="Use 1 for local models; cloud APIs can handle 2–4.">
          <NumberInput min={1} max={8} {...bindNumber(draft, set, locked, 'processing.concurrency')} />
        </Field>
      </FormGrid>

      <div className="space-y-4 rounded-xl border border-border p-4">
        <Switch
          label="Only process documents with specific tags"
          description="Recommended: tag documents in Paperless (e.g. with a workflow) to decide which ones the AI should analyze."
          checked={p.onlyTagged}
          locked={locked['processing.onlyTagged']}
          onChange={(v) => set('processing.onlyTagged', v)}
        />
        {p.onlyTagged && (
          <div className="space-y-4 pl-0 sm:pl-1">
            <Field label="Trigger tags" locked={locked['processing.tags']} hint="Documents with at least one of these tags are processed.">
              <TagInput value={p.tags} onChange={(v) => set('processing.tags', v)} suggestions={tagSuggestions} placeholder="e.g. pre-process" disabled={Boolean(locked['processing.tags'])} />
            </Field>
            <Switch
              label="Remove trigger tags after processing"
              description="Re-adding a trigger tag later processes the document again."
              checked={p.removeTriggerTags}
              locked={locked['processing.removeTriggerTags']}
              onChange={(v) => set('processing.removeTriggerTags', v)}
            />
          </div>
        )}
        {!p.onlyTagged && <Alert tone="warn">All documents of your archive will be analyzed. With large archives and paid APIs this can be expensive.</Alert>}
      </div>

      <div className="space-y-4 rounded-xl border border-border p-4">
        <Switch
          label="Mark processed documents with a tag"
          checked={p.addProcessedTag}
          locked={locked['processing.addProcessedTag']}
          onChange={(v) => set('processing.addProcessedTag', v)}
        />
        {p.addProcessedTag && (
          <Field label="Tag name" locked={locked['processing.processedTagName']}>
            <Input className="max-w-sm" {...bind(draft, set, locked, 'processing.processedTagName')} />
          </Field>
        )}
      </div>

      <FormGrid>
        <Field label="Retries for failed documents" locked={locked['processing.maxAttempts']} hint="Failed documents are retried on later scans up to this many times.">
          <NumberInput min={1} max={20} {...bindNumber(draft, set, locked, 'processing.maxAttempts')} />
        </Field>
      </FormGrid>
    </div>
  );
}

// ------------------------------------------------------------------ functions & restrictions

const FUNCTIONS: { key: keyof Config['processing']['functions']; label: string; description: string }[] = [
  { key: 'title', label: 'Title', description: 'Generate a meaningful title' },
  { key: 'tags', label: 'Tags', description: 'Assign thematic tags (existing tags are kept)' },
  { key: 'correspondent', label: 'Correspondent', description: 'Detect the sender (only set when empty)' },
  { key: 'documentType', label: 'Document type', description: 'Classify the document' },
  { key: 'documentDate', label: 'Document date', description: 'Extract the date of the document' },
  { key: 'customFields', label: 'Custom fields', description: 'Fill the custom fields configured below' },
];

export function FunctionsSection({ draft, set, locked }: SectionProps) {
  const p = draft.processing;
  return (
    <div className="space-y-6">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {FUNCTIONS.map((f) => (
          <Switch
            key={f.key}
            label={f.label}
            description={f.description}
            checked={p.functions[f.key]}
            locked={locked[`processing.functions.${f.key}`]}
            onChange={(v) => set(`processing.functions.${f.key}`, v)}
          />
        ))}
      </div>
      <div className="border-t border-border pt-5">
        <h3 className="mb-1 text-sm font-semibold text-fg">Restrict the AI to existing values</h3>
        <p className="mb-4 text-xs text-muted">The AI only uses values that already exist in Paperless instead of creating new ones.</p>
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <Switch label="Tags" checked={p.restrict.tags} locked={locked['processing.restrict.tags']} onChange={(v) => set('processing.restrict.tags', v)} />
          <Switch label="Correspondents" checked={p.restrict.correspondents} locked={locked['processing.restrict.correspondents']} onChange={(v) => set('processing.restrict.correspondents', v)} />
          <Switch label="Document types" checked={p.restrict.documentTypes} locked={locked['processing.restrict.documentTypes']} onChange={(v) => set('processing.restrict.documentTypes', v)} />
        </div>
      </div>
      <div className="border-t border-border pt-5">
        <Switch
          label="Send existing tags, correspondents and document types to the AI"
          description="Helps the AI to reuse existing values. Increases the prompt size for large archives."
          checked={p.useExistingData}
          locked={locked['processing.useExistingData']}
          onChange={(v) => set('processing.useExistingData', v)}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ prompt

export function PromptSection({ draft, set, locked, defaultPrompt, tagSuggestions = [] }: SectionProps & { defaultPrompt: string; tagSuggestions?: string[] }) {
  const p = draft.processing;
  return (
    <div className="space-y-6">
      <Field
        label="System prompt"
        locked={locked['processing.systemPrompt']}
        hint={
          <>
            Describe how documents should be analyzed. The required JSON output format is appended automatically. Placeholders:{' '}
            <code className="kbd">%RESTRICTED_TAGS%</code> <code className="kbd">%RESTRICTED_CORRESPONDENTS%</code> <code className="kbd">%RESTRICTED_DOCUMENT_TYPES%</code>{' '}
            <code className="kbd">%CUSTOMFIELDS%</code>
          </>
        }
      >
        <Textarea
          rows={16}
          className={cn('font-mono text-[0.8rem]', p.usePromptTags && 'opacity-50')}
          value={p.systemPrompt}
          disabled={Boolean(locked['processing.systemPrompt']) || p.usePromptTags}
          onChange={(e) => set('processing.systemPrompt', e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Wand2 className="size-3.5" />} disabled={p.usePromptTags} onClick={() => set('processing.systemPrompt', defaultPrompt)}>
          Use default prompt
        </Button>
      </div>
      <div className="space-y-4 rounded-xl border border-border p-4">
        <Switch
          label="Only use a fixed list of tags"
          description="Replaces the system prompt with a prompt that only assigns tags from this list."
          checked={p.usePromptTags}
          locked={locked['processing.usePromptTags']}
          onChange={(v) => set('processing.usePromptTags', v)}
        />
        {p.usePromptTags && (
          <Field label="Allowed tags" locked={locked['processing.promptTags']}>
            <TagInput value={p.promptTags} onChange={(v) => set('processing.promptTags', v)} suggestions={tagSuggestions} disabled={Boolean(locked['processing.promptTags'])} />
          </Field>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ custom fields

const FIELD_TYPES: { value: Config['processing']['customFields'][number]['type']; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'integer', label: 'Integer' },
  { value: 'float', label: 'Number' },
  { value: 'monetary', label: 'Monetary' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / No' },
  { value: 'url', label: 'URL' },
];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'AUD', 'CAD', 'CNY', 'INR', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK'];

export function CustomFieldsSection({ draft, set, locked }: SectionProps) {
  const fields = draft.processing.customFields;
  const disabled = Boolean(locked['processing.customFields']);
  const update = (next: typeof fields) => set('processing.customFields', next);
  const move = (i: number, d: number) => {
    const next = [...fields];
    const [item] = next.splice(i, 1);
    next.splice(i + d, 0, item);
    update(next);
  };
  return (
    <div className="space-y-4">
      {locked['processing.customFields'] && <Badge tone="warn">Set by {locked['processing.customFields']}</Badge>}
      {!fields.length && <p className="text-sm text-muted">No custom fields configured. Add fields the AI should fill (e.g. invoice amount, invoice number, due date).</p>}
      <div className="space-y-3">
        {fields.map((f, i) => (
          <div key={i} className="grid items-end gap-3 rounded-xl border border-border p-3 sm:grid-cols-[1.2fr_0.8fr_0.6fr_2fr_auto]">
            <Field label="Name">
              <Input value={f.name} disabled={disabled} onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Invoice amount" />
            </Field>
            <Field label="Type">
              <Select value={f.type} disabled={disabled} onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as typeof f.type } : x)))}>
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Currency">
              <Select
                value={f.currency ?? ''}
                disabled={disabled || f.type !== 'monetary'}
                onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, currency: e.target.value || undefined } : x)))}
              >
                <option value="">–</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Hint for the AI (optional)">
              <Input value={f.description} disabled={disabled} onChange={(e) => update(fields.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} placeholder="Total amount incl. VAT" />
            </Field>
            <div className="flex gap-1 pb-0.5">
              <Button size="sm" variant="ghost" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                <ArrowUp className="size-3.5" />
              </Button>
              <Button size="sm" variant="ghost" disabled={disabled || i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                <ArrowDown className="size-3.5" />
              </Button>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => update(fields.filter((_, j) => j !== i))} aria-label="Remove">
                <Trash2 className="size-3.5 text-danger" />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button icon={<Plus className="size-4" />} disabled={disabled} onClick={() => update([...fields, { name: '', type: 'string', description: '' }])}>
        Add custom field
      </Button>
      <p className="text-xs text-muted">Fields that do not exist in Paperless yet are created when you save.</p>
    </div>
  );
}

// ------------------------------------------------------------------ external API

export function ExternalApiSection({ draft, set, locked }: SectionProps) {
  const e = draft.externalApi;
  const test = useTest();
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <Switch
        label="Add data from an external API to the prompt"
        description="E.g. a list of your customers or projects, so the AI can match documents against it."
        checked={e.enabled}
        locked={locked['externalApi.enabled']}
        onChange={(v) => set('externalApi.enabled', v)}
      />
      {e.enabled && (
        <>
          <FormGrid className="sm:grid-cols-[1fr_8rem_9rem]">
            <Field label="URL" locked={locked['externalApi.url']}>
              <Input placeholder="https://api.example.com/customers" {...bind(draft, set, locked, 'externalApi.url')} />
            </Field>
            <Field label="Method" locked={locked['externalApi.method']}>
              <Select {...bind(draft, set, locked, 'externalApi.method')}>
                <option>GET</option>
                <option>POST</option>
                <option>PUT</option>
              </Select>
            </Field>
            <Field label="Timeout (ms)" locked={locked['externalApi.timeoutMs']}>
              <NumberInput min={100} {...bindNumber(draft, set, locked, 'externalApi.timeoutMs')} />
            </Field>
          </FormGrid>
          <FormGrid>
            <Field label="Headers (JSON)" locked={locked['externalApi.headers']}>
              <Textarea rows={4} className="font-mono text-xs" {...bind(draft, set, locked, 'externalApi.headers')} placeholder='{"Authorization": "Bearer …"}' />
            </Field>
            <Field label="Body (JSON, POST/PUT only)" locked={locked['externalApi.body']}>
              <Textarea rows={4} className="font-mono text-xs" {...bind(draft, set, locked, 'externalApi.body')} />
            </Field>
          </FormGrid>
          <Field
            label="Transformation (optional)"
            locked={locked['externalApi.transform']}
            hint="JavaScript receiving the response as `data`, e.g. `return data.items.map(i => i.name)`. Runs sandboxed with a 1 s time limit."
          >
            <Textarea rows={4} className="font-mono text-xs" {...bind(draft, set, locked, 'externalApi.transform')} placeholder="return data;" />
          </Field>
          <div>
            <Button
              icon={<Plug className="size-4" />}
              loading={test.busy}
              onClick={() =>
                test.run(async () => {
                  const res = await post<ConnectionTestResult>('/api/settings/test-external-api', { externalApi: e });
                  setPreview((res.details?.preview as string) ?? null);
                  return res;
                })
              }
            >
              Test request
            </Button>
            <TestResult result={test.result} />
            {preview && test.result?.ok && <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs">{preview}</pre>}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ RAG

export function RagSection({ draft, set, locked, localEmbeddings }: SectionProps & { localEmbeddings: boolean }) {
  const r = draft.rag;
  const hints: Record<Config['rag']['embeddingProvider'], string> = {
    local: 'Built-in multilingual model (runs on the CPU, no external service). Default: Xenova/multilingual-e5-small',
    ollama: 'Uses the Ollama URL from the AI settings. Default: nomic-embed-text (run "ollama pull nomic-embed-text")',
    openai: 'Uses the OpenAI API key. Default: text-embedding-3-small',
    custom: 'Uses the base URL / key of the OpenAI-compatible provider. Default: text-embedding-3-small',
    azure: 'Uses the Azure endpoint and key; enter the name of your embedding deployment as model.',
    none: 'Keyword search only (BM25). Smallest footprint, no semantic search.',
  };
  return (
    <div className="space-y-6">
      <Switch
        label="Enable “Ask your archive”"
        description="Builds a search index of all documents (stored locally) to answer questions about your archive."
        checked={r.enabled}
        locked={locked['rag.enabled']}
        onChange={(v) => set('rag.enabled', v)}
      />
      {r.enabled && (
        <>
          <FormGrid>
            <Field label="Embeddings (semantic search)" locked={locked['rag.embeddingProvider']} hint={hints[r.embeddingProvider]}>
              <Select {...bind(draft, set, locked, 'rag.embeddingProvider')}>
                <option value="local" disabled={!localEmbeddings}>
                  Local model{!localEmbeddings ? ' (not installed)' : ''}
                </option>
                <option value="ollama">Ollama</option>
                <option value="openai">OpenAI</option>
                <option value="custom">OpenAI-compatible provider</option>
                <option value="azure">Azure OpenAI</option>
                <option value="none">None (keyword search only)</option>
              </Select>
            </Field>
            {r.embeddingProvider !== 'none' && (
              <Field label="Embedding model" locked={locked['rag.embeddingModel']} hint="Leave empty for the default. Changing the model re-embeds all documents.">
                <Input placeholder="Default" {...bind(draft, set, locked, 'rag.embeddingModel')} />
              </Field>
            )}
          </FormGrid>
          <FormGrid className="lg:grid-cols-3">
            <Field label="Documents per answer" locked={locked['rag.topK']} hint="How many documents are given to the AI.">
              <NumberInput min={2} max={40} {...bindNumber(draft, set, locked, 'rag.topK')} />
            </Field>
            <Field label="Context budget (tokens)" locked={locked['rag.contextTokens']} hint="Maximum size of the document excerpts.">
              <NumberInput min={1000} {...bindNumber(draft, set, locked, 'rag.contextTokens')} />
            </Field>
            <div className="flex items-end pb-2">
              <Switch label="Keep index up to date automatically" checked={r.autoSync} locked={locked['rag.autoSync']} onChange={(v) => set('rag.autoSync', v)} />
            </div>
          </FormGrid>
          <Switch
            label="Smart search terms"
            description="One short additional AI request per question extracts keywords, synonyms and translations (e.g. “rental agreement” → “Mietvertrag”). Noticeably better results; turn off for very slow local models."
            checked={r.queryExpansion}
            locked={locked['rag.queryExpansion']}
            onChange={(v) => set('rag.queryExpansion', v)}
          />
        </>
      )}
    </div>
  );
}
