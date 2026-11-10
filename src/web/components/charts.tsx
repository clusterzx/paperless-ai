import { useId, useState } from 'react';
import { cn, formatNumber } from '../lib/format';

export interface Slice {
  label: string;
  value: number;
  color: string;
}

/** Donut chart with a centred label. */
export function Donut({ slices, size = 148, thickness = 18, center }: { slices: Slice[]; size?: number; thickness?: number; center?: React.ReactNode }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} />
        {total > 0 &&
          slices.map((s) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, len - (slices.filter((x) => x.value > 0).length > 1 ? 2 : 0))} ${c}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              >
                <title>{`${s.label}: ${formatNumber(s.value)}`}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
      </svg>
      {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
    </div>
  );
}

export function Legend({ slices, total }: { slices: Slice[]; total?: number }) {
  const sum = total ?? slices.reduce((s, x) => s + x.value, 0);
  return (
    <ul className="space-y-2 text-sm">
      {slices.map((s) => (
        <li key={s.label} className="flex items-center gap-2.5">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
          <span className="flex-1 truncate text-muted">{s.label}</span>
          <span className="font-medium tabular-nums">{formatNumber(s.value)}</span>
          {sum > 0 && <span className="w-12 text-right text-xs text-faint tabular-nums">{Math.round((s.value / sum) * 100)}%</span>}
        </li>
      ))}
    </ul>
  );
}

/** Vertical bar chart (e.g. activity per day). */
export function Bars({ data, height = 140, formatLabel }: { data: { label: string; value: number }[]; height?: number; formatLabel?: (l: string) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="relative flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div key={d.label} className="group relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div
              className={cn('w-full rounded-t-[3px] transition-colors', hover === i ? 'bg-accent' : d.value ? 'bg-accent/55' : 'bg-surface-3')}
              style={{ height: `${Math.max(d.value ? 4 : 2, (d.value / max) * 100)}%` }}
            />
          </div>
        ))}
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-md bg-fg px-2 py-1 text-xs whitespace-nowrap text-bg shadow-pop"
            style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}
          >
            {formatLabel ? formatLabel(data[hover].label) : data[hover].label}: <b>{formatNumber(data[hover].value)}</b>
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-faint">
        <span>{data[0] && (formatLabel ? formatLabel(data[0].label) : data[0].label)}</span>
        <span>{data.at(-1) && (formatLabel ? formatLabel(data.at(-1)!.label) : data.at(-1)!.label)}</span>
      </div>
    </div>
  );
}

/** Horizontal bars with labels (ranking). */
export function HBars({ data, color = 'var(--accent)' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2.5">
      {data.map((d) => (
        <li key={d.label} className="text-[13px]">
          <div className="mb-1 flex justify-between gap-2">
            <span className="truncate text-fg">{d.label}</span>
            <span className="text-muted tabular-nums">{formatNumber(d.value)}</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-3">
            <div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Smooth area chart with a gradient fill and hover read-out (e.g. activity per day). */
export function AreaChart({
  data,
  height = 200,
  formatLabel,
}: {
  data: { label: string; value: number }[];
  height?: number;
  formatLabel?: (l: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();
  const W = 600;
  const H = 200;
  const pad = 6;
  const max = Math.max(1, ...data.map((d) => d.value));
  const pts = data.map((d, i) => [data.length > 1 ? (i / (data.length - 1)) * W : W / 2, H - pad - (d.value / max) * (H - pad * 2)] as const);
  // Monotone-ish smoothing with horizontal control points.
  const line = pts.reduce((acc, [x, y], i) => {
    if (i === 0) return `M${x},${y}`;
    const [px, py] = pts[i - 1];
    const cx = (px + x) / 2;
    return `${acc} C${cx},${py} ${cx},${y} ${x},${y}`;
  }, '');
  const area = pts.length ? `${line} L${W},${H} L0,${H} Z` : '';
  const fmt = (l: string) => (formatLabel ? formatLabel(l) : l);
  const h = hover !== null ? pts[hover] : null;
  return (
    <div>
      <div
        className="relative"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left) / r.width) * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, i)));
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--border)" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {h && <line x1={h[0]} x2={h[0]} y1="0" y2={H} stroke="var(--border-strong)" vectorEffect="non-scaling-stroke" />}
        </svg>
        {h && hover !== null && (
          <>
            <span
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow"
              style={{ left: `${(h[0] / W) * 100}%`, top: `${(h[1] / H) * 100}%` }}
            />
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-pop"
              style={{ left: `${Math.min(92, Math.max(8, (h[0] / W) * 100))}%` }}
            >
              <span className="text-muted">{fmt(data[hover].label)}</span> · <b className="tabular-nums">{formatNumber(data[hover].value)}</b>
            </div>
          </>
        )}
      </div>
      <div className="mt-2.5 flex justify-between text-[11px] text-faint">
        <span>{data[0] && fmt(data[0].label)}</span>
        <span>{data.at(-1) && fmt(data.at(-1)!.label)}</span>
      </div>
    </div>
  );
}

/** Tiny trend line for stat tiles. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const id = useId();
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const W = 100;
  const H = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - (v / max) * (H - 4)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn('h-7 w-full', className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** One horizontal bar split into segments, with a legend (e.g. processing coverage). */
export function SegmentBar({ slices, onSelect }: { slices: Slice[]; onSelect?: (label: string) => void }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  return (
    <div>
      <div className="flex h-2.5 w-full gap-[3px] overflow-hidden rounded-full bg-surface-3">
        {total > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s) => <div key={s.label} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${formatNumber(s.value)}`} />)}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
        {slices.map((s) => {
          const Comp = onSelect && s.value > 0 ? 'button' : 'div';
          return (
            <li key={s.label}>
              <Comp onClick={onSelect ? () => onSelect(s.label) : undefined} className={cn('flex w-full items-center gap-2 text-left', Comp === 'button' && 'rounded-md hover:text-fg')}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
                <span className="font-medium text-fg tabular-nums">{formatNumber(s.value)}</span>
              </Comp>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
