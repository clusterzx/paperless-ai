import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowUpRight, Database, Filter, History, MessageSquarePlus, RefreshCw, Search, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react';
import type { RagSource, RagStatus } from '@shared/api';
import { AssistantMark, ChatScroll, Composer, MessageView, SourceCard, useChatStream, type ChatMessage } from '../components/chat';
import { Alert, Badge, Button, EmptyState, Field, IconButton, Input, Modal, Segmented, Select, SlideOver, Spinner, useConfirm, useToast } from '../components/ui';
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
  const [, navigate] = useLocation();
  const status = useAsync(() => get<RagStatus>('/api/rag/status'), []);
  useInterval(() => void status.reload(), status.data?.state === 'indexing' ? 2000 : 15_000);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const chat = useChatStream('/api/rag/chat', active?.messages ?? []);
  const activeFilters = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), [filters]);
  const filterCount = Object.keys(activeFilters).length;

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
    chat.send(text, (history, question) => ({ question, history: history.slice(-10), filters: filterCount ? activeFilters : undefined }));

  // "Ask your archive" from the command menu: /ask?q=…
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (!q) return;
    navigate('/ask', { replace: true });
    newChat();
    setTimeout(() => void ask(q), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const empty = status.data && status.data.documents === 0;
  const st = status.data;

  const composerFooter = (
    <>
      <button
        type="button"
        onClick={() => setPanel(true)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition',
          filterCount ? 'border-accent/30 bg-accent-soft text-accent-text' : 'border-border text-muted hover:border-border-strong hover:text-fg',
        )}
      >
        <SlidersHorizontal className="size-3" /> {filterCount ? `${filterCount} filter${filterCount > 1 ? 's' : ''} active` : 'Filters'}
      </button>
      <span className="hidden sm:inline">Enter to send · Shift+Enter for a new line</span>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="z-10 flex items-center justify-between gap-3 border-b border-border/70 bg-sheet/80 px-4 py-2.5 backdrop-blur-xl sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <AssistantMark />
          <h1 className="truncate text-[15px] font-semibold tracking-tight">Ask your archive</h1>
          {st && (
            <button
              onClick={() => setPanel(true)}
              className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted transition hover:border-border-strong hover:text-fg md:inline-flex"
              title="Search index"
            >
              <span className={cn('status-dot', st.state === 'indexing' ? 'live bg-accent' : st.state === 'error' ? 'bg-warn' : 'bg-success')} />
              {formatNumber(st.documents)} documents · {st.vectorSearch ? 'hybrid' : 'keyword'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
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
          <Button size="sm" variant="ghost" icon={<SlidersHorizontal className="size-4" />} onClick={() => setPanel(true)} aria-label="Index & filters">
            {filterCount > 0 && <span className="flex size-4 items-center justify-center rounded-full bg-accent text-[10px] text-on-accent">{filterCount}</span>}
          </Button>
        </div>
      </div>

      {mode === 'search' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SearchResults filters={filters} />
        </div>
      ) : !chat.messages.length ? (
        <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="aurora fade-bottom pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-80" />
          <div className="relative m-auto w-full max-w-2xl px-4 py-12 sm:px-6">
            <div className="mb-5 flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-3 py-1 text-xs font-medium text-muted shadow-xs backdrop-blur">
                <Sparkles className="size-3.5 text-accent" /> Answers from your documents, with sources
              </span>
            </div>
            <h2 className="text-center text-[30px] leading-tight font-semibold tracking-[-0.035em] text-fg sm:text-[38px]">
              What would you like to <span className="text-gradient">know?</span>
            </h2>
            <p className="mx-auto mt-3 max-w-md text-center text-[15px] text-muted">Ask in your own words – Paperless-AI searches your archive and cites the documents it used.</p>
            {empty && (
              <Alert tone="info" className="mx-auto mt-6 max-w-md text-left">
                The search index is still being built. You can already ask – results improve once indexing has finished.
              </Alert>
            )}
            <div className="mt-8">
              <Composer onSend={ask} onStop={chat.stop} busy={chat.busy} placeholder="Ask about your documents…" size="lg" autoFocus footer={composerFooter} />
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  onClick={() => ask(q)}
                  className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-3.5 py-1.5 text-[13px] text-muted shadow-xs backdrop-blur transition hover:border-accent/40 hover:text-fg"
                >
                  {q}
                  <ArrowUpRight className="size-3.5 text-faint transition group-hover:text-accent" />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <ChatScroll deps={[chat.messages]}>
            <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
              {chat.messages.map((m, i) => (
                <div key={m.id} className={cn(m.role === 'user' && i > 0 && 'mt-10 border-t border-border pt-8', m.role === 'assistant' && 'mt-5')}>
                  <MessageView message={m} layout="search" />
                </div>
              ))}
            </div>
          </ChatScroll>
          <div className="relative mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6">
            <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-linear-to-t from-sheet to-transparent" />
            <Composer onSend={ask} onStop={chat.stop} busy={chat.busy} placeholder="Ask a follow-up…" footer={composerFooter} />
          </div>
        </>
      )}

      <SlideOver open={panel} onClose={() => setPanel(false)} title="Index & filters" description="Where the answers come from">
        <div className="space-y-7">
          <section>
            <h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Database className="size-4 text-faint" /> Search index
            </h4>
            <IndexPanel status={status.data} onAction={() => void status.reload()} />
          </section>
          <section>
            <h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Filter className="size-4 text-faint" /> Filters
            </h4>
            <FilterPanel filters={filters} setFilters={setFilters} />
          </section>
        </div>
      </SlideOver>
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Conversations">
        {!conversations.length ? (
          <EmptyState icon={<History />} title="No conversations yet">
            Your questions are kept in this browser.
          </EmptyState>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {conversations.map((c) => (
              <li key={c.id} className={cn('group flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-surface-2', c.id === activeId && 'bg-accent-soft/60')}>
                <button className="min-w-0 flex-1 py-1 text-left" onClick={() => open(c)}>
                  <div className={cn('truncate text-sm font-medium', c.id === activeId ? 'text-accent-text' : 'text-fg')}>{c.title}</div>
                  <div className="text-xs text-muted">
                    {timeAgo(c.updatedAt)} · {c.messages.filter((m) => m.role === 'user').length} questions
                  </div>
                </button>
                <IconButton label="Delete" onClick={() => remove(c)} className="opacity-60 group-hover:opacity-100">
                  <Trash2 className="size-3.5" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
