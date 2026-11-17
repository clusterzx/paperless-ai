import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  Building2,
  Check,
  Copy,
  FlaskConical,
  Heading,
  Home,
  Languages,
  ListChecks,
  NotebookPen,
  Play,
  Save,
  Search,
  Tags,
  Wand2,
} from 'lucide-react';
import type { AnalysisResult, DocumentSummary, PromptLibrary } from '@shared/api';
import { buildWizardPrompt, TAG_AVOID_LABELS, TITLE_PLACEHOLDERS, WIZARD_LANGUAGES, type PromptWizardAnswers } from '@shared/promptWizard';
import type { Config } from '../components/settingsForms';
import { Page } from '../components/Layout';
import { SavePromptModal } from '../components/promptLibrary';
import { Alert, Badge, Button, Card, Field, Input, NumberInput, PageHeader, Select, Skeleton, Switch, TagInput, Textarea, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post, put, qs } from '../lib/api';
import { useAsync, useDebounced, useUnsavedChanges } from '../lib/hooks';
import { cn } from '../lib/format';
import { useMetadata } from '../lib/metadata';

type Processing = Config['processing'];
/** The part of the processing settings the wizard decides. */
type WizardState = {
  answers: PromptWizardAnswers;
  useExistingData: boolean;
  restrict: Processing['restrict'];
  functions: Processing['functions'];
};

interface SettingsResponse {
  config: Config;
  locked: Record<string, string>;
  defaults: { systemPrompt: string };
}

const STEPS = [
  { id: 'archive', title: 'Your archive', icon: <Home className="size-4" /> },
  { id: 'language', title: 'Language', icon: <Languages className="size-4" /> },
  { id: 'title', title: 'Titles', icon: <Heading className="size-4" /> },
  { id: 'tags', title: 'Tags', icon: <Tags className="size-4" /> },
  { id: 'names', title: 'Correspondents & types', icon: <Building2 className="size-4" /> },
  { id: 'changes', title: 'What may change', icon: <ListChecks className="size-4" /> },
  { id: 'extra', title: 'Own rules', icon: <NotebookPen className="size-4" /> },
  { id: 'test', title: 'Test & save', icon: <FlaskConical className="size-4" /> },
] as const;

const CONTEXT_EXAMPLES = ['Private household in Germany', 'Family with children, house owner', 'Freelancer (IT consulting)', 'Small business with employees'];
const EXTRA_EXAMPLES = [
  'Bank statements: title “Account statement <bank> <month year>”.',
  'Payslips get the document type “Payslip” and the tag “Salary”.',
  'Medical documents always get the tag “Health”.',
  'Documents about the car always get the tag “Car” plus the licence plate if mentioned.',
];
const TYPE_SUGGESTIONS = ['Invoice', 'Receipt', 'Contract', 'Letter', 'Statement', 'Notice', 'Payslip', 'Insurance policy', 'Tax assessment', 'Certificate', 'Offer', 'Reminder'];

/** Example title per style, so the choice is concrete. */
function exampleTitle(a: PromptWizardAnswers): string {
  if (a.titleStyle === 'short') return 'Electricity bill';
  if (a.titleStyle === 'pattern') {
    return a.titlePattern
      .replace('{correspondent}', 'Stadtwerke')
      .replace('{type}', 'Invoice')
      .replace('{subject}', 'Electricity')
      .replace('{date}', 'October 2026')
      .replace('{reference}', 'No. 4711')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return `Electricity bill${a.titleDate ? ' October 2026' : ''}${a.titleReference ? ' – invoice 4711' : ''}`;
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; title: string; text: ReactNode }[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-xl border p-3 text-left transition',
            value === o.value ? 'border-accent bg-accent-soft/50 ring-1 ring-accent' : 'border-border hover:border-border-strong hover:bg-surface-2',
          )}
        >
          <div className="flex items-center justify-between text-sm font-medium">
            {o.title}
            {value === o.value && <Check className="size-4 text-accent" />}
          </div>
          <div className="mt-1 text-xs text-muted">{o.text}</div>
        </button>
      ))}
    </div>
  );
}

