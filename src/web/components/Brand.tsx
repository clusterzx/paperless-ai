import { cn } from '../lib/format';

/** The Paperless-AI logo. */
export function Logo({ className }: { className?: string }) {
  return <img src="/logo.png" alt="" className={cn('size-8 shrink-0 object-contain', className)} />;
}

export function Wordmark({ className, version }: { className?: string; version?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <Logo />
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg">Paperless-AI</span>
        {version && <span className="rounded-full border border-border px-1.5 py-px font-mono text-[10px] text-faint">v{version}</span>}
      </div>
    </div>
  );
}
