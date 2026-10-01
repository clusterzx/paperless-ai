import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bot,
  CircleCheck,
  Clock,
  Coins,
  FileText,
  History,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Tags,
} from 'lucide-react';
import type { DashboardData, HistoryPage, ProcessingStatus } from '@shared/api';
import { Page } from '../components/Layout';
import { AreaChart, HBars, SegmentBar, Sparkline, type Slice } from '../components/charts';
import { Alert, Badge, Button, buttonClass, Card, EmptyState, Modal, Segmented, Skeleton, Stat, useToast } from '../components/ui';
import { errorMessage, get, post, qs } from '../lib/api';
import { useAsync, useInterval } from '../lib/hooks';
import { cn, compactNumber, duration, formatDate, formatNumber, timeAgo } from '../lib/format';
import { useSession } from '../lib/session';

interface Problem {
  documentId: number;
  title: string | null;
  status: string;
  reason: string | null;
  attempts: number;
  updatedAt: number;
  url: string;
}

function ProblemsModal({ status, onClose }: { status: 'failed' | 'skipped' | null; onClose: () => void }) {
  const toast = useToast();
  const list = useAsync(() => (status ? get<Problem[]>(`/api/processing/problems?status=${status}`) : Promise.resolve([])), [status]);
  const [busy, setBusy] = useState(false);
  const retry = async (ids?: number[]) => {
    setBusy(true);
    try {
      const res = await post<{ queued: number }>('/api/processing/retry', { ids });
      toast.success(`${res.queued} document(s) queued again`);
      await list.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={status !== null}
      onClose={onClose}
      size="lg"
      title={status === 'failed' ? 'Failed documents' : 'Skipped documents'}
      footer={
        status === 'failed' && list.data?.length ? (
          <Button variant="primary" icon={<RefreshCw className="size-4" />} loading={busy} onClick={() => retry()}>
            Retry all
          </Button>
        ) : undefined
      }
    >
      {list.loading ? (
        <Skeleton className="h-24" />
      ) : !list.data?.length ? (
        <EmptyState icon={<CircleCheck className="size-5" />} title="Nothing here" />
      ) : (
        <ul className="divide-y divide-border">
          {list.data.map((p) => (
            <li key={p.documentId} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <a href={p.url} target="_blank" rel="noreferrer" className="font-medium text-fg hover:underline">
                  #{p.documentId} {p.title ?? ''}
                </a>
                <div className="mt-0.5 text-xs break-words text-muted">{p.reason}</div>
                <div className="mt-1 text-[11px] text-faint">
                  {timeAgo(p.updatedAt)}
                  {p.status === 'failed' && ` · ${p.attempts} attempt(s)`}
                </div>
              </div>
              <Button size="sm" onClick={() => retry([p.documentId])} disabled={busy}>
                Process again
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

type MetaKind = 'tags' | 'correspondents' | 'documentTypes';

function MetadataModal({ initial, onClose }: { initial: MetaKind | null; onClose: () => void }) {
  const open = initial !== null;
  const data = useAsync(
    () => (open ? get<Record<MetaKind, { id: number; name: string; document_count: number }[]>>('/api/metadata/counts') : Promise.resolve(undefined)),
    [open],
  );
  const [kind, setKind] = useState<MetaKind>('tags');
  const [filter, setFilter] = useState('');
  useEffect(() => {
    if (initial) setKind(initial);
  }, [initial]);
  const items = data.data?.[kind] ?? [];
  const shown = items.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Paperless metadata" size="md">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="Metadata type"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'tags', label: `Tags (${data.data?.tags.length ?? '…'})` },
            { value: 'correspondents', label: `Correspondents (${data.data?.correspondents.length ?? '…'})` },
            { value: 'documentTypes', label: `Types (${data.data?.documentTypes.length ?? '…'})` },
          ]}
        />
      </div>
      <input className="input mb-3" placeholder="Filter…" aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {data.loading ? (
        <Skeleton className="h-40" />
      ) : (
        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">
          {shown.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="truncate">{i.name}</span>
              <Badge>{formatNumber(i.document_count)} docs</Badge>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function LiveStatus({ status, onChange }: { status: ProcessingStatus; onChange: (s: ProcessingStatus) => void }) {
  const toast = useToast();
  const togglePause = async () => {
    try {
      onChange(await post<ProcessingStatus>(status.paused ? '/api/processing/resume' : '/api/processing/pause'));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const busy = status.running || status.scanning || status.current.length > 0;
  const state = status.paused ? 'Paused' : status.current.length ? 'Analysing documents' : status.scanning ? 'Scanning Paperless' : 'All caught up';
  return (
    <section className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn('relative flex size-10 items-center justify-center rounded-xl', status.paused ? 'bg-warn-soft text-warn' : busy ? 'bg-accent-soft text-accent-text' : 'bg-success-soft text-success')}>
            {status.paused ? <Pause className="size-[18px]" /> : busy ? <Loader2 className="size-[18px] animate-spin" /> : <CircleCheck className="size-[18px]" />}
          </span>
          <div>
            <div className="text-[13px] font-medium text-muted">Processing</div>
            <div className="text-[17px] font-semibold tracking-tight text-fg">{state}</div>
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={status.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={togglePause}>
          {status.paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      {status.current.length === 0 && (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-dashed border-border-strong/70 px-3.5 py-3 text-sm">
          {status.lastProcessed ? (
            <>
              <FileText className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-muted">
                Last analysed: <span className="font-medium text-fg">{status.lastProcessed.title ?? `Document ${status.lastProcessed.documentId}`}</span>
              </span>
              <span className="shrink-0 text-xs text-faint">{timeAgo(status.lastProcessed.processedAt)}</span>
            </>
          ) : (
            <span className="text-muted">{status.paused ? 'Processing is paused – new documents wait in the queue.' : 'Waiting for new documents in Paperless.'}</span>
          )}
        </div>
      )}

      {status.current.length > 0 && (
        <ul className="mt-4 space-y-2">
          {status.current.map((j) => (
            <li key={j.documentId} className="flex items-center gap-3 rounded-xl border border-accent/20 bg-accent-soft/50 px-3 py-2.5">
              <span className="status-dot live bg-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  #{j.documentId} {j.title ?? ''}
                </div>
                <div className="text-xs text-muted capitalize">
                  {j.stage} · {duration(Date.now() - j.startedAt)}
                </div>
              </div>
              <Badge tone="accent">{j.source}</Badge>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-3 pt-5 sm:grid-cols-4">
        {[
          ['Queue', String(status.queued)],
          ['Today', String(status.processedToday)],
          ['Last scan', timeAgo(status.lastScanAt)],
          [status.automatic ? 'Next scan' : 'Schedule', status.automatic ? (status.nextScanAt ? timeAgo(status.nextScanAt) : '–') : 'Manual'],
        ].map(([l, v]) => (
          <div key={l}>
            <dt className="text-xs text-faint">{l}</dt>
            <dd className="mt-0.5 truncate text-sm font-semibold text-fg tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {status.lastError && (
        <Alert tone="warn" className="mt-4">
          {status.lastError}
        </Alert>
      )}
    </section>
  );
}

/** The latest changes made by the AI. */
function RecentChanges() {
  const recent = useAsync(() => get<HistoryPage>(`/api/history${qs({ pageSize: 6 })}`), []);
  const items = recent.data?.items ?? [];
  return (
    <Card
      title="Recent changes"
      description="What the AI changed in Paperless"
      icon={<History />}
      actions={
        <Link href="/history" className={buttonClass({ size: 'sm', variant: 'ghost' })}>
          View all <ArrowRight className="size-3.5" />
        </Link>
      }
      bodyClassName="px-2 pt-3 pb-2"
    >
      {recent.loading && !recent.data ? (
        <div className="space-y-2 px-3 pb-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : !items.length ? (
        <EmptyState icon={<Sparkles />} title="No changes yet">
          Processed documents show up here – with their new title, tags and correspondent.
        </EmptyState>
      ) : (
        <ul>
          {items.map((i) => (
            <li key={i.id}>
              <Link href={`/history?search=${encodeURIComponent(String(i.documentId))}`} className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-surface-2">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-muted ring-1 ring-border">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate text-sm font-medium text-fg', i.revertedAt && 'line-through decoration-faint')}>{i.title ?? `Document ${i.documentId}`}</div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    {i.correspondent && <span className="truncate">{i.correspondent}</span>}
                    {i.correspondent && i.tagNames.length > 0 && <span className="text-faint">·</span>}
                    {i.tagNames.slice(0, 3).map((t) => (
                      <Badge key={t} className="px-1.5 py-0 text-[11px]">
                        {t}
                      </Badge>
                    ))}
                    {i.tagNames.length > 3 && <span className="text-faint">+{i.tagNames.length - 3}</span>}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-faint">{timeAgo(i.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function DashboardPage() {
  const { session } = useSession();
  const toast = useToast();
  // tzOffset: the activity timeline is grouped by the viewer's local days.
  const dash = useAsync(() => get<DashboardData>(`/api/dashboard${qs({ tzOffset: new Date().getTimezoneOffset() })}`), []);
  const update = useAsync(() => get<{ updateAvailable: boolean; latest: string | null; url: string | null }>('/api/update-check'), []);
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const [meta, setMeta] = useState<MetaKind | null>(null);
  const [problems, setProblems] = useState<'failed' | 'skipped' | null>(null);
  const [scanning, setScanning] = useState(false);
  useInterval(() => {
    get<ProcessingStatus>('/api/processing/status')
      .then(setStatus)
      .catch(() => undefined);
  }, 3000);
  useInterval(() => void dash.reload(), 60_000);

  const d = dash.data;
  const live = status ?? d?.processing;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await post<{ queued: number }>('/api/processing/scan');
      toast.success(res.queued ? `${res.queued} new document(s) queued for analysis` : 'Scan finished – no new documents');
      setStatus(await get<ProcessingStatus>('/api/processing/status'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setScanning(false);
    }
  };

  const total = d?.paperless.documents ?? 0;
  const processed = live?.counts.processed ?? 0;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  const coverage: Slice[] = useMemo(() => {
    if (!d || !live) return [];
    const { processed, failed, skipped } = live.counts;
    const open = Math.max(0, d.paperless.documents - processed - failed - skipped);
    return [
      { label: 'Processed by AI', value: processed, color: 'var(--accent)' },
      { label: 'Not processed yet', value: open, color: 'var(--border-strong)' },
      { label: 'Skipped', value: skipped, color: '#e9a23b' },
      { label: 'Failed', value: failed, color: 'var(--danger)' },
    ];
  }, [d, live]);

  const timeline = useMemo(() => {
    if (!d) return [];
    const map = new Map(d.timeline.map((t) => [t.date, t.count]));
    const out: { label: string; value: number }[] = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      // Calendar arithmetic (not 24 h steps) so DST changes do not skip or repeat a day.
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      out.push({ label: key, value: map.get(key) ?? 0 });
    }
    return out;
  }, [d]);
  const last30 = timeline.reduce((s, t) => s + t.value, 0);

  return (
    <Page>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          <div className="mb-1.5 text-[13px] font-medium text-faint">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.03em] text-fg sm:text-[32px]">
            {greeting()}
            {session?.user?.username ? `, ${session.user.username}` : ''}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            {d ? (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn('size-1.5 rounded-full', d.paperless.connected ? 'bg-success' : 'bg-danger')} />
                  {d.paperless.connected ? `Paperless-ngx ${d.paperless.version ?? ''}` : 'Paperless-ngx unreachable'}
                </span>
                <span className="text-faint">·</span>
                <span>
                  {d.ai.provider} · {d.ai.model}
                </span>
              </>
            ) : (
              <Skeleton className="h-4 w-56" />
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {update.data?.updateAvailable && (
            <a href={update.data.url ?? 'https://github.com/clusterzx/paperless-ai/releases'} target="_blank" rel="noreferrer">
              <Badge tone="info" className="px-2.5 py-1">
                Update available: v{update.data.latest} <ArrowUpRight className="size-3" />
              </Badge>
            </a>
          )}
          {d?.rag.enabled && (
            <Link href="/ask" className={buttonClass({ variant: 'secondary' })}>
              <Sparkles className="size-4 text-accent" /> Ask your archive
            </Link>
          )}
          <Button variant="primary" icon={<ScanSearch className="size-4" />} loading={scanning || Boolean(live?.scanning)} onClick={scan}>
            Scan now
          </Button>
        </div>
      </header>

      {dash.error && (
        <Alert tone="danger" className="mb-6">
          {dash.error}
        </Alert>
      )}
      {d && !d.paperless.connected && (
        <Alert tone="danger" className="mb-6" title="Paperless-ngx is not reachable">
          {d.paperless.error} – check the{' '}
          <Link href="/settings" className="underline">
            connection settings
          </Link>
          .
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Coverage */}
        <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-6 shadow-card lg:col-span-5">
          <div className="aurora pointer-events-none absolute inset-0 opacity-60" />
          <div className="relative">
            <div className="flex items-center gap-2 text-[13px] font-medium text-muted">
              <Bot className="size-4 text-accent" /> Organised by AI
            </div>
            {d ? (
              <>
                <div className="mt-3 flex items-end gap-3">
                  <span className="text-gradient text-[56px] leading-none font-semibold tracking-[-0.04em] tabular-nums">{pct}%</span>
                  <span className="mb-1.5 text-sm text-muted">
                    {formatNumber(processed)} of {formatNumber(total)} documents
                  </span>
                </div>
                <div className="mt-6">
                  <SegmentBar slices={coverage} onSelect={(l) => setProblems(l === 'Failed' ? 'failed' : l === 'Skipped' ? 'skipped' : null)} />
                </div>
              </>
            ) : (
              <Skeleton className="mt-4 h-36" />
            )}
          </div>
        </section>

        {/* Live processing */}
        <div className="lg:col-span-7">{live ? <LiveStatus status={live} onChange={setStatus} /> : <Skeleton className="h-full min-h-56 rounded-2xl" />}</div>

        {/* KPIs */}
        <div className="grid grid-cols-2 gap-4 lg:col-span-12 lg:grid-cols-4">
          {d ? (
            <>
              <Stat label="Documents" value={formatNumber(d.paperless.documents)} icon={<FileText />} hint={d.paperless.apiVersion ? `API v${d.paperless.apiVersion}` : undefined} />
              <Stat label="Processed (30 days)" value={formatNumber(last30)} icon={<Activity />}>
                <Sparkline values={timeline.map((t) => t.value)} className="mt-3" />
              </Stat>
              <Stat
                label="Tags · Correspondents"
                value={
                  <span>
                    {formatNumber(d.paperless.tags)} <span className="text-faint">·</span> {formatNumber(d.paperless.correspondents)}
                  </span>
                }
                icon={<Tags />}
                hint="Click for details"
                onClick={() => setMeta('tags')}
              />
              <Stat label="Tokens used" value={compactNumber(d.usage.totalTokens)} icon={<Coins />} hint={`${formatNumber(d.usage.calls)} AI requests`} />
            </>
          ) : (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[124px] rounded-2xl" />)
          )}
        </div>

        {/* Activity */}
        <Card
          className="lg:col-span-8"
          title="Activity"
          description={d ? `${formatNumber(last30)} documents processed in the last 30 days` : 'Documents processed per day'}
          icon={<Clock />}
        >
          {d ? <AreaChart data={timeline} height={210} formatLabel={(l) => formatDate(l)} /> : <Skeleton className="h-52" />}
        </Card>

        {/* Token usage */}
        <Card className="lg:col-span-4" title="Token usage" icon={<Coins />} description="Per analysed document">
          {d ? (
            d.usage.analyses ? (
              <div className="space-y-5">
                <dl className="grid grid-cols-3 gap-2">
                  {[
                    ['Prompt', d.usage.avgPromptTokens],
                    ['Answer', d.usage.avgCompletionTokens],
                    ['Total', d.usage.avgTotalTokens],
                  ].map(([l, v]) => (
                    <div key={l as string} className="rounded-xl bg-surface-2 px-3 py-2.5 ring-1 ring-border">
                      <dd className="text-[17px] font-semibold tracking-tight tabular-nums">{formatNumber(v as number)}</dd>
                      <dt className="text-[11px] text-muted">avg. {l}</dt>
                    </div>
                  ))}
                </dl>
                <HBars data={d.usage.distribution.map((x) => ({ label: `${x.range} tokens`, value: x.count }))} />
                {d.usage.avgDurationMs > 0 && <p className="text-xs text-muted">Average analysis time: {duration(d.usage.avgDurationMs)}</p>}
              </div>
            ) : (
              <EmptyState icon={<Coins />} title="No analyses yet" />
            )
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>

        <div className="lg:col-span-8">
          <RecentChanges />
        </div>

        <Card
          className="lg:col-span-4"
          title="Document types"
          description="Assigned by the AI"
          icon={<FileText />}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setMeta('documentTypes')}>
              All
            </Button>
          }
        >
          {d?.documentTypes.length ? <HBars data={d.documentTypes.map((t) => ({ label: t.name, value: t.count }))} color="var(--accent-2)" /> : <EmptyState icon={<FileText />} title="No data yet" />}
        </Card>
      </div>
      <ProblemsModal status={problems} onClose={() => setProblems(null)} />
      <MetadataModal initial={meta} onClose={() => setMeta(null)} />
    </Page>
  );
}
