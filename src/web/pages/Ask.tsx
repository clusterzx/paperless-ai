import { useEffect, useMemo, useState } from 'react';
import { Database, Filter, History, MessageSquarePlus, RefreshCw, Search, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import type { RagSource, RagStatus } from '@shared/api';
import { ChatScroll, Composer, MessageView, SourceCard, useChatStream, type ChatMessage } from '../components/chat';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Segmented, Select, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { useAsync, useInterval, useLocalStorage } from '../lib/hooks';
import { cn, formatNumber, timeAgo } from '../lib/format';

interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

interface Filters {
  from: string;
  to: string;
  correspondent: string;
  documentType: string;
}

const EMPTY_FILTERS: Filters = { from: '', to: '', correspondent: '', documentType: '' };

const EXAMPLES = [
  'When did I sign my rental agreement?',
  'What was the amount of the last electricity bill?',
  'Which documents mention my health insurance?',
  'Summarize my insurance contracts and their monthly costs.',
];

function IndexPanel({ status, onAction }: { status: RagStatus | undefined; onAction: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  if (!status) return <Spinner />;
  const pct = status.chunks ? Math.round((status.embedded / status.chunks) * 100) : 0;
  const run = async (path: string) => {
    setBusy(true);
    try {
      await post(path);
      onAction();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-muted">State</span>
        <Badge tone={status.state === 'indexing' ? 'info' : status.state === 'error' ? 'warn' : 'accent'}>
          {status.state === 'indexing' ? 'Indexing…' : status.state === 'error' ? 'Attention' : 'Ready'}
        </Badge>
      </div>
      {status.progress && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span className="capitalize">{status.progress.phase}</span>
            {status.progress.total > 0 && (
              <span className="tabular-nums">
                {formatNumber(status.progress.done)} / {formatNumber(status.progress.total)}
              </span>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className={cn('h-full rounded-full bg-accent transition-all', !status.progress.total && 'w-1/3 animate-pulse')}
              style={status.progress.total ? { width: `${(status.progress.done / status.progress.total) * 100}%` } : undefined}
            />
          </div>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-surface-2 p-2.5">
          <dt className="text-[11px] text-muted">Documents</dt>
          <dd className="font-semibold tabular-nums">{formatNumber(status.documents)}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 p-2.5">
          <dt className="text-[11px] text-muted">Passages</dt>
          <dd className="font-semibold tabular-nums">{formatNumber(status.chunks)}</dd>
        </div>
      </dl>
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-muted">Search mode</span>
          <span className="font-medium" title={status.vectorSearch ? 'Semantic (vector) + keyword (BM25) search' : 'Keyword (BM25) search'}>
            {status.vectorSearch ? 'Hybrid' : 'Keyword'}
          </span>
        </div>
        {status.embeddingProvider !== 'none' && (
          <div className="flex justify-between gap-2">
            <span className="text-muted">Embeddings</span>
            <span className="truncate font-medium" title={status.embeddingModel ?? ''}>
              {pct}% · {status.embeddingProvider}
            </span>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <span className="text-muted">Last sync</span>
          <span className="font-medium">{timeAgo(status.lastSyncAt)}</span>
        </div>
      </div>
      {status.lastError && <Alert tone="warn">{status.lastError}</Alert>}
      <div className="flex gap-2">
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy && status.state !== 'indexing'} disabled={status.state === 'indexing'} onClick={() => run('/api/rag/sync')}>
          Update now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            if (await confirm({ title: 'Rebuild index?', message: 'The search index is deleted and rebuilt from scratch. This can take a while for large archives.', confirmLabel: 'Rebuild', danger: true }))
              await run('/api/rag/rebuild');
          }}
        >
          Rebuild
        </Button>
      </div>
    </div>
  );
}

function FilterPanel({ filters, setFilters }: { filters: Filters; setFilters: (f: Filters) => void }) {
  const options = useAsync(() => get<{ correspondents: string[]; documentTypes: string[] }>('/api/rag/filters'), []);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label={<span className="text-xs">From</span>}>
          <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </Field>
        <Field label={<span className="text-xs">To</span>}>
          <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </Field>
      </div>
      <Field label={<span className="text-xs">Correspondent</span>}>
        <Select value={filters.correspondent} onChange={(e) => setFilters({ ...filters, correspondent: e.target.value })}>
          <option value="">All</option>
          {options.data?.correspondents.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label={<span className="text-xs">Document type</span>}>
        <Select value={filters.documentType} onChange={(e) => setFilters({ ...filters, documentType: e.target.value })}>
          <option value="">All</option>
          {options.data?.documentTypes.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      {JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS) && (
        <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function SearchResults({ filters }: { filters: Filters }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ sources: RagSource[]; mode: string; tookMs: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await post('/api/rag/search', { query, filters, limit: 30 }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 sm:px-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="flex gap-2"
      >
        <Input autoFocus placeholder="Search documents by meaning or keywords…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" variant="primary" loading={busy} icon={<Search className="size-4" />}>
          Search
        </Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
      {results && (
        <>
          <p className="text-xs text-muted">
            {results.sources.length} documents · {results.mode} search · {results.tookMs} ms
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {results.sources.map((s) => (
              <SourceCard key={s.documentId} source={s} />
            ))}
          </div>
          {!results.sources.length && <EmptyState icon={<Search className="size-5" />} title="No matching documents" />}
        </>
      )}
    </div>
  );
}

/** When the storage quota is exceeded, the oldest conversation (last in the list) is dropped. */
const dropOldest = (list: Conversation[]) => (list.length > 1 ? list.slice(0, -1) : null);

export default function AskPage() {
  const [conversations, setConversations] = useLocalStorage<Conversation[]>('pai-ask-conversations', [], dropOldest);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<'chat' | 'search'>('chat');
  const [filters, setFilters] = useLocalStorage<Filters>('pai-ask-filters', EMPTY_FILTERS);
  const [panel, setPanel] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const status = useAsync(() => get<RagStatus>('/api/rag/status'), []);
  useInterval(() => void status.reload(), status.data?.state === 'indexing' ? 2000 : 15_000);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const chat = useChatStream('/api/rag/chat', active?.messages ?? []);
  const activeFilters = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), [filters]);

  // Persist the conversation whenever a message finished streaming.
  useEffect(() => {
    if (chat.busy || !chat.messages.length) return;
    const id = activeId ?? Math.random().toString(36).slice(2, 10);
    const title = chat.messages.find((m) => m.role === 'user')?.content.slice(0, 80) ?? 'Conversation';
    setConversations((list) => [{ id, title, updatedAt: Date.now(), messages: chat.messages }, ...list.filter((c) => c.id !== id)].slice(0, 30));
    if (!activeId) setActiveId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.busy]);

  const newChat = () => {
    chat.stop();
    setActiveId(null);
    chat.setMessages([]);
  };
  const open = (c: Conversation) => {
    chat.stop();
    setActiveId(c.id);
    chat.setMessages(c.messages);
    setHistoryOpen(false);
  };
  const remove = (c: Conversation) => {
    // The open conversation would otherwise be saved again with its old id.
    if (c.id === activeId) newChat();
    setConversations((l) => l.filter((x) => x.id !== c.id));
  };
  const ask = (text: string) =>
    chat.send(text, (history, question) => ({ question, history: history.slice(-10), filters: Object.keys(activeFilters).length ? activeFilters : undefined }));

  const sidePanel = (
    <div className="space-y-6">
      <Card title="Search index" icon={<Database className="size-4" />} bodyClassName="p-4">
        <IndexPanel status={status.data} onAction={() => void status.reload()} />
      </Card>
      <Card title="Filters" icon={<Filter className="size-4" />} bodyClassName="p-4" description={Object.keys(activeFilters).length ? `${Object.keys(activeFilters).length} active` : 'Narrow down the search'}>
        <FilterPanel filters={filters} setFilters={setFilters} />
      </Card>
    </div>
  );

  const empty = status.data && status.data.documents === 0;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/70 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Sparkles className="size-5 shrink-0 text-accent" />
            <h1 className="truncate font-semibold">Ask your archive</h1>
          </div>
          <div className="flex items-center gap-2">
            <Segmented
              label="Mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'chat', label: 'Chat' },
                { value: 'search', label: 'Search' },
              ]}
            />
            <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setHistoryOpen(true)} aria-label="History">
              <span className="hidden sm:inline">History</span>
            </Button>
            <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="size-4" />} onClick={newChat} aria-label="New chat">
              <span className="hidden sm:inline">New</span>
            </Button>
            <Button size="sm" variant="ghost" className="xl:hidden" icon={<SlidersHorizontal className="size-4" />} onClick={() => setPanel(true)} aria-label="Index & filters" />
          </div>
        </div>

        {mode === 'search' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SearchResults filters={filters} />
          </div>
        ) : (
          <>
            <ChatScroll deps={[chat.messages]}>
              <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
                {!chat.messages.length && (
                  <div className="py-10 text-center">
                    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                      <Sparkles className="size-7" />
                    </div>
                    <h2 className="text-xl font-semibold">What would you like to know?</h2>
                    <p className="mx-auto mt-2 max-w-md text-sm text-muted">
                      Ask questions in your own words. Answers are based only on your documents and link to their sources.
                    </p>
                    {empty && (
                      <Alert tone="info" className="mx-auto mt-6 max-w-md text-left">
                        The search index is still being built. You can already ask – results improve once indexing has finished.
                      </Alert>
                    )}
                    <div className="mx-auto mt-8 grid max-w-2xl gap-2 sm:grid-cols-2">
                      {EXAMPLES.map((q) => (
                        <button key={q} onClick={() => ask(q)} className="rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm text-muted transition hover:border-accent hover:text-fg">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chat.messages.map((m) => (
                  <MessageView key={m.id} message={m} />
                ))}
              </div>
            </ChatScroll>
            <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
              <Composer
                onSend={ask}
                onStop={chat.stop}
                busy={chat.busy}
                placeholder="Ask about your documents…"
                footer={
                  <>
                    <span>Enter to send · Shift+Enter for a new line</span>
                    {Object.keys(activeFilters).length > 0 && (
                      <Badge tone="info" className="ml-auto">
                        <Filter className="size-3" /> Filters active
                      </Badge>
                    )}
                  </>
                }
              />
            </div>
          </>
        )}
      </div>

      <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-border bg-bg p-4 xl:block">{sidePanel}</aside>
      <Modal open={panel} onClose={() => setPanel(false)} title="Index & filters">
        {sidePanel}
      </Modal>
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Conversations">
        {!conversations.length ? (
          <EmptyState title="No conversations yet" />
        ) : (
          <ul className="divide-y divide-border">
            {conversations.map((c) => (
              <li key={c.id} className="flex items-center gap-2 py-2">
                <button className={cn('min-w-0 flex-1 text-left', c.id === activeId && 'text-accent-text')} onClick={() => open(c)}>
                  <div className="truncate text-sm font-medium">{c.title}</div>
                  <div className="text-xs text-muted">
                    {timeAgo(c.updatedAt)} · {c.messages.filter((m) => m.role === 'user').length} questions
                  </div>
                </button>
                <Button size="sm" variant="ghost" aria-label="Delete" onClick={() => remove(c)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
