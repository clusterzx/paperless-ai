import { useState } from 'react';
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
        <li key={d.label} className="text-sm">
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
