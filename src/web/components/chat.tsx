import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Calendar, Check, Copy, ExternalLink, FileText, Sparkles, Square } from 'lucide-react';
import type { ChatStreamEvent, ChatTurn, RagSource } from '@shared/api';
import { errorMessage, streamEvents } from '../lib/api';
import { cn, formatDate } from '../lib/format';
import { Markdown } from './Markdown';
import { Alert, Badge } from './ui';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: RagSource[];
  status?: string | null;
  error?: string | null;
  streaming?: boolean;
  model?: string;
  tokens?: number;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/** Conversation state + streaming for the SSE chat endpoints. */
export function useChatStream(endpoint: string | null, initial: ChatMessage[] = [], extraBody?: () => Record<string, unknown>) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  /** Update one message; a no-op once it is gone (e.g. "New" was clicked while the answer streamed). */
  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((list) => {
      const i = list.findIndex((m) => m.id === id);
      if (i < 0) return list;
      const copy = [...list];
      copy[i] = fn(copy[i]);
      return copy;
    });

  const send = useCallback(
    async (text: string, buildBody: (history: ChatTurn[], text: string) => Record<string, unknown>) => {
      if (!endpoint || !text.trim()) return;
      const history: ChatTurn[] = messages.filter((m) => m.content && !m.error).map((m) => ({ role: m.role, content: m.content }));
      // Each stream only patches its own answer, so a stale stream cannot touch another conversation.
      const answerId = uid();
      const update = (fn: (m: ChatMessage) => ChatMessage) => patch(answerId, fn);
      setMessages((list) => [...list, { id: uid(), role: 'user', content: text.trim() }, { id: answerId, role: 'assistant', content: '', streaming: true, status: 'Thinking…' }]);
      setBusy(true);
      const c = new AbortController();
      ctrl.current = c;
      try {
        await streamEvents<ChatStreamEvent>(
          endpoint,
          { ...buildBody(history, text.trim()), ...(extraBody?.() ?? {}) },
          (e) => {
            if (e.type === 'delta') update((m) => ({ ...m, content: m.content + e.text, status: null }));
            else if (e.type === 'sources') update((m) => ({ ...m, sources: e.sources }));
            else if (e.type === 'status') update((m) => ({ ...m, status: e.message }));
            else if (e.type === 'error') update((m) => ({ ...m, error: e.message, status: null }));
            else if (e.type === 'done') update((m) => ({ ...m, model: e.model, tokens: e.usage?.totalTokens, status: null }));
          },
          c.signal,
        );
      } catch (err) {
        if (!c.signal.aborted) update((m) => ({ ...m, error: errorMessage(err), status: null }));
      } finally {
        update((m) => ({ ...m, streaming: false, status: null, content: m.content || (c.signal.aborted ? '*(stopped)*' : m.content) }));
        // A newer stream may already be running.
        if (ctrl.current === c) {
          setBusy(false);
          ctrl.current = null;
        }
      }
    },
    [endpoint, messages, extraBody],
  );

  const stop = () => ctrl.current?.abort();
  useEffect(() => () => ctrl.current?.abort(), []);
  return { messages, setMessages, busy, send, stop };
}

export function SourceCard({ source, highlighted, id, muted }: { source: RagSource; highlighted?: boolean; id?: string; muted?: boolean }) {
  return (
    <a
      id={id}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group block rounded-2xl border bg-surface p-3.5 text-left shadow-xs transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-card',
        highlighted ? 'border-accent ring-4 ring-accent/15' : 'border-border',
        muted && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2.5">
        <SourceNumber n={source.n} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-sm font-medium text-fg">
            <span className="truncate">{source.title}</span>
            <ExternalLink className="size-3 shrink-0 text-faint opacity-0 transition group-hover:opacity-100" />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
            {source.correspondent && <span className="truncate">{source.correspondent}</span>}
            {source.created && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="size-3" />
                {formatDate(source.created)}
              </span>
            )}
            {source.documentType && <span>{source.documentType}</span>}
          </div>
          <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">{source.snippet}</p>
        </div>
      </div>
    </a>
  );
}

function SourceNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[10.5px] font-semibold text-accent-text ring-1 ring-accent/20', className)}>
      {n}
    </span>
  );
}

/** Compact source tile for the horizontal source strip above an answer. */
function SourceTile({ source, highlighted, muted, id }: { source: RagSource; highlighted?: boolean; muted?: boolean; id?: string }) {
  return (
    <a
      id={id}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={source.snippet}
      className={cn(
        'group flex w-52 shrink-0 snap-start flex-col justify-between gap-2 rounded-xl border bg-surface p-3 text-left shadow-xs transition hover:border-border-strong hover:shadow-card',
        highlighted ? 'border-accent ring-4 ring-accent/15' : 'border-border',
        muted && 'opacity-60 hover:opacity-100',
      )}
    >
      <div className="line-clamp-2 text-[13px] leading-snug font-medium text-fg">{source.title}</div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted">
        <SourceNumber n={source.n} className="size-4 text-[9.5px]" />
        <span className="min-w-0 flex-1 truncate">{[source.correspondent, source.created && formatDate(source.created)].filter(Boolean).join(' · ') || source.documentType}</span>
        <ExternalLink className="size-3 shrink-0 text-faint opacity-0 transition group-hover:opacity-100" />
      </div>
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-faint transition hover:bg-surface-3/70 hover:text-fg"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Small gradient mark for the assistant. */
export function AssistantMark({ className }: { className?: string }) {
  return (
    <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-linear-to-br from-accent to-accent-2 text-white shadow-[var(--highlight)]', className)}>
      <Sparkles className="size-3.5" />
    </span>
  );
}

function Thinking({ status }: { status: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-sm">
      <span className="relative flex size-4 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
        <span className="size-2 rounded-full bg-accent" />
      </span>
      <span className="text-shimmer font-medium">{status}</span>
    </div>
  );
}

/**
 * One message. `layout="search"` renders a question as a heading with its sources above the answer
 * (Ask your archive); `layout="chat"` renders classic bubbles (document chat).
 */
export function MessageView({
  message,
  onCite,
  compactSources,
  layout = 'chat',
}: {
  message: ChatMessage;
  onCite?: (sourceKey: string, n: number) => void;
  compactSources?: boolean;
  layout?: 'chat' | 'search';
}) {
  const [highlight, setHighlight] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (message.role === 'user') {
    if (layout === 'search') {
      return <h2 className="animate-in pt-2 text-[22px] leading-snug font-semibold tracking-[-0.02em] break-words whitespace-pre-wrap text-fg">{message.content}</h2>;
    }
    return (
      <div className="animate-in flex justify-end">
        <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-surface-3/80 px-4 py-2.5 text-[0.95rem] whitespace-pre-wrap text-fg ring-1 ring-border">{message.content}</div>
      </div>
    );
  }
  const sources = message.sources ?? [];
  const cite = (n: number) => {
    setHighlight(n);
    setShowAll(true);
    onCite?.(message.id, n);
    setTimeout(() => document.getElementById(`src-${message.id}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }), 50);
    setTimeout(() => setHighlight(null), 2500);
  };
  // Sources the answer actually cites come first; the rest were searched but not used.
  const cited = new Set([...message.content.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  const primary = cited.size ? sources.filter((s) => cited.has(s.n)) : sources.slice(0, compactSources === false ? sources.length : 3);
  const others = sources.filter((s) => !primary.includes(s));

  const answer = (
    <>
      {message.status && !message.content && <Thinking status={message.status} />}
      {message.content && <Markdown text={message.content} citations={sources.length} onCite={cite} streaming={message.streaming} />}
      {message.error && (
        <Alert tone="danger" className="mt-3">
          {message.error}
        </Alert>
      )}
      {!message.streaming && message.content && (
        <div className="mt-3 flex items-center gap-2">
          <CopyButton text={message.content} />
          {message.model && (
            <span className="text-[11.5px] text-faint">
              {message.model}
              {message.tokens ? ` · ${message.tokens} tokens` : ''}
            </span>
          )}
        </div>
      )}
    </>
  );

  if (layout === 'search') {
    const strip = showAll ? [...primary, ...others] : primary;
    return (
      <div className="animate-in space-y-4">
        {sources.length > 0 && (
          <div>
            <div className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-muted">
              <FileText className="size-4" />
              {cited.size ? `${primary.length} cited source${primary.length === 1 ? '' : 's'}` : `${sources.length} source${sources.length === 1 ? '' : 's'}`}
              {others.length > 0 && (
                <button className="ml-auto text-xs font-medium text-accent-text hover:underline" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show cited only' : `+${others.length} searched`}
                </button>
              )}
            </div>
            <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
              {strip.map((s) => (
                <SourceTile key={s.documentId} id={`src-${message.id}-${s.n}`} source={s} highlighted={highlight === s.n} muted={cited.size > 0 && !cited.has(s.n)} />
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted">
            <AssistantMark className="size-5 rounded-md [&_svg]:size-3" /> Answer
          </div>
          {answer}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in flex gap-3">
      <AssistantMark className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {answer}
        {sources.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted">
              <FileText className="size-3.5" /> {cited.size ? `${primary.length} cited source${primary.length === 1 ? '' : 's'}` : `${sources.length} source${sources.length === 1 ? '' : 's'}`}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {(showAll ? [...primary, ...others] : primary).map((s) => (
                <SourceCard key={s.documentId} id={`src-${message.id}-${s.n}`} source={s} highlighted={highlight === s.n} muted={cited.size > 0 && !cited.has(s.n)} />
              ))}
            </div>
            {!showAll && others.length > 0 && (
              <button className="mt-2 text-xs font-medium text-accent-text hover:underline" onClick={() => setShowAll(true)}>
                {cited.size ? `Show ${others.length} more searched document${others.length === 1 ? '' : 's'}` : `Show all ${sources.length} sources`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Composer({
  onSend,
  onStop,
  busy,
  placeholder,
  disabled,
  footer,
  size = 'md',
  autoFocus,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy: boolean;
  placeholder?: string;
  disabled?: boolean;
  footer?: ReactNode;
  /** `lg`: the large centred input of an empty conversation. */
  size?: 'md' | 'lg';
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const submit = () => {
    if (!text.trim() || busy || disabled) return;
    onSend(text);
    setText('');
  };
  return (
    <div
      className={cn(
        'rounded-[22px] border border-border bg-surface p-2 shadow-pop transition focus-within:border-accent/60 focus-within:ring-4 focus-within:ring-accent/12',
        size === 'lg' && 'p-2.5',
      )}
    >
      <textarea
        ref={ref}
        rows={size === 'lg' ? 2 : 1}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        className={cn(
          'block max-h-56 w-full resize-none bg-transparent px-3 pt-2 outline-none placeholder:text-faint disabled:opacity-60',
          size === 'lg' ? 'min-h-[3.5rem] text-base' : 'min-h-[2.25rem] text-[0.95rem]',
        )}
      />
      <div className="flex items-center gap-2 pt-1 pl-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[11.5px] text-faint">{footer}</div>
        {busy ? (
          <button onClick={onStop} className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-surface transition hover:opacity-80" aria-label="Stop">
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() || disabled}
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent shadow-[var(--highlight)] transition hover:bg-accent-strong disabled:bg-surface-3 disabled:text-faint disabled:shadow-none"
            aria-label="Send"
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatScroll({ children, deps }: { children: ReactNode; deps: unknown[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      {children}
    </div>
  );
}

export function ModelBadge({ children }: { children: ReactNode }) {
  return <Badge className="font-mono text-[10px]">{children}</Badge>;
}
