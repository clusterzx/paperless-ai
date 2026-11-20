import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { BookMarked, Check, ChevronDown, FileText, FlaskConical, Pencil, Plus, Power, Search, Split, Star, Trash2, Wand2 } from 'lucide-react';
import type { LibraryPrompt, PromptLibrary } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, Textarea, useConfirm, useToast } from '../components/ui';
import { importLegacyPrompts, RatePromptModal, SavePromptModal, ScoreBadge } from '../components/promptLibrary';
import { PromptRulesCard } from '../components/promptRules';
import { api, errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatDate, timeAgo } from '../lib/format';

type Sort = 'score' | 'updated' | 'name';

export default function PromptsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const lib = useAsync((signal) => get<PromptLibrary>('/api/prompts', signal), []);
  const [useCase, setUseCase] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('score');
  const [editing, setEditing] = useState<LibraryPrompt | 'new' | null>(null);
  const [rating, setRating] = useState<LibraryPrompt | null>(null);
  const [savingCurrent, setSavingCurrent] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    importLegacyPrompts().then(
      (n) => {
        if (n) {
          toast.success(`${n} prompt${n === 1 ? '' : 's'} saved in this browser moved to the library`);
          void lib.reload();
        }
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = (p: LibraryPrompt) => lib.setData((l) => l && { ...l, prompts: l.prompts.map((x) => (x.id === p.id ? p : x)) });
  const prompts = useMemo(() => lib.data?.prompts ?? [], [lib.data]);
  const usedCases = [...new Set(prompts.map((p) => p.useCase).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = prompts.filter(
      (p) =>
        (useCase === null || (useCase === '' ? !p.useCase : p.useCase === useCase)) &&
        (!q || p.name.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q) || p.ratings.some((r) => r.model.toLowerCase().includes(q))),
    );
    const by: Record<Sort, (a: LibraryPrompt, b: LibraryPrompt) => number> = {
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1) || b.ratings.length - a.ratings.length,
      updated: (a, b) => b.updatedAt - a.updatedAt,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return [...list].sort((a, b) => Number(b.active) - Number(a.active) || by[sort](a, b));
  }, [prompts, useCase, query, sort]);

  const activate = async (p: LibraryPrompt) => {
    if (!(await confirm({ title: `Use “${p.name}”?`, message: 'It replaces the system prompt used for automatic processing.', confirmLabel: 'Use prompt' }))) return;
    try {
      await post(`/api/prompts/${p.id}/activate`);
      toast.success(`“${p.name}” is now used for new documents`);
      await lib.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (p: LibraryPrompt) => {
    if (!(await confirm({ title: `Delete “${p.name}”?`, message: 'The prompt and its ratings are removed from the library. The system prompt in use is not changed.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/api/prompts/${p.id}`, { method: 'DELETE' });
      lib.setData((l) => l && { ...l, prompts: l.prompts.filter((x) => x.id !== p.id) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const removeRating = async (p: LibraryPrompt, ratingId: number) => {
    try {
      replace(await api<LibraryPrompt>(`/api/prompts/${p.id}/ratings/${ratingId}`, { method: 'DELETE' }));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const saveCurrent = async () => {
    setSavingCurrent(true);
    try {
      await post('/api/prompts', { name: `Current prompt ${formatDate(Date.now())}`, current: true });
      toast.success('Current system prompt saved in the library');
      await lib.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSavingCurrent(false);
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="Prompt library"
        description="Prompts you have tested, with ratings per model. Use one for automatic processing with a single click."
        actions={
          <>
            {lib.data?.currentMissing && (
              <Button icon={<BookMarked className="size-4" />} loading={savingCurrent} onClick={saveCurrent}>
                Save current prompt
              </Button>
            )}
            <Button icon={<FlaskConical className="size-4" />} onClick={() => navigate('/playground')}>
              Playground
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New prompt
            </Button>
          </>
        }
      />
      {lib.error && <Alert tone="danger">{lib.error}</Alert>}
      {lib.data?.locked && (
        <Alert tone="warn" className="mb-4">
          The system prompt is set by the environment variable SYSTEM_PROMPT – prompts can be kept and rated here, but not activated.
        </Alert>
      )}
      {lib.data && <PromptRulesCard prompts={prompts} onChanged={() => void lib.reload()} />}

      {lib.loading && !lib.data ? (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : !prompts.length ? (
        <Card>
          <EmptyState
            icon={<BookMarked className="size-6" />}
            title="No prompts in the library yet"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button icon={<FlaskConical className="size-4" />} onClick={() => navigate('/playground')}>
                  Test a prompt in the playground
                </Button>
                <Button icon={<Wand2 className="size-4" />} onClick={() => navigate('/prompt-wizard')}>
                  Create one with the wizard
                </Button>
              </div>
            }
          >
            Test prompts in the playground on real documents and keep the good ones here – rated per model, sorted by use case.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Use case">
              {[null, ...usedCases, ...(prompts.some((p) => !p.useCase) && usedCases.length ? [''] : [])].map((u) => (
                <button
                  key={u ?? '*'}
                  className={cn('rounded-full border px-3 py-1 text-[13px] transition', useCase === u ? 'border-accent bg-accent-soft text-accent-text' : 'border-border text-muted hover:text-fg')}
                  aria-pressed={useCase === u}
                  onClick={() => setUseCase(u)}
                >
                  {u === null ? `All (${prompts.length})` : `${u || 'No use case'} (${prompts.filter((p) => p.useCase === u).length})`}
                </button>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
                <Input className="h-8 w-48 py-1 pl-8 text-xs" placeholder="Search name, text, model…" aria-label="Search prompts" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <Select className="h-8 py-1 text-xs" aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="score">Best rated</option>
                <option value="updated">Recently changed</option>
                <option value="name">Name</option>
              </Select>
            </div>
          </div>

          {!shown.length ? (
            <Card>
              <EmptyState title="No prompt matches" />
            </Card>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {shown.map((p) => {
                const expanded = open.has(p.id);
                return (
                  <section key={p.id} className={cn('flex flex-col rounded-2xl border bg-surface p-4 shadow-card', p.active ? 'border-success/50' : 'border-border')} aria-label={p.name}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="truncate text-[15px] font-semibold" title={p.name}>
                          {p.name}
                        </h2>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {p.active && (
                            <Badge tone="success">
                              <Check className="size-3" /> In use
                            </Badge>
                          )}
                          {p.useCase && <Badge tone="accent">{p.useCase}</Badge>}
                          {p.fromWizard && (
                            <Badge tone="info">
                              <Wand2 className="size-3" /> Wizard
                            </Badge>
                          )}
                          <ScoreBadge score={p.score} count={p.ratings.length} />
                          {p.rules.map((r) => (
                            <Badge key={r} tone="info" title="Used by this prompt rule">
                              <Split className="size-3" /> {r}
                            </Badge>
                          ))}
                          {p.documents > 0 && (
                            <Badge title="Documents processed with this prompt through a prompt rule">
                              <FileText className="size-3" /> {p.documents} document{p.documents === 1 ? '' : 's'}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-0.5">
                        <IconButton label="Edit" onClick={() => setEditing(p)}>
                          <Pencil className="size-3.5" />
                        </IconButton>
                        <IconButton label="Delete" onClick={() => remove(p)}>
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      </div>
                    </div>

                    {p.models.length > 0 && (
                      <ul className="mt-3 space-y-1 text-xs" aria-label="Ratings per model">
                        {p.models.slice(0, 3).map((m) => (
                          <li key={`${m.provider}/${m.model}`} className="flex items-center justify-between gap-2">
                            <span className="truncate text-muted" title={m.provider ? `${m.provider} · ${m.model}` : m.model}>
                              {m.model || 'model not recorded'}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              <Star className="mr-0.5 inline size-3 fill-warn text-warn" />
                              {m.score}
                              {m.count > 1 && <span className="text-faint"> · {m.count}×</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <pre className="mt-3 line-clamp-5 rounded-lg border border-border bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted">{p.prompt}</pre>

                    {p.ratings.length > 0 && (
                      <div className="mt-2">
                        <button
                          className="flex items-center gap-1 text-xs text-muted hover:text-fg"
                          aria-expanded={expanded}
                          onClick={() =>
                            setOpen((s) => {
                              const n = new Set(s);
                              if (n.has(p.id)) n.delete(p.id);
                              else n.add(p.id);
                              return n;
                            })
                          }
                        >
                          <ChevronDown className={cn('size-3.5 transition', expanded && 'rotate-180')} />
                          {p.ratings.length} rating{p.ratings.length === 1 ? '' : 's'}
                        </button>
                        {expanded && (
                          <ul className="mt-2 space-y-2">
                            {p.ratings.map((r) => (
                              <li key={r.id} className="rounded-lg border border-border p-2 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <Badge tone="warn">
                                      <Star className="size-3 fill-current" /> {r.score}
                                    </Badge>
                                    <span className="truncate text-muted">{r.model || 'model not recorded'}</span>
                                  </span>
                                  <span className="flex shrink-0 items-center gap-1 text-faint">
                                    {timeAgo(r.createdAt)}
                                    <IconButton label="Delete rating" onClick={() => removeRating(p, r.id)}>
                                      <Trash2 className="size-3" />
                                    </IconButton>
                                  </span>
                                </div>
                                {r.note && <p className="mt-1 text-fg">{r.note}</p>}
                                {r.documents.length > 0 && <p className="mt-1 text-faint">Tested on #{r.documents.join(', #')}</p>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={p.active ? 'secondary' : 'primary'}
                        icon={<Power className="size-3.5" />}
                        disabled={p.active || lib.data?.locked}
                        onClick={() => activate(p)}
                      >
                        {p.active ? 'In use' : 'Use for processing'}
                      </Button>
                      <Button size="sm" icon={<FlaskConical className="size-3.5" />} onClick={() => navigate(`/playground?prompt=${p.id}`)}>
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => setRating(p)}>
                        Rate
                      </Button>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      <EditPromptModal
        target={editing}
        useCases={lib.data?.useCases ?? []}
        library={lib.data}
        onClose={() => setEditing(null)}
        onSaved={() => void lib.reload()}
      />
      <RatePromptModal prompt={rating} library={lib.data} onClose={() => setRating(null)} onRated={replace} />
    </Page>
  );
}

/** Edit name, use case and text – or write a new prompt (saved through the same dialog as from the playground). */
function EditPromptModal({
  target,
  useCases,
  library,
  onClose,
  onSaved,
}: {
  target: LibraryPrompt | 'new' | null;
  useCases: string[];
  library: PromptLibrary | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', useCase: '', prompt: '' });
  const [saving, setSaving] = useState(false);
  // A new prompt is written first, then named and rated in the same dialog as from the playground.
  const [step, setStep] = useState<'write' | 'save'>('write');
  const existing = target && target !== 'new' ? target : null;
  useEffect(() => {
    if (existing) setForm({ name: existing.name, useCase: existing.useCase, prompt: existing.prompt });
    if (target === 'new') {
      setForm({ name: '', useCase: '', prompt: '' });
      setStep('write');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const save = async () => {
    if (!existing) return;
    setSaving(true);
    try {
      await api(`/api/prompts/${existing.id}`, { method: 'PATCH', body: { name: form.name.trim() || existing.name, useCase: form.useCase, prompt: form.prompt } });
      toast.success('Prompt updated');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (target === 'new') {
    return (
      <>
        <Modal
          open={step === 'write'}
          onClose={onClose}
          title="New prompt"
          size="lg"
          footer={
            <Button variant="primary" disabled={!form.prompt.trim()} onClick={() => setStep('save')}>
              Next
            </Button>
          }
        >
          <Field label="Prompt" hint="The output format (JSON fields, custom fields) is added automatically during processing.">
            <Textarea rows={16} className="font-mono text-xs" value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} />
          </Field>
        </Modal>
        <SavePromptModal
          open={step === 'save'}
          onClose={onClose}
          prompt={form.prompt}
          useCases={useCases}
          defaults={{ model: library?.current.model, provider: library?.current.provider }}
          onSaved={onSaved}
        />
      </>
    );
  }

  return (
    <Modal
      open={Boolean(existing)}
      onClose={onClose}
      title="Edit prompt"
      size="lg"
      footer={
        <Button variant="primary" loading={saving} onClick={save} disabled={!form.prompt.trim()}>
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} maxLength={120} />
          </Field>
          <Field label="Use case">
            <Input list="prompt-use-cases-edit" value={form.useCase} onChange={(e) => setForm((f) => ({ ...f, useCase: e.target.value }))} maxLength={60} />
            <datalist id="prompt-use-cases-edit">
              {useCases.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Prompt" hint={existing?.ratings.length ? 'The ratings stay – they keep their date, so you can tell which version they belong to.' : undefined}>
          <Textarea rows={14} className="font-mono text-xs" value={form.prompt} onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))} />
        </Field>
        {existing?.active && <Alert tone="info">This prompt is in use – changes here do not change the system prompt until you use it again.</Alert>}
      </div>
    </Modal>
  );
}
