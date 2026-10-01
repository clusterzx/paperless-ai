import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Check,
  ChevronsUpDown,
  FileSearch,
  FlaskConical,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  Monitor,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Star,
  Sun,
  X,
} from 'lucide-react';
import type { ProcessingStatus } from '@shared/api';
import { errorMessage, get, post } from '../lib/api';
import { cn } from '../lib/format';
import { hasUnsavedChanges, useInterval } from '../lib/hooks';
import { ACCENTS, clearUserData, useAccent, useSession, useTheme, type ThemePref } from '../lib/session';
import { Wordmark } from './Brand';
import { CommandPalette, type Command } from './CommandPalette';
import { Avatar, rovingKeyDown, useConfirm, useDialog, useToast } from './ui';

export { Logo } from './Brand';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  hidden?: boolean;
  keywords?: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function ThemeSwitcher() {
  const [pref, setPref] = useTheme();
  const options: { value: ThemePref; icon: ReactNode; label: string }[] = [
    { value: 'light', icon: <Sun className="size-3.5" />, label: 'Light' },
    { value: 'system', icon: <Monitor className="size-3.5" />, label: 'System' },
    { value: 'dark', icon: <Moon className="size-3.5" />, label: 'Dark' },
  ];
  return (
    <div
      className="flex rounded-[10px] bg-surface-3/70 p-[3px]"
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={(e) => rovingKeyDown(e, options.map((o) => o.value), pref, setPref, true)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={pref === o.value}
          tabIndex={pref === o.value ? 0 : -1}
          title={o.label}
          onClick={() => setPref(o.value)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-[8px] py-1.5 text-xs font-medium transition',
            pref === o.value ? 'bg-surface text-fg shadow-xs ring-1 ring-border' : 'text-muted hover:text-fg',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AccentPicker() {
  const [accent, setAccent] = useAccent();
  return (
    <div className="flex items-center gap-2" role="radiogroup" aria-label="Accent colour" onKeyDown={(e) => rovingKeyDown(e, ACCENTS.map((a) => a.id), accent, setAccent)}>
      {ACCENTS.map((a) => (
        <button
          key={a.id}
          role="radio"
          aria-checked={accent === a.id}
          aria-label={a.label}
          title={a.label}
          tabIndex={accent === a.id ? 0 : -1}
          onClick={() => setAccent(a.id)}
          className={cn(
            'flex size-6 items-center justify-center rounded-full shadow-[var(--highlight)] ring-offset-2 ring-offset-surface transition hover:scale-110',
            accent === a.id && 'ring-2 ring-fg/70',
          )}
          style={{ background: a.swatch }}
        >
          {accent === a.id && <Check className="size-3.5 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

/** Account button with a menu for appearance, links and sign-out. */
function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDialog(panel, open, close);
  const name = session?.user?.username ?? '';
  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div
            ref={panel}
            role="dialog"
            aria-label="Account and appearance"
            tabIndex={-1}
            className="animate-pop absolute bottom-full left-0 z-50 mb-2 w-[min(17rem,calc(100vw-2rem))] rounded-2xl border border-border bg-surface p-1.5 shadow-pop outline-none"
          >
            <div className="flex items-center gap-3 px-2.5 pt-2 pb-3">
              <Avatar name={name} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{name}</div>
                <div className="text-xs text-faint">Paperless-AI v{session?.version}</div>
              </div>
            </div>
            <div className="space-y-3 rounded-xl bg-surface-2 p-3">
              <div>
                <div className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">Theme</div>
                <ThemeSwitcher />
              </div>
              <div>
                <div className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">Accent</div>
                <AccentPicker />
              </div>
            </div>
            <div className="mt-1.5 space-y-0.5">
              <a
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted transition hover:bg-surface-2 hover:text-fg"
                href="https://github.com/clusterzx/paperless-ai"
                target="_blank"
                rel="noreferrer"
              >
                <Star className="size-4" /> Star on GitHub
              </a>
              <button
                onClick={() => {
                  close();
                  onLogout();
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted transition hover:bg-danger-soft hover:text-danger"
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          </div>
        </>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition hover:bg-surface/80"
      >
        <Avatar name={name} className="size-7 text-[11px]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{name}</span>
          <span className="block text-[11px] text-faint">Account & appearance</span>
        </span>
        <ChevronsUpDown className="size-4 text-faint" />
      </button>
    </div>
  );
}

/** Small live view of the processing queue at the bottom of the sidebar. */
function ProcessingPulse() {
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const load = () =>
    get<ProcessingStatus>('/api/processing/status')
      .then(setStatus)
      .catch(() => undefined);
  useEffect(() => void load(), []);
  useInterval(load, status?.running || status?.scanning ? 4000 : 15_000);
  if (!status) return null;
  const busy = status.running || status.scanning || status.current.length > 0;
  const tone = status.paused ? 'bg-warn' : busy ? 'bg-accent' : 'bg-success';
  const label = status.paused
    ? 'Processing paused'
    : status.current.length
      ? `Analysing ${status.current.length} document${status.current.length > 1 ? 's' : ''}`
      : status.scanning
        ? 'Scanning Paperless…'
        : 'All caught up';
  return (
    <Link href="/" className="block rounded-xl border border-border bg-surface/70 px-3 py-2.5 transition hover:bg-surface">
      <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
        <span className={cn('status-dot', tone, busy && 'live')} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 flex gap-3 text-[11.5px] text-faint tabular-nums">
        <span>Queue {status.queued}</span>
        <span>Today {status.processedToday}</span>
        {status.counts.failed > 0 && <span className="text-danger">{status.counts.failed} failed</span>}
      </div>
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { session, refresh } = useSession();
  const confirm = useConfirm();
  const toast = useToast();
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  useDialog(drawer, open, () => setOpen(false));
  useEffect(() => setOpen(false), [location]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const confirmDiscard = useCallback(
    () => confirm({ title: 'Discard unsaved changes?', message: 'Your changes on this page have not been saved yet.', confirmLabel: 'Discard', danger: true }),
    [confirm],
  );

  const rag = Boolean(session?.features.rag);
  const nav: NavItem[] = [
    { href: '/', label: 'Dashboard', icon: <LayoutDashboard />, keywords: 'home overview status' },
    { href: '/ask', label: 'Ask your archive', icon: <Sparkles />, hidden: !rag, keywords: 'rag question search' },
    { href: '/chat', label: 'Document chat', icon: <MessageSquareText />, keywords: 'conversation' },
    { href: '/review', label: 'Manual review', icon: <FileSearch />, keywords: 'analyse suggest' },
    { href: '/playground', label: 'Prompt playground', icon: <FlaskConical />, keywords: 'test prompt' },
    { href: '/history', label: 'History', icon: <History />, keywords: 'undo changes' },
  ];
  const secondary: NavItem[] = [
    { href: '/settings', label: 'Settings', icon: <Settings />, keywords: 'configuration preferences' },
    { href: '/logs', label: 'Logs & diagnostics', icon: <ScrollText />, keywords: 'debug' },
  ];

  const isActive = (href: string) => (href === '/' ? location === '/' : location === href || location.startsWith(`${href}/`));

  // Pages with unsaved changes (settings) are only left after confirming.
  const go = useCallback(
    async (href: string) => {
      if (hasUnsavedChanges() && !(await confirmDiscard())) return;
      navigate(href);
    },
    [confirmDiscard, navigate],
  );
  const guardedNavigate = async (e: MouseEvent, href: string) => {
    if (!hasUnsavedChanges() || isActive(href)) return;
    e.preventDefault();
    if (await confirmDiscard()) navigate(href);
  };

  const scan = useCallback(async () => {
    try {
      const res = await post<{ queued: number }>('/api/processing/scan');
      toast.success(res.queued ? `${res.queued} new document(s) queued for analysis` : 'Scan finished – no new documents');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }, [toast]);

  const pageCommands: Command[] = useMemo(
    () =>
      [...nav, ...secondary]
        .filter((n) => !n.hidden)
        .map((n) => ({ id: `page-${n.href}`, group: 'Go to', label: n.label, icon: n.icon, keywords: n.keywords, run: () => void go(n.href) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rag, go],
  );

  const renderItem = (item: NavItem) =>
    item.hidden ? null : (
      <Link
        key={item.href}
        href={item.href}
        aria-current={isActive(item.href) ? 'page' : undefined}
        onClick={(e) => void guardedNavigate(e, item.href)}
        className={cn(
          'group flex items-center gap-3 rounded-[10px] px-2.5 py-[7px] text-[13.5px] font-medium transition [&_svg]:size-[17px]',
          isActive(item.href) ? 'bg-surface text-fg shadow-xs ring-1 ring-border' : 'text-muted hover:bg-surface/60 hover:text-fg',
        )}
      >
        <span className={cn('transition-colors', isActive(item.href) ? 'text-accent' : 'text-faint group-hover:text-fg')}>{item.icon}</span>
        {item.label}
      </Link>
    );

  const logout = async () => {
    if (hasUnsavedChanges() && !(await confirmDiscard())) return;
    await post('/api/auth/logout').catch(() => undefined);
    await refresh();
    clearUserData();
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-5 pb-4">
        <Wordmark version={session?.version} />
      </div>
      <div className="px-3 pb-4">
        <button
          onClick={() => setPalette(true)}
          className="flex h-9 w-full items-center gap-2.5 rounded-[10px] border border-border bg-surface/70 px-3 text-[13px] text-faint shadow-xs transition hover:border-border-strong hover:bg-surface hover:text-muted"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <span className="kbd">{isMac ? '⌘' : 'Ctrl'} K</span>
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label="Main">
        <div className="px-2.5 pt-1 pb-2 text-[11px] font-medium tracking-wide text-faint uppercase">Workspace</div>
        {nav.map(renderItem)}
        <div className="px-2.5 pt-5 pb-2 text-[11px] font-medium tracking-wide text-faint uppercase">System</div>
        {secondary.map(renderItem)}
      </nav>
      <div className="space-y-2 p-3">
        <ProcessingPulse />
        <UserMenu onLogout={() => void logout()} />
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-[252px] shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="animate-backdrop absolute inset-0 bg-[rgb(10_10_20/0.35)] backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside
            ref={drawer}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            tabIndex={-1}
            className="animate-in absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-border bg-canvas shadow-pop outline-none"
          >
            <button className="absolute top-5 right-3 rounded-lg p-1.5 text-muted hover:bg-surface" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
        <header className="flex items-center gap-2 border-b border-border bg-canvas/85 px-3 py-2.5 backdrop-blur lg:hidden">
          <button className="rounded-lg p-2 text-muted hover:bg-surface" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Wordmark className="flex-1" />
          <button className="rounded-lg p-2 text-muted hover:bg-surface" onClick={() => setPalette(true)} aria-label="Search">
            <Search className="size-5" />
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto bg-sheet lg:rounded-[18px] lg:border lg:border-border lg:shadow-card">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} pages={pageCommands} navigate={(href) => void go(href)} rag={rag} onScan={() => void scan()} />
    </div>
  );
}

/** Standard page container. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 sm:px-6 lg:px-10 lg:py-9', wide ? 'max-w-[1600px]' : 'max-w-[1280px]')}>{children}</div>;
}
