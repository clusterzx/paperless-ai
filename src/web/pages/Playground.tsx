import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check, FileText, FlaskConical, Play, Save, Square, Star, Trash2, Wand2 } from 'lucide-react';
import type { AnalysisResult, DocumentSummary } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Skeleton, Textarea, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post, put, qs } from '../lib/api';
import { useAsync, useDebounced, useLocalStorage } from '../lib/hooks';
import { cn, duration, formatDate, formatNumber } from '../lib/format';
import { useMetadata } from '../lib/metadata';

interface SavedPrompt {
  id: string;
  prompt: string;
  rating: number;
  comment: string;
  savedAt: number;
}

type RunState = { status: 'pending' | 'running' | 'done' | 'error'; result?: AnalysisResult; error?: string };

function Diff({ label, before, after }: { label: string; before: string | null; after: string | null }) {
  if (!after) return null;
  const changed = (before ?? '') !== after;
  return (
    <div className="text-xs">
      <span className="text-faint">{label}: </span>
      {changed ? (
        <>
          <span className="font-medium text-accent-text">{after}</span>
          {before && <span className="ml-1 text-faint line-through">{before}</span>}
        </>
      ) : (
        <span className="text-muted">{after}</span>
      )}
    </div>
  );
}

export default function PlaygroundPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMetadata();
  const settings = useAsync(() => get<{ config: { processing: { systemPrompt: string } }; defaults: { systemPrompt: string } }>('/api/settings'), []);
  const [prompt, setPrompt] = useState('');
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 400);
  const docs = useAsync((signal) => get<DocumentSummary[]>(`/api/playground/documents${qs({ limit: 16, query: q })}`, signal), [q]);
  // Selected documents (kept across searches once the user picked them) – shown first and analyzed.
  const [selected, setSelected] = useState<Map<number, DocumentSummary>>(new Map());
  const pickedManually = useRef(false);
  const [runs, setRuns] = useState<Record<number, RunState>>({});
  const [running, setRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [saved, setSaved] = useLocalStorage<SavedPrompt[]>('pai-saved-prompts', []);
  const [rating, setRating] = useState<{ open: boolean; stars: number; comment: string }>({ open: false, stars: 7, comment: '' });

  useEffect(() => {
    if (settings.data && !prompt) setPrompt(settings.data.config.processing.systemPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);
  useEffect(() => {
    if (docs.data && !pickedManually.current) setSelected(new Map(docs.data.slice(0, 6).map((d) => [d.id, d])));
  }, [docs.data]);
  const pick = (fn: (prev: Map<number, DocumentSummary>) => Map<number, DocumentSummary>) => {
    pickedManually.current = true;
    setSelected(fn);
  };
  const results = docs.data ?? [];
  const shownDocs = [...[...selected.values()].filter((d) => !results.some((r) => r.id === d.id)), ...results];

  const stopRef = useRef(false);
  // Leaving the page stops a running batch (no more model calls in the background).
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    [],
  );
  const run = async () => {
    const ids = [...selected.keys()];
    if (!ids.length) return toast.info('Select at least one document');
    setRunning(true);
    setStopRequested(false);
    stopRef.current = false;
    setRuns(Object.fromEntries(ids.map((id) => [id, { status: 'pending' } as RunState])));
    for (const id of ids) {
      if (stopRef.current) break;
      setRuns((r) => ({ ...r, [id]: { status: 'running' } }));
      try {
        const result = await post<AnalysisResult>(`/api/documents/${id}/analyze`, { prompt });
        setRuns((r) => ({ ...r, [id]: { status: 'done', result } }));
      } catch (err) {
        setRuns((r) => ({ ...r, [id]: { status: 'error', error: errorMessage(err) } }));
      }
    }
    setRunning(false);
  };

  const totals = Object.values(runs).reduce(
    (acc, r) => (r.result ? { tokens: acc.tokens + r.result.usage.totalTokens, ms: acc.ms + r.result.durationMs, n: acc.n + 1 } : acc),
    { tokens: 0, ms: 0, n: 0 },
  );

  const useAsSystemPrompt = async () => {
    if (!(await confirm({ title: 'Use this prompt?', message: 'The prompt replaces the system prompt used for automatic processing.', confirmLabel: 'Save' }))) return;
    try {
      await put('/api/settings', { config: { processing: { systemPrompt: prompt } } });
      toast.success('System prompt saved');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="Prompt playground"
        description="Try prompts on real documents. Nothing is saved to Paperless – compare the AI's suggestions with the current values."
        actions={
          <>
            <Button icon={<BookmarkPlus className="size-4" />} onClick={() => setRating((r) => ({ ...r, open: true }))} disabled={!prompt.trim()}>
              Save & rate
            </Button>
            <Button icon={<Save className="size-4" />} onClick={useAsSystemPrompt} disabled={!prompt.trim()}>
              Use as system prompt
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card
            title="Prompt"
            icon={<FlaskConical className="size-4" />}
            actions={
              <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />} onClick={() => settings.data && setPrompt(settings.data.defaults.systemPrompt)}>
                Default
              </Button>
            }
          >
            {settings.loading ? (
              <Skeleton className="h-80" />
            ) : (
              <Textarea rows={18} className="font-mono text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            )}
            <p className="hint">The output format (JSON fields, custom fields) is appended automatically, exactly like during processing.</p>
            <div className="mt-4 flex items-center gap-2">
              {running ? (
                <Button
                  variant="danger"
                  icon={<Square className="size-4" />}
                  onClick={() => {
                    stopRef.current = true;
                    setStopRequested(true);
                  }}
                  disabled={stopRequested}
                >
                  Stop after current
                </Button>
              ) : (
                <Button variant="primary" icon={<Play className="size-4" />} onClick={run}>
                  Analyze {selected.size} document{selected.size === 1 ? '' : 's'}
                </Button>
              )}
              {totals.n > 0 && (
                <span className="text-xs text-muted">
                  {formatNumber(totals.tokens)} tokens · avg. {duration(Math.round(totals.ms / totals.n))}
                </span>
              )}
            </div>
          </Card>
          <Card title="Saved prompts" icon={<Star className="size-4" />} actions={saved.length > 0 && <Button size="sm" variant="ghost" onClick={() => setSaved([])}>Clear</Button>}>
            {!saved.length ? (
              <p className="text-sm text-muted">Rate prompts after a test run to keep track of what works best.</p>
            ) : (
              <ul className="space-y-3">
                {[...saved]
                  .sort((a, b) => b.rating - a.rating)
                  .map((s) => (
                    <li key={s.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone="warn">
                          <Star className="size-3 fill-current" /> {s.rating}/10
                        </Badge>
                        <span className="text-[11px] text-faint">{formatDate(s.savedAt, true)}</span>
                      </div>
                      <p className="mt-2 line-clamp-3 font-mono text-[11px] text-muted">{s.prompt}</p>
                      {s.comment && <p className="mt-1.5 text-xs text-fg">{s.comment}</p>}
                      <div className="mt-2 flex gap-1">
                        <Button size="sm" variant="subtle" onClick={() => setPrompt(s.prompt)}>
                          Use
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setSaved((l) => l.filter((x) => x.id !== s.id))} aria-label="Delete">
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </Card>
        </div>

        <Card
          title="Documents"
          description="Select the documents to test with"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Input className="h-8 w-full py-1 text-xs sm:w-48" placeholder="Search…" aria-label="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} />
              <Button size="sm" variant="ghost" onClick={() => pick((sel) => new Map([...sel, ...results.map((d) => [d.id, d] as const)]))}>
                All
              </Button>
              <Button size="sm" variant="ghost" onClick={() => pick(() => new Map())}>
                None
              </Button>
            </div>
          }
        >
          {docs.error && <Alert tone="danger">{docs.error}</Alert>}
          {docs.loading && !docs.data ? (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-64 rounded-xl" />
              ))}
            </div>
          ) : !shownDocs.length ? (
            <EmptyState title="No documents found" />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
              {shownDocs.map((d) => {
                const r = runs[d.id];
                const s = r?.result?.suggestion;
                const currentTags = d.tags.map((t) => meta.tagName(t).toLowerCase());
                const isSel = selected.has(d.id);
                return (
                  <div
                    key={d.id}
                    className={cn(
                      'relative flex flex-col overflow-hidden rounded-xl border bg-surface transition',
                      isSel ? 'border-accent' : 'border-border opacity-80 hover:opacity-100',
                      r?.status === 'running' && 'ring-4 ring-accent/15',
                    )}
                  >
                    <button
                      className="relative isolate h-32 overflow-hidden bg-surface-2"
                      onClick={() =>
                        pick((sel) => {
                          const n = new Map(sel);
                          if (n.has(d.id)) n.delete(d.id);
                          else n.set(d.id, d);
                          return n;
                        })
                      }
                      aria-pressed={isSel}
                    >
                      <img
                        src={`/api/documents/${d.id}/thumb`}
                        alt=""
                        loading="lazy"
                        className="relative z-10 size-full object-cover object-top"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                      <FileText className="absolute top-1/2 left-1/2 -z-0 size-8 -translate-x-1/2 -translate-y-1/2 text-border-strong" />
                      <span className={cn('absolute top-2 right-2 flex size-5 items-center justify-center rounded-md border', isSel ? 'border-accent bg-accent text-on-accent' : 'border-border-strong bg-surface/80')}>
                        {isSel && <Check className="size-3.5" />}
                      </span>
                      {r?.status === 'running' && <span className="absolute inset-x-0 bottom-0 h-1 animate-pulse bg-accent" />}
                    </button>
                    <div className="flex flex-1 flex-col gap-1.5 p-3">
                      <div className="line-clamp-2 text-sm font-medium" title={d.title}>
                        {d.title}
                      </div>
                      <div className="text-[11px] text-faint">
                        #{d.id} · {formatDate(d.created)}
                      </div>
                      {r?.status === 'error' && <p className="text-xs text-danger">{r.error}</p>}
                      {s && (
                        <div className="mt-1 space-y-1 border-t border-border pt-2">
                          <Diff label="Title" before={d.title} after={s.title} />
                          <Diff label="Correspondent" before={meta.correspondentName(d.correspondent)} after={s.correspondent} />
                          <Diff label="Type" before={meta.documentTypeName(d.document_type)} after={s.document_type} />
                          <Diff label="Date" before={d.created} after={s.document_date} />
                          {s.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-0.5">
                              {s.tags.map((t) => (
                                <Badge key={t} tone={currentTags.includes(t.toLowerCase()) ? 'neutral' : 'accent'}>
                                  {t}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {s.custom_fields.map((c) => (
                            <div key={c.field_name} className="text-xs">
                              <span className="text-faint">{c.field_name}: </span>
                              {c.value}
                            </div>
                          ))}
                          <div className="pt-1 text-[10px] text-faint">
                            {formatNumber(r.result!.usage.totalTokens)} tokens · {duration(r.result!.durationMs)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={rating.open}
        onClose={() => setRating((r) => ({ ...r, open: false }))}
        title="Rate this prompt"
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setSaved((l) => [{ id: Math.random().toString(36).slice(2), prompt, rating: rating.stars, comment: rating.comment, savedAt: Date.now() }, ...l].slice(0, 50));
              setRating({ open: false, stars: 7, comment: '' });
              toast.success('Prompt saved');
            }}
          >
            Save
          </Button>
        }
      >
        <div className="space-y-4">
          <div className="flex gap-1">
            {Array.from({ length: 10 }, (_, i) => (
              <button key={i} onClick={() => setRating((r) => ({ ...r, stars: i + 1 }))} aria-label={`${i + 1} stars`}>
                <Star className={cn('size-6', i < rating.stars ? 'fill-warn text-warn' : 'text-border-strong')} />
              </button>
            ))}
          </div>
          <Field label="Comment">
            <Textarea rows={3} value={rating.comment} onChange={(e) => setRating((r) => ({ ...r, comment: e.target.value }))} placeholder="What worked well, what did not?" />
          </Field>
        </div>
      </Modal>
    </Page>
  );
}
