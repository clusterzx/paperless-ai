const nf = new Intl.NumberFormat();

export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined ? '–' : nf.format(n);
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDate(value: string | number | null | undefined, withTime = false): string {
  if (value === null || value === undefined || value === '') return '–';
  const d = typeof value === 'number' ? new Date(value) : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return withTime ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(-Math.round(diff / ms), unit);
  }
  return '';
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function cn(...classes: (string | false | null | undefined | 0 | 0n)[]): string {
  return classes.filter(Boolean).join(' ');
}