function TestPanel({ state, prompt }: { state: WizardState; prompt: string }) {
  const meta = useMetadata();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 400);
  const docs = useAsync((signal) => get<DocumentSummary[]>(`/api/playground/documents${qs({ limit: 8, query: q || undefined })}`, signal), [q]);
  const [picked, setPicked] = useState<number[]>([]);
  const [results, setResults] = useState<Record<number, { result?: AnalysisResult; error?: string; running?: boolean }>>({});
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!picked.length && docs.data?.length) setPicked(docs.data.slice(0, 2).map((d) => d.id));
  }, [docs.data, picked.length]);

  const run = async () => {
    setRunning(true);
    const processing = { ...state, promptWizard: { ...state.answers, used: true }, usePromptTags: false };
    for (const id of picked) {
      setResults((r) => ({ ...r, [id]: { running: true } }));
      try {
        const result = await post<AnalysisResult>(`/api/documents/${id}/analyze`, { prompt, processing });
        setResults((r) => ({ ...r, [id]: { result } }));
      } catch (err) {
        setResults((r) => ({ ...r, [id]: { error: errorMessage(err) } }));
      }
    }
    setRunning(false);
    toast.success('Test finished – nothing was changed in Paperless');
  };

  const byId = new Map((docs.data ?? []).map((d) => [d.id, d]));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Try the new prompt on a few documents. Nothing is saved or changed in Paperless.</p>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input className="pl-9" placeholder="Search documents…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        {docs.loading && !docs.data && <Skeleton className="h-8 w-full" />}
        {docs.data?.map((d) => {
          const on = picked.includes(d.id);
          return (
            <button
              key={d.id}
              type="button"
              aria-pressed={on}
              onClick={() => setPicked((p) => (on ? p.filter((x) => x !== d.id) : [...p, d.id].slice(-3)))}
              className={cn('max-w-[16rem] truncate rounded-full border px-3 py-1 text-xs transition', on ? 'border-accent bg-accent-soft/60 text-fg' : 'border-border text-muted hover:text-fg')}
            >
              #{d.id} {d.title}
            </button>
          );
        })}
      </div>
      <Button variant="primary" icon={<Play className="size-4" />} loading={running} disabled={!picked.length} onClick={run}>
        Test on {picked.length} document{picked.length === 1 ? '' : 's'}
      </Button>
      <div className="space-y-3">
        {picked
          .filter((id) => results[id])
          .map((id) => {
            const r = results[id];
            const d = byId.get(id);
            const s = r.result?.suggestion;
            return (
              <div key={id} className="rounded-xl border border-border p-3 text-sm">
                <div className="text-xs text-faint">
                  #{id} · now: {d?.title ?? '…'}
                  {d?.correspondent ? ` · ${meta.correspondentName(d.correspondent)}` : ''}
                </div>
                {r.running && <Skeleton className="mt-2 h-10" />}
                {r.error && <Alert tone="danger" className="mt-2">{r.error}</Alert>}
                {s && (
                  <div className="mt-1.5 space-y-1">
                    <div className="font-medium">{s.title ?? '–'}</div>
                    <div className="flex flex-wrap gap-1">
                      {s.correspondent && <Badge tone="accent">{s.correspondent}</Badge>}
                      {s.document_type && <Badge tone="info">{s.document_type}</Badge>}
                      {s.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                      {s.document_date && <Badge>{s.document_date}</Badge>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

export default function PromptWizardPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const library = useAsync((signal) => get<PromptLibrary>('/api/prompts', signal), []);
  const [keeping, setKeeping] = useState(false);
  const meta = useMetadata();
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<WizardState | null>(null);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    get<SettingsResponse>('/api/settings')
      .then((r) => {
        setLoaded(r);
        const p = r.config.processing;
        setState({ answers: p.promptWizard, useExistingData: p.useExistingData, restrict: p.restrict, functions: p.functions });
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, []);

  const prompt = useMemo(() => (state ? buildWizardPrompt(state.answers) : ''), [state]);
  const initial = useMemo(() => {
    if (!loaded) return null;
    const p = loaded.config.processing;
    return JSON.stringify({ answers: p.promptWizard, useExistingData: p.useExistingData, restrict: p.restrict, functions: p.functions });
  }, [loaded]);
  const dirty = Boolean(state && initial && !saved && JSON.stringify(state) !== initial);
  useUnsavedChanges(dirty);

  if (loadError) {
    return (
      <Page>
        <Alert tone="danger">{loadError}</Alert>
      </Page>
    );
  }
  if (!loaded || !state) {
    return (
      <Page>
        <Skeleton className="h-96 rounded-xl" />
      </Page>
    );
  }

  const p = loaded.config.processing;
  const locked = loaded.locked;
  const a = state.answers;
  const setA = <K extends keyof PromptWizardAnswers>(key: K, value: PromptWizardAnswers[K]) => setState((s) => s && { ...s, answers: { ...s.answers, [key]: value } });
  // The prompt in the settings was written or edited by hand – saving replaces it.
  const savedPrompt = p.systemPrompt.trim();
  const manualPrompt = savedPrompt !== '' && savedPrompt !== buildWizardPrompt(p.promptWizard).trim() && savedPrompt !== loaded.defaults.systemPrompt.trim();
  const promptLocked = locked['processing.systemPrompt'];

  const save = async () => {
    if (manualPrompt) {
      const ok = await confirm({
        title: 'Replace your current prompt?',
        message: p.promptWizard.used
          ? 'The prompt was edited by hand after the wizard created it. Saving replaces it with the prompt of the wizard.'
          : 'Saving replaces your current system prompt with the prompt of the wizard. You can copy the old one from Settings → Prompt first.',
        confirmLabel: 'Replace prompt',
        danger: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await put('/api/settings', {
        config: {
          processing: {
            systemPrompt: prompt,
            usePromptTags: false,
            promptWizard: { ...a, used: true },
            useExistingData: state.useExistingData,
            restrict: state.restrict,
            functions: state.functions,
          },
        },
      });
      setSaved(true);
      toast.success('Prompt saved – new documents are analyzed with it');
      navigate('/settings?tab=prompt');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const current = STEPS[step];
  const tagNames = meta.tags.map((t) => t.name);
  const typeSuggestions = [...new Set([...meta.documentTypes.map((t) => t.name), ...TYPE_SUGGESTIONS])];

  const body: Record<(typeof STEPS)[number]['id'], ReactNode> = {
    archive: (
      <div className="space-y-6">
        <Field label="What is in your archive?" hint="A short description helps the AI choose fitting titles and tags.">
          <Textarea rows={3} placeholder="e.g. Private household in Germany – bills, insurance, taxes, car and health" value={a.context} onChange={(e) => setA('context', e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          {CONTEXT_EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-fg" onClick={() => setA('context', ex)}>
              {ex}
            </button>
          ))}
        </div>
        <Field
          label="Who owns the archive?"
          hint="Your own name(s) and company. Documents are addressed to you – the AI will never use these names as correspondent. This avoids the most common mistake."
        >
          <TagInput value={a.owners} onChange={(v) => setA('owners', v)} placeholder="e.g. Max Mustermann, Mustermann GmbH" />
        </Field>
      </div>
    ),
    language: (
      <div className="space-y-6">
        <Choice
          value={a.language}
          onChange={(v) => setA('language', v)}
          options={[
            { value: 'document', title: 'Like the document', text: 'German letters get German titles and tags, English ones English.' },
            { value: 'fixed', title: 'Always one language', text: 'Everything in one language – recommended for mixed-language archives, keeps tags consistent.' },
          ]}
        />
        {a.language === 'fixed' && (
          <Field label="Language" hint="Title, tags and document type are written in this language.">
            <Select value={WIZARD_LANGUAGES.includes(a.fixedLanguage) ? a.fixedLanguage : '__other'} onChange={(e) => setA('fixedLanguage', e.target.value === '__other' ? '' : e.target.value)}>
              {WIZARD_LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
              <option value="__other">Other…</option>
            </Select>
            {!WIZARD_LANGUAGES.includes(a.fixedLanguage) && (
              <Input className="mt-2" placeholder="Language" value={a.fixedLanguage} onChange={(e) => setA('fixedLanguage', e.target.value)} aria-label="Other language" />
            )}
          </Field>
        )}
      </div>
    ),
    title: (
      <div className="space-y-6">
        <Choice
          value={a.titleStyle}
          onChange={(v) => setA('titleStyle', v)}
          options={[
            { value: 'descriptive', title: 'Descriptive', text: 'Says what the document is about.' },
            { value: 'short', title: 'Short', text: '2–5 words.' },
            { value: 'pattern', title: 'Fixed pattern', text: 'Always the same structure.' },
          ]}
        />
        {a.titleStyle === 'pattern' && (
          <Field label="Pattern" hint={`Placeholders: ${Object.entries(TITLE_PLACEHOLDERS).map(([k, v]) => `${k} (${v})`).join(', ')}`}>
            <Input value={a.titlePattern} onChange={(e) => setA('titlePattern', e.target.value)} />
          </Field>
        )}
        {a.titleStyle !== 'pattern' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Switch label="Include reference numbers" description="Invoice, policy, contract or customer numbers." checked={a.titleReference} onChange={(v) => setA('titleReference', v)} />
            <Switch label="Include month and year" description="Usually not needed – the date is stored separately." checked={a.titleDate} onChange={(v) => setA('titleDate', v)} />
          </div>
        )}
        <Field label="Maximum length (characters)">
          <NumberInput min={20} max={128} value={a.titleMaxLength} onChange={(v) => setA('titleMaxLength', v)} />
        </Field>
        <div className="rounded-xl border border-dashed border-border p-3 text-sm">
          <span className="text-faint">Example: </span>
          <span className="font-medium">{exampleTitle(a)}</span>
        </div>
      </div>
    ),
    tags: (
      <div className="space-y-6">
        <Choice
          value={a.tagStyle}
          onChange={(v) => setA('tagStyle', v)}
          options={[
            { value: 'broad', title: 'Broad categories', text: 'Few tags like folders: Insurance, Taxes, Car.' },
            { value: 'balanced', title: 'Balanced', text: 'A category plus a specific topic.' },
            { value: 'specific', title: 'Specific', text: 'Precise topics, more different tags.' },
          ]}
        />
        <Field label="Maximum number of tags per document">
          <NumberInput min={1} max={10} value={a.maxTags} onChange={(v) => setA('maxTags', v)} />
        </Field>
        <fieldset>
          <legend className="label">Never use as tag</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(TAG_AVOID_LABELS) as PromptWizardAnswers['tagAvoid']).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-[var(--accent)]"
                  checked={a.tagAvoid.includes(k)}
                  onChange={(e) => setA('tagAvoid', e.target.checked ? [...a.tagAvoid, k] : a.tagAvoid.filter((x) => x !== k))}
                />
                {TAG_AVOID_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-4 rounded-xl border border-border p-4">
          <Switch
            label="Only use existing tags"
            description={`The AI picks from the ${tagNames.length} tags in Paperless and never creates new ones.`}
            checked={state.restrict.tags}
            locked={locked['processing.restrict.tags']}
            onChange={(v) => setState({ ...state, restrict: { ...state.restrict, tags: v } })}
          />
        </div>
      </div>
    ),
    names: (
      <div className="space-y-6">
        <div className="space-y-4">
          <Switch label="Short company names" description="“Amazon” instead of “Amazon EU S.à r.l., German branch”." checked={a.correspondentShort} onChange={(v) => setA('correspondentShort', v)} />
          <Switch label="Private persons as correspondent" description="Turn off if only companies and authorities should become correspondents." checked={a.correspondentPersons} onChange={(v) => setA('correspondentPersons', v)} />
        </div>
        <Field label="Document types to use" hint="The AI prefers these types. Existing types from Paperless are suggested.">
          <TagInput value={a.documentTypes} onChange={(v) => setA('documentTypes', v)} suggestions={typeSuggestions} placeholder="e.g. Invoice, Contract, Letter" />
        </Field>
        <div className="space-y-4 rounded-xl border border-border p-4">
          <Switch
            label="Show the AI the existing names"
            description="Tags, correspondents and document types from Paperless are listed in the prompt so the AI reuses them (recommended)."
            checked={state.useExistingData}
            locked={locked['processing.useExistingData']}
            onChange={(v) => setState({ ...state, useExistingData: v })}
          />
          <Switch
            label="Only existing correspondents"
            checked={state.restrict.correspondents}
            locked={locked['processing.restrict.correspondents']}
            onChange={(v) => setState({ ...state, restrict: { ...state.restrict, correspondents: v } })}
          />
          <Switch
            label="Only existing document types"
            checked={state.restrict.documentTypes}
            locked={locked['processing.restrict.documentTypes']}
            onChange={(v) => setState({ ...state, restrict: { ...state.restrict, documentTypes: v } })}
          />
        </div>
      </div>
    ),
    changes: (
      <div className="space-y-4">
        <p className="text-sm text-muted">The AI only fills in what is switched on – everything else in Paperless stays untouched.</p>
        {(
          [
            ['title', 'Title'],
            ['tags', 'Tags'],
            ['correspondent', 'Correspondent'],
            ['documentType', 'Document type'],
            ['documentDate', 'Document date'],
            ['customFields', 'Custom fields (configured in Settings → Custom fields)'],
          ] as const
        ).map(([key, label]) => (
          <Switch
            key={key}
            label={label}
            checked={state.functions[key]}
            locked={locked[`processing.functions.${key}`]}
            onChange={(v) => setState({ ...state, functions: { ...state.functions, [key]: v } })}
          />
        ))}
      </div>
    ),
    extra: (
      <div className="space-y-4">
        <Field label="Additional rules" hint="One rule per line, in your own words. They are added to the prompt as they are.">
          <Textarea rows={7} value={a.extra} onChange={(e) => setA('extra', e.target.value)} placeholder="e.g. Payslips get the document type “Payslip”." />
        </Field>
        <div className="flex flex-wrap gap-2">
          {EXTRA_EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="rounded-full border border-border px-3 py-1 text-left text-xs text-muted hover:text-fg"
              onClick={() => setA('extra', a.extra.trim() ? `${a.extra.trim()}\n${ex}` : ex)}
            >
              + {ex}
            </button>
          ))}
        </div>
      </div>
    ),
    test: <TestPanel state={state} prompt={prompt} />,
  };

  return (
    <Page wide>
      <PageHeader
        eyebrow="Settings → Prompt"
        title="Prompt wizard"
        description="Answer a few questions – the wizard writes the prompt that tells the AI how to name, tag and file your documents."
      />
      {promptLocked && (
        <Alert tone="warn" className="mb-4">
          The prompt is set by the environment variable {promptLocked} and cannot be replaced here.
        </Alert>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="min-w-0 space-y-4">
          <ol className="flex flex-wrap gap-1.5" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  aria-current={i === step ? 'step' : undefined}
                  onClick={() => setStep(i)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                    i === step ? 'border-accent bg-accent text-white' : i < step ? 'border-accent/40 text-accent-text' : 'border-border text-muted hover:text-fg',
                  )}
                >
                  {i < step ? <Check className="size-3.5" /> : s.icon}
                  {s.title}
                </button>
              </li>
            ))}
          </ol>
          <Card title={`${step + 1}. ${current.title}`}>{body[current.id]}</Card>
          <div className="flex items-center justify-between">
            <Button variant="ghost" icon={<ArrowLeft className="size-4" />} disabled={step === 0} onClick={() => setStep(step - 1)}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep(step + 1)}>
                Next <ArrowRight className="size-4" />
              </Button>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button icon={<BookMarked className="size-4" />} onClick={() => setKeeping(true)}>
                  Save in library
                </Button>
                <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={Boolean(promptLocked)} onClick={save}>
                  Save prompt
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="min-w-0 xl:sticky xl:top-6 xl:self-start">
          <Card
            title="Generated prompt"
            icon={<Wand2 className="size-4" />}
            description="Updates live. The required JSON output format is added automatically."
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={() =>
                  navigator.clipboard.writeText(prompt).then(
                    () => toast.success('Prompt copied'),
                    () => toast.error('Copying failed'),
                  )
                }
              >
                Copy
              </Button>
            }
          >
            {manualPrompt && (
              <Alert tone="warn" className="mb-3">
                {p.promptWizard.used ? 'Your saved prompt was edited by hand.' : 'You currently use your own prompt.'} Saving replaces it.
              </Alert>
            )}
            <pre className="max-h-[65vh] overflow-auto rounded-xl border border-border bg-surface-2 p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">{prompt}</pre>
          </Card>
        </div>
      </div>
      <SavePromptModal
        open={keeping}
        onClose={() => setKeeping(false)}
        prompt={prompt}
        wizard={{ ...a, used: true }}
        useCases={library.data?.useCases ?? []}
        defaults={{ name: 'Prompt from the wizard', model: library.data?.current.model, provider: library.data?.current.provider }}
      />
    </Page>
  );
}
