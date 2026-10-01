import { useId } from 'react';
import { cn } from '../lib/format';

/** Brand mark: a document with an AI spark on an accent gradient (follows the selected accent colour). */
export function Logo({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8 shrink-0', className)} aria-hidden>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}-bg)`} />
      <rect width="32" height="32" rx="9" fill={`url(#${id}-shine)`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="#fff" strokeOpacity="0.18" />
      <path d="M11.2 7.5h6.3l5 5v10.3a2.2 2.2 0 0 1-2.2 2.2h-9.1A2.2 2.2 0 0 1 9 22.8V9.7a2.2 2.2 0 0 1 2.2-2.2Z" fill="#fff" fillOpacity="0.96" />
      <path d="M17.5 7.5v3.3c0 .94.76 1.7 1.7 1.7h3.3" fill="none" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="1.2" />
      <path d="M15.75 14.2l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z" fill="var(--accent)" />
      <circle cx="19.4" cy="20.9" r="0.95" fill="var(--accent-2)" />
    </svg>
  );
}

export function Wordmark({ className, version }: { className?: string; version?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <Logo />
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-[15px] font-semibold tracking-[-0.02em] text-fg">
          Paperless<span className="text-gradient">AI</span>
        </span>
        {version && <span className="rounded-full border border-border px-1.5 py-px font-mono text-[10px] text-faint">v{version}</span>}
      </div>
    </div>
  );
}
