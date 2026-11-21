import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { CalendarClock, CalendarDays, CalendarPlus, Copy, ExternalLink, Eye, EyeOff, RefreshCw, ScanSearch } from 'lucide-react';
import type { CalendarEvent, CalendarResponse, EventKind } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Segmented, Select, Skeleton, Stat, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatNumber } from '../lib/format';

type View = 'upcoming' | 'past' | 'dismissed';

const KIND: Record<EventKind, { label: string; tone: 'warn' | 'danger' | 'accent' | 'info' | 'neutral' }> = {
  due: { label: 'Payment', tone: 'warn' },
  deadline: { label: 'Deadline', tone: 'danger' },
  appointment: { label: 'Appointment', tone: 'accent' },
  expiry: { label: 'Expiry', tone: 'info' },
  other: { label: 'Date', tone: 'neutral' },
};

/** YYYY-MM-DD in the browser's time zone. */
function isoDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const asDate = (day: string) => new Date(`${day}T00:00:00`);
const daysBetween = (a: string, b: string) => Math.round((asDate(b).getTime() - asDate(a).getTime()) / 86_400_000);
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export default function CalendarPage() {
  const toast = useToast();
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>('upcoming');
  const cal = useAsync((signal) => get<CalendarResponse>('/api/calendar?dismissed=true', signal), []);
  const [scanOpen, setScanOpen] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);
  const today = isoDay();

  // Follow a running scan.
  const running = cal.data?.scan.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void cal.reload(), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const events = useMemo(() => cal.data?.events ?? [], [cal.data]);
  const active = events.filter((e) => !e.dismissed);
  const shown = useMemo(() => {
    if (view === 'dismissed') return events.filter((e) => e.dismissed);
    const list = active.filter((e) => (view === 'upcoming' ? e.date >= today : e.date < today));
    return view === 'past' ? [...list].reverse() : list;
  }, [events, active, view, today]);
  const within = (days: number) => active.filter((e) => e.date >= today && daysBetween(today, e.date) <= days).length;

  const toggle = async (e: CalendarEvent) => {
    try {
      await post(`/api/calendar/${e.id}/${e.dismissed ? 'restore' : 'dismiss'}`);
      cal.setData((d) => d && { ...d, events: d.events.map((x) => (x.id === e.id ? { ...x, dismissed: !x.dismissed } : x)) });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  // Month groups of the list.
  const groups: { key: string; label: string; items: CalendarEvent[] }[] = [];
  for (const e of shown) {
    const key = e.date.slice(0, 7);
    let g = groups.at(-1);
    if (g?.key !== key) {
      g = { key, label: asDate(`${key}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }), items: [] };
      groups.push(g);
    }
    g.items.push(e);
  }

  return (
    <Page>
      <PageHeader
        title="Calendar"
        description="Appointments, due dates and deadlines found in your documents."
        actions={
          <>
            <Button icon={<ScanSearch className="size-4" />} onClick={() => setScanOpen(true)} disabled={!cal.data?.enabled || running}>
              Search documents
            </Button>
            <Button variant="primary" icon={<CalendarPlus className="size-4" />} onClick={() => setFeedOpen(true)}>
              Subscribe
            </Button>
          </>
        }
      />
      {cal.error && <Alert tone="danger">{cal.error}</Alert>}
      {cal.data && !cal.data.enabled && (
        <Alert
          tone="info"
          className="mb-4"
          action={
            <Button size="sm" onClick={() => navigate('/settings?tab=processing')}>
              Open settings
            </Button>
          }
        >
          Date recognition is switched off. Turn on “Appointments & deadlines” in Settings → Processing – new documents are then searched for dates during the AI analysis.
        </Alert>
      )}
      {running && cal.data && (
        <Card className="mb-4">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <RefreshCw className="size-4 animate-spin text-accent" /> Searching documents for dates…
            </span>
            <span className="text-muted tabular-nums">
              {cal.data.scan.done} / {cal.data.scan.total} · {cal.data.scan.found} found
            </span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${cal.data.scan.total ? (cal.data.scan.done / cal.data.scan.total) * 100 : 0}%` }} />
          </div>
        </Card>
      )}
      {!running && cal.data?.scan.error && (
        <Alert tone="danger" className="mb-4">
          The search stopped: {cal.data.scan.error}
        </Alert>
      )}

      {cal.loading && !cal.data ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Today" value={formatNumber(within(0))} icon={<CalendarClock />} />
            <Stat label="Next 7 days" value={formatNumber(within(7))} icon={<CalendarDays />} />
            <Stat label="Next 30 days" value={formatNumber(within(30))} icon={<CalendarDays />} />
            <Stat label="Documents searched" value={formatNumber(cal.data?.scannedDocuments ?? 0)} icon={<ScanSearch />} />
          </div>
          <div className="mb-4">
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'past', label: 'Past' },
                { value: 'dismissed', label: `Hidden (${events.filter((e) => e.dismissed).length})` },
              ]}
            />
          </div>
          {!groups.length ? (
            <Card>
              <EmptyState icon={<CalendarDays className="size-6" />} title={view === 'upcoming' ? 'No upcoming dates' : view === 'past' ? 'No past dates' : 'Nothing hidden'}>
                {view === 'upcoming' && cal.data?.enabled
                  ? 'Dates appear here when documents are processed. Documents processed earlier can be searched with “Search documents”.'
                  : undefined}
              </EmptyState>
            </Card>
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <h2 className="mb-2 text-sm font-semibold text-muted">{g.label}</h2>
                  <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
                    {g.items.map((e) => {
                      const diff = daysBetween(today, e.date);
                      const d = asDate(e.date);
                      return (
                        <li key={e.id} className={cn('flex items-center gap-4 px-4 py-3', e.dismissed && 'opacity-60')}>
                          <div className={cn('flex w-12 shrink-0 flex-col items-center rounded-xl border py-1', diff === 0 ? 'border-accent bg-accent-soft text-accent-text' : 'border-border')}>
                            <span className="text-[11px] uppercase text-muted">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                            <span className="text-lg leading-tight font-semibold tabular-nums">{d.getDate()}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{e.title}</span>
                              <Badge tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Badge>
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                              <span>
                                {e.time ? `${e.time} · ` : ''}
                                {diff === 0 ? 'today' : relative.format(diff, 'day')}
                              </span>
                              <a href={e.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:text-fg">
                                <ExternalLink className="size-3 shrink-0" />
                                <span className="truncate">
                                  #{e.documentId} {e.documentTitle}
                                </span>
                              </a>
                            </div>
                          </div>
                          <IconButton label={e.dismissed ? 'Show again' : 'Hide'} onClick={() => toggle(e)}>
                            {e.dismissed ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                          </IconButton>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <ScanModal open={scanOpen} onClose={() => setScanOpen(false)} onStarted={() => void cal.reload()} />
      <FeedModal open={feedOpen} onClose={() => setFeedOpen(false)} />
    </Page>
  );
}

function ScanModal({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted: () => void }) {
  const toast = useToast();
  const [months, setMonths] = useState('12');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      await post('/api/calendar/scan', { months: Number(months) });
      onStarted();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Search documents for dates"
      footer={
        <Button variant="primary" loading={busy} onClick={start}>
          Start
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          For documents processed before the calendar was switched on. Only the dates are asked for – titles, tags and everything else in the archive stay as they are. Each
          document is one AI request; documents searched before are skipped.
        </p>
        <Field label="Documents created in the">
          <Select value={months} onChange={(e) => setMonths(e.target.value)}>
            <option value="3">last 3 months</option>
            <option value="12">last 12 months</option>
            <option value="36">last 3 years</option>
            <option value="0">all documents</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function FeedModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (open && !path) get<{ path: string }>('/api/calendar/feed').then((r) => setPath(r.path), (err: unknown) => toast.error(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const url = path ? `${window.location.origin}${path}` : '';
  const renew = async () => {
    if (!(await confirm({ title: 'Create a new link?', message: 'Calendars subscribed with the old link stop receiving updates.', confirmLabel: 'Create new link', danger: true }))) return;
    try {
      setPath((await post<{ path: string }>('/api/calendar/feed/reset')).path);
      toast.success('New link created');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Subscribe in your calendar app" size="lg">
      <div className="space-y-4">
        <p className="text-sm text-muted">Add this link as a calendar subscription – the dates stay up to date (apps refresh every few hours).</p>
        <Field label="Subscription link" hint="Keep it private: anyone with the link can see the dates.">
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              icon={<Copy className="size-4" />}
              disabled={!url}
              onClick={() =>
                navigator.clipboard.writeText(url).then(
                  () => toast.success('Link copied'),
                  () => toast.error('Copying failed'),
                )
              }
            >
              Copy
            </Button>
          </div>
        </Field>
        <ul className="space-y-1.5 text-sm text-muted">
          <li>
            <span className="font-medium text-fg">Google Calendar:</span> Other calendars → + → From URL
          </li>
          <li>
            <span className="font-medium text-fg">Apple Calendar:</span> File → New Calendar Subscription
          </li>
          <li>
            <span className="font-medium text-fg">Outlook:</span> Add calendar → Subscribe from web
          </li>
        </ul>
        <Alert tone="info">The calendar app has to reach Paperless-AI at this address – from outside your network only through a reverse proxy or VPN.</Alert>
        <Button variant="ghost" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={renew}>
          Create a new link
        </Button>
      </div>
    </Modal>
  );
}
