import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Bot, Calendar, Check, Copy, ExternalLink, FileText, Square, User } from 'lucide-react';
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

  const patchLast = (fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((list) => {
      const copy = [...list];
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return copy;
    });

  const send = useCallback(
    async (text: string, buildBody: (history: ChatTurn[], text: string) => Record<string, unknown>) => {
      if (!endpoint || !text.trim()) return;
      const history: ChatTurn[] = messages.filter((m) => m.content && !m.error).map((m) => ({ role: m.role, content: m.content }));
      setMessages((list) => [...list, { id: uid(), role: 'user', content: text.trim() }, { id: uid(), role: 'assistant', content: '', streaming: true, status: 'Thinking…' }]);
      setBusy(true);
      const c = new AbortController();
      ctrl.current = c;
      try {
        await streamEvents<ChatStreamEvent>(
          endpoint,
          { ...buildBody(history, text.trim()), ...(extraBody?.() ?? {}) },
          (e) => {
            if (e.type === 'delta') patchLast((m) => ({ ...m, content: m.content + e.text, status: null }));
            else if (e.type === 'sources') patchLast((m) => ({ ...m, sources: e.sources }));
            else if (e.type === 'status') patchLast((m) => ({ ...m, status: e.message }));
            else if (e.type === 'error') patchLast((m) => ({ ...m, error: e.message, status: null }));
            else if (e.type === 'done') patchLast((m) => ({ ...m, model: e.model, tokens: e.usage?.totalTokens, status: null }));
          },
          c.signal,
        );
      } catch (err) {
        if (!c.signal.aborted) patchLast((m) => ({ ...m, error: errorMessage(err), status: null }));
      } finally {
        patchLast((m) => ({ ...m, streaming: false, status: null, content: m.content || (c.signal.aborted ? '*(stopped)*' : m.content) }));
        setBusy(false);
        ctrl.current = null;
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
        'group block rounded-xl border bg-surface p-3 text-left transition hover:border-accent',
        highlighted ? 'border-accent ring-4 ring-[var(--ring)]' : 'border-border',
        muted && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[11px] font-semibold text-accent-text">{source.n}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-sm font-medium text-fg">
            <span className="truncate">{source.title}</span>
            <ExternalLink className="size-3 shrink-0 text-faint opacity-0 transition group-hover:opacity-100" />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
            {source.correspondent && <span className="truncate">{source.correspondent}</span>}
            {source.created && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="size-3" />
                {formatDate(source.created)}
              </span>
            )}
            {source.documentType && <span>{source.documentType}</span>}
          </div>
          <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted">{source.snippet}</p>
        </div>
      </div>
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-faint transition hover:bg-surface-2 hover:text-fg"
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
      {done ? <Check className="size-3" /> : <Copy className="size-3" />} {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function MessageView({ message, onCite, compactSources }: { message: ChatMessage; onCite?: (sourceKey: string, n: number) => void; compactSources?: boolean }) {
  const [highlight, setHighlight] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (message.role === 'user') {
    return (
      <div className="animate-in flex justify-end gap-3">
        <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-[0.94rem] whitespace-pre-wrap text-white dark:text-[#04140e]">{message.content}</div>
        <div className="mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted sm:flex">
          <User className="size-4" />
        </div>
      </div>
    );
  }
  const sources = message.sources ?? [];
  const cite = (n: number) => {
    setHighlight(n);
    setShowAll(true);
    onCite?.(message.id, n);
    setTimeout(() => document.getElementById(`src-${message.id}-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    setTimeout(() => setHighlight(null), 2500);
  };
  // Sources the answer actually cites come first; the rest were searched but not used.
  const cited = new Set([...message.content.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  const primary = cited.size ? sources.filter((s) => cited.has(s.n)) : sources.slice(0, compactSources === false ? sources.length : 3);
  const others = sources.filter((s) => !primary.includes(s));
  return (
    <div className="animate-in flex gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Bot className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        {message.status && !message.content && (
          <div className="flex items-center gap-2 py-1.5 text-sm text-muted">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-bounce rounded-full bg-accent" style={{ animationDelay: `${i * 120}ms` }} />
              ))}
            </span>
            {message.status}
          </div>
        )}
        {message.content && <Markdown text={message.content} citations={sources.length} onCite={cite} streaming={message.streaming} />}
        {message.error && (
          <Alert tone="danger" className="mt-2">
            {message.error}
          </Alert>
        )}
        {sources.length > 0 && (
          <div className="mt-3">
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
        {!message.streaming && message.content && (
          <div className="mt-1.5 flex items-center gap-2">
            <CopyButton text={message.content} />
            {message.model && (
              <span className="text-[11px] text-faint">
                {message.model}
                {message.tokens ? ` · ${message.tokens} tokens` : ''}
              </span>
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
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy: boolean;
  placeholder?: string;
  disabled?: boolean;
  footer?: ReactNode;
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
    <div className="rounded-2xl border border-border bg-surface p-2 shadow-pop focus-within:border-accent focus-within:ring-4 focus-within:ring-[var(--ring)]">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-56 min-h-[2.5rem] flex-1 resize-none bg-transparent px-2.5 py-2 text-[0.95rem] outline-none placeholder:text-faint disabled:opacity-60"
        />
        {busy ? (
          <button onClick={onStop} className="mb-0.5 flex size-9 items-center justify-center rounded-xl bg-fg text-bg transition hover:opacity-80" aria-label="Stop">
            <Square className="size-3.5 fill-current" />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() || disabled}
            className="mb-0.5 flex size-9 items-center justify-center rounded-xl bg-accent text-white transition hover:bg-accent-strong disabled:opacity-40 dark:text-[#04140e]"
            aria-label="Send"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
      {footer && <div className="flex flex-wrap items-center gap-2 px-2 pt-1 pb-0.5 text-[11px] text-faint">{footer}</div>}
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
