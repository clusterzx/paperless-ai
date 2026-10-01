import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  FileSearch,
  FlaskConical,
  Star,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  Sparkles,
  Sun,
  X,
} from 'lucide-react';
import { post } from '../lib/api';
import { cn } from '../lib/format';
import { useSession, useTheme, type ThemePref } from '../lib/session';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  hidden?: boolean;
}

export function Logo({ className }: { className?: string }) {
  return <img src="/logo.png" alt="" className={cn('size-8 rounded-lg', className)} />;
}

function ThemeSwitcher() {
  const [pref, setPref] = useTheme();
  const options: { value: ThemePref; icon: ReactNode; label: string }[] = [
    { value: 'light', icon: <Sun className="size-3.5" />, label: 'Light' },
    { value: 'system', icon: <Monitor className="size-3.5" />, label: 'System' },
    { value: 'dark', icon: <Moon className="size-3.5" />, label: 'Dark' },
  ];
  return (
    <div className="flex rounded-lg border border-border bg-surface-2 p-0.5" role="radiogroup" aria-label="Theme">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={pref === o.value}
          title={o.label}
          onClick={() => setPref(o.value)}
          className={cn('flex flex-1 items-center justify-center rounded-md py-1.5 transition', pref === o.value ? 'bg-surface text-fg shadow-card' : 'text-faint hover:text-fg')}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { session, refresh } = useSession();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [location]);

  const nav: NavItem[] = [
    { href: '/', label: 'Dashboard', icon: <LayoutDashboard className="size-[18px]" /> },
    { href: '/ask', label: 'Ask your archive', icon: <Sparkles className="size-[18px]" />, hidden: !session?.features.rag },
    { href: '/chat', label: 'Document chat', icon: <MessageSquareText className="size-[18px]" /> },
    { href: '/review', label: 'Manual review', icon: <FileSearch className="size-[18px]" /> },
    { href: '/playground', label: 'Prompt playground', icon: <FlaskConical className="size-[18px]" /> },
    { href: '/history', label: 'History', icon: <History className="size-[18px]" /> },
  ];
  const secondary: NavItem[] = [
    { href: '/settings', label: 'Settings', icon: <Settings className="size-[18px]" /> },
    { href: '/logs', label: 'Logs & diagnostics', icon: <ScrollText className="size-[18px]" /> },
  ];

  const isActive = (href: string) => (href === '/' ? location === '/' : location === href || location.startsWith(`${href}/`));
  const renderItem = (item: NavItem) =>
    item.hidden ? null : (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition',
          isActive(item.href) ? 'bg-accent-soft text-accent-text' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )}
      >
        <span className={cn(isActive(item.href) ? 'text-accent' : 'text-faint group-hover:text-fg')}>{item.icon}</span>
        {item.label}
      </Link>
    );

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    await refresh();
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pt-5 pb-6">
        <Logo />
        <div className="min-w-0">
          <div className="text-[0.95rem] leading-tight font-semibold text-fg">Paperless-AI</div>
          <div className="text-[11px] text-faint">v{session?.version}</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3" aria-label="Main">
        {nav.map(renderItem)}
        <div className="my-3 border-t border-border" />
        {secondary.map(renderItem)}
      </nav>
      <div className="space-y-3 border-t border-border p-3">
        <ThemeSwitcher />
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium text-fg">{session?.user?.username}</div>
            <a className="inline-flex items-center gap-1 text-faint hover:text-fg" href="https://github.com/clusterzx/paperless-ai" target="_blank" rel="noreferrer">
              <Star className="size-3" /> GitHub
            </a>
          </div>
          <button onClick={logout} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-surface-2 hover:text-fg" title="Sign out">
            <LogOut className="size-3.5" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="animate-in absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-surface shadow-pop">
            <button className="absolute top-4 right-3 rounded-lg p-1.5 text-muted hover:bg-surface-2" onClick={() => setOpen(false)} aria-label="Close menu">
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 lg:hidden">
          <button className="rounded-lg p-1.5 text-muted hover:bg-surface-2" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo className="size-7" />
          <span className="font-semibold">Paperless-AI</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/** Standard page container. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8', wide ? 'max-w-[1600px]' : 'max-w-7xl')}>{children}</div>;
}
