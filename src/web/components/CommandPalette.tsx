import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, FileSearch, MessageSquareText, Monitor, Moon, ScanSearch, Search, Sparkles, Sun } from 'lucide-react';
import { cn } from '../lib/format';
import { useTheme } from '../lib/session';
import { useDialog } from './ui';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: ReactNode;
  /** Extra words that should find this command. */
  keywords?: string;
  hint?: ReactNode;
  run: () => void | Promise<void>;
}

function matches(c: Command, q: string): boolean {
  if (!q) return true;
  const hay = `${c.label} ${c.keywords ?? ''} ${c.group}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * ⌘K / Ctrl+K: jump to pages, run actions, open a document by its number or ask the archive.
 */
export function CommandPalette({
  open,
  onClose,
  pages,
  navigate,
  rag,
  onScan,
}: {
  open: boolean;
  onClose: () => void;
  pages: Command[];
  navigate: (href: string) => void;
  rag: boolean;
  onScan: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [, setTheme] = useTheme();
  useDialog(ref, open, onClose);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const commands = useMemo(() => {
    const q = query.trim();
    const out: Command[] = [];
    const docId = /^#?(\d{1,9})$/.exec(q)?.[1];
    if (docId) {
      out.push(
        { id: 'doc-chat', group: `Document #${docId}`, label: `Chat with document #${docId}`, icon: <MessageSquareText />, run: () => navigate(`/chat?doc=${docId}`) },
        { id: 'doc-review', group: `Document #${docId}`, label: `Review document #${docId}`, icon: <FileSearch />, run: () => navigate(`/review?doc=${docId}`) },
      );
    }
    const actions: Command[] = [
      { id: 'scan', group: 'Actions', label: 'Scan for new documents', keywords: 'process now run', icon: <ScanSearch />, run: onScan },
      { id: 'light', group: 'Actions', label: 'Light theme', keywords: 'appearance mode', icon: <Sun />, run: () => setTheme('light') },
      { id: 'dark', group: 'Actions', label: 'Dark theme', keywords: 'appearance mode night', icon: <Moon />, run: () => setTheme('dark') },
      { id: 'system', group: 'Actions', label: 'System theme', keywords: 'appearance mode auto', icon: <Monitor />, run: () => setTheme('system') },
    ];
    out.push(...pages.filter((c) => matches(c, q)), ...actions.filter((c) => matches(c, q)));
    // A question: offered after matching pages and actions (first when nothing else matches).
    if (rag && q.length > 2 && !docId) {
      out.push({
        id: 'ask',
        group: 'Ask your archive',
        label: `“${q}”`,
        icon: <Sparkles />,
        hint: 'Ask',
        run: () => navigate(`/ask?q=${encodeURIComponent(q)}`),
      });
    }
    return out;
  }, [query, pages, rag, navigate, onScan, setTheme]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    void c.run();
  };

  let lastGroup = '';
  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[12vh]">
      <div className="animate-backdrop absolute inset-0 bg-[rgb(10_10_20/0.3)] backdrop-blur-[3px] dark:bg-black/60" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        tabIndex={-1}
        className="animate-pop relative w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-pop outline-none"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, commands.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(commands[active]);
              }
            }}
            placeholder={rag ? 'Search pages and actions, type a document number or ask a question…' : 'Search pages and actions or type a document number…'}
            aria-label="Command"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-list"
            aria-activedescendant={commands[active] ? `command-${commands[active].id}` : undefined}
            className="h-13 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
          />
          <span className="kbd">Esc</span>
        </div>
        <div ref={listRef} id="command-list" role="listbox" className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
          {!commands.length && <div className="px-3 py-8 text-center text-sm text-muted">Nothing found.</div>}
          {commands.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">{header}</div>}
                <button
                  id={`command-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors [&>svg]:size-4 [&>svg]:shrink-0',
                    i === active ? 'bg-accent-soft text-fg [&>svg]:text-accent-text' : 'text-muted [&>svg]:text-faint',
                  )}
                >
                  {c.icon}
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="text-xs text-faint">{c.hint}</span>}
                  {i === active && <CornerDownLeft className="size-3.5 text-faint" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-border bg-surface-2/70 px-4 py-2.5 text-[11.5px] text-faint">
          <span className="flex items-center gap-1.5">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> navigate
          </span>
          <span className="flex items-center gap-1.5">
            <span className="kbd">↵</span> open
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
