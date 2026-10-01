import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CircleCheck,
  Clock,
  Coins,
  FileText,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  Tags,
  Users,
} from 'lucide-react';
import type { DashboardData, ProcessingStatus } from '@shared/api';
import { Page } from '../components/Layout';
import { Bars, Donut, HBars, Legend, type Slice } from '../components/charts';
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, Segmented, Skeleton, Stat, useToast } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { useAsync, useInterval } from '../lib/hooks';
import { compactNumber, duration, formatDate, formatNumber, timeAgo } from '../lib/format';

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
          value={kind}
          onChange={setKind}
          options={[
            { value: 'tags', label: `Tags (${data.data?.tags.length ?? '…'})` },
            { value: 'correspondents', label: `Correspondents (${data.data?.correspondents.length ?? '…'})` },
            { value: 'documentTypes', label: `Types (${data.data?.documentTypes.length ?? '…'})` },
          ]}
        />
      </div>
      <input className="input mb-3" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
  const [scanning, setScanning] = useState(false);
  const [problems, setProblems] = useState<'failed' | 'skipped' | null>(null);
  const scan = async () => {
    setScanning(true);
    try {
      const res = await post<{ queued: number }>('/api/processing/scan');
      toast.success(res.queued ? `${res.queued} new document(s) queued for analysis` : 'Scan finished – no new documents');
      onChange(await get<ProcessingStatus>('/api/processing/status'));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setScanning(false);
    }
  };
  const togglePause = async () => {
    try {
      onChange(await post<ProcessingStatus>(status.paused ? '/api/processing/resume' : '/api/processing/pause'));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const busy = status.running || status.scanning;
  return (
    <Card
      title="Processing"
      icon={<Activity className="size-4" />}
      description={status.automatic ? `Automatic · next scan ${status.nextScanAt ? timeAgo(status.nextScanAt) : '–'}` : 'Automatic processing is off'}
      actions={
        <>
          <Button size="sm" variant="ghost" icon={status.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />} onClick={togglePause}>
            {status.paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="primary" icon={<ScanSearch className="size-3.5" />} loading={scanning || status.scanning} onClick={scan}>
            Scan now
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {status.current.length ? (
          <ul className="space-y-2">
            {status.current.map((j) => (
              <li key={j.documentId} className="flex items-center gap-3 rounded-lg bg-accent-soft/60 px-3 py-2.5">
                <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
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
        ) : (
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-3 text-sm text-muted">
            {status.paused ? <Pause className="size-4" /> : <CircleCheck className="size-4 text-accent" />}
            {status.paused ? 'Paused' : busy ? 'Scanning Paperless…' : 'Idle – waiting for new documents'}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Queue</dt>
            <dd className="font-semibold tabular-nums">{status.queued}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Processed today</dt>
            <dd className="font-semibold tabular-nums">{status.processedToday}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Last scan</dt>
            <dd className="font-semibold">{timeAgo(status.lastScanAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Last document</dt>
            <dd className="truncate font-semibold" title={status.lastProcessed?.title ?? ''}>
              {status.lastProcessed ? timeAgo(status.lastProcessed.processedAt) : '–'}
            </dd>
          </div>
        </dl>
        {(status.counts.failed > 0 || status.counts.skipped > 0) && (
          <div className="flex flex-wrap gap-2">
            {status.counts.failed > 0 && (
              <button onClick={() => setProblems('failed')} className="inline-flex items-center gap-1.5 rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs font-medium text-danger hover:brightness-95">
                <AlertTriangle className="size-3.5" /> {status.counts.failed} failed
              </button>
            )}
            {status.counts.skipped > 0 && (
              <button onClick={() => setProblems('skipped')} className="inline-flex items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-fg">
                {status.counts.skipped} skipped
              </button>
            )}
          </div>
        )}
        {status.lastError && <Alert tone="warn">{status.lastError}</Alert>}
      </div>
      <ProblemsModal status={problems} onClose={() => setProblems(null)} />
    </Card>
  );
}

export default function DashboardPage() {
  const dash = useAsync(() => get<DashboardData>('/api/dashboard'), []);
  const update = useAsync(() => get<{ updateAvailable: boolean; latest: string | null; url: string | null }>('/api/update-check'), []);
  const [status, setStatus] = useState<ProcessingStatus | null>(null);
  const [meta, setMeta] = useState<MetaKind | null>(null);
  useInterval(() => {
    get<ProcessingStatus>('/api/processing/status')
      .then(setStatus)
      .catch(() => undefined);
  }, 3000);
  useInterval(() => void dash.reload(), 60_000);

  const d = dash.data;
  const live = status ?? d?.processing;
  const coverage: Slice[] = useMemo(() => {
    if (!d || !live) return [];
    const processed = live.counts.processed;
    const failed = live.counts.failed;
    const skipped = live.counts.skipped;
    const open = Math.max(0, d.paperless.documents - processed - failed - skipped);
    return [
      { label: 'Processed by AI', value: processed, color: 'var(--accent)' },
      { label: 'Not processed yet', value: open, color: 'var(--border-strong)' },
      { label: 'Skipped', value: skipped, color: 'var(--info)' },
      { label: 'Failed', value: failed, color: 'var(--danger)' },
    ];
  }, [d, live]);

  const timeline = useMemo(() => {
    if (!d) return [];
    const map = new Map(d.timeline.map((t) => [t.date, t.count]));
    const out: { label: string; value: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      out.push({ label: key, value: map.get(key) ?? 0 });
    }
    return out;
  }, [d]);

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description={d ? `AI: ${d.ai.provider} · ${d.ai.model}` : undefined}
        actions={
          update.data?.updateAvailable && (
            <a href={update.data.url ?? 'https://github.com/clusterzx/paperless-ai/releases'} target="_blank" rel="noreferrer">
              <Badge tone="info" className="px-2.5 py-1">
                Update available: v{update.data.latest} <ArrowUpRight className="size-3" />
              </Badge>
            </a>
          )
        }
      />
      {dash.error && <Alert tone="danger" className="mb-6">{dash.error}</Alert>}
      {d && !d.paperless.connected && (
        <Alert tone="danger" className="mb-6" title="Paperless-ngx is not reachable">
          {d.paperless.error} – check the <Link href="/settings" className="underline">connection settings</Link>.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {d ? (
          <>
            <Stat label="Documents" value={formatNumber(d.paperless.documents)} icon={<FileText className="size-4" />} hint={d.paperless.version ? `Paperless-ngx ${d.paperless.version}` : undefined} />
            <Stat
              label="Processed by AI"
              value={formatNumber(live?.counts.processed ?? 0)}
              icon={<Bot className="size-4" />}
              hint={d.paperless.documents ? `${Math.round(((live?.counts.processed ?? 0) / d.paperless.documents) * 100)}% of all documents` : undefined}
            />
            <Stat
              label="Tags · Correspondents"
              value={
                <span>
                  {formatNumber(d.paperless.tags)} <span className="text-faint">·</span> {formatNumber(d.paperless.correspondents)}
                </span>
              }
              icon={<Tags className="size-4" />}
              hint="Click for details"
              onClick={() => setMeta('tags')}
            />
            <Stat label="Tokens used" value={compactNumber(d.usage.totalTokens)} icon={<Coins className="size-4" />} hint={`${formatNumber(d.usage.calls)} AI requests`} />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">{live ? <LiveStatus status={live} onChange={setStatus} /> : <Skeleton className="h-64 rounded-xl" />}</div>
        <Card title="Coverage" icon={<CircleCheck className="size-4" />}>
          {d ? (
            <div className="flex flex-col items-center gap-5 sm:flex-row lg:flex-col">
              <Donut
                slices={coverage}
                center={
                  <>
                    <div className="text-xl font-semibold tabular-nums">
                      {d.paperless.documents ? Math.round(((live?.counts.processed ?? 0) / d.paperless.documents) * 100) : 0}%
                    </div>
                    <div className="text-[11px] text-muted">processed</div>
                  </>
                }
              />
              <div className="w-full min-w-0 flex-1">
                <Legend slices={coverage} />
              </div>
            </div>
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Activity" description="Documents processed per day (30 days)" icon={<Clock className="size-4" />} className="lg:col-span-2">
          {d ? <Bars data={timeline} height={220} formatLabel={(l) => formatDate(l)} /> : <Skeleton className="h-36" />}
        </Card>
        <Card title="Token usage" icon={<Coins className="size-4" />} description="Per analysed document">
          {d ? (
            d.usage.analyses ? (
              <div className="space-y-4">
                <dl className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ['Prompt', d.usage.avgPromptTokens],
                    ['Answer', d.usage.avgCompletionTokens],
                    ['Total', d.usage.avgTotalTokens],
                  ].map(([l, v]) => (
                    <div key={l as string} className="rounded-lg bg-surface-2 py-2">
                      <dd className="font-semibold tabular-nums">{formatNumber(v as number)}</dd>
                      <dt className="text-[11px] text-muted">avg. {l}</dt>
                    </div>
                  ))}
                </dl>
                <HBars data={d.usage.distribution.map((x) => ({ label: `${x.range} tokens`, value: x.count }))} />
                {d.usage.avgDurationMs > 0 && <p className="text-xs text-muted">Average analysis time: {duration(d.usage.avgDurationMs)}</p>}
              </div>
            ) : (
              <EmptyState title="No analyses yet" />
            )
          ) : (
            <Skeleton className="h-36" />
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="Document types" description="Assigned by the AI" icon={<FileText className="size-4" />} actions={<Button size="sm" variant="ghost" onClick={() => setMeta('documentTypes')}>All</Button>}>
          {d?.documentTypes.length ? <HBars data={d.documentTypes.map((t) => ({ label: t.name, value: t.count }))} color="var(--info)" /> : <EmptyState title="No data yet" />}
        </Card>
        <Card title="Quick actions" icon={<Users className="size-4" />} className="lg:col-span-2" bodyClassName="grid gap-3 sm:grid-cols-2">
          {[
            { href: '/ask', title: 'Ask your archive', text: 'Questions in natural language, answers with sources.', hidden: !d?.rag.enabled },
            { href: '/review', title: 'Review a document', text: 'Let the AI suggest metadata and decide yourself.' },
            { href: '/playground', title: 'Tune the prompt', text: 'Try prompts on sample documents without saving.' },
            { href: '/history', title: 'History & undo', text: 'See every change and restore original values.' },
          ]
            .filter((a) => !a.hidden)
            .map((a) => (
              <Link key={a.href} href={a.href} className="group rounded-xl border border-border p-4 transition hover:border-accent hover:bg-accent-soft/40">
                <div className="flex items-center justify-between font-medium text-fg">
                  {a.title}
                  <ArrowUpRight className="size-4 text-faint transition group-hover:text-accent" />
                </div>
                <p className="mt-1 text-sm text-muted">{a.text}</p>
              </Link>
            ))}
        </Card>
      </div>
      <MetadataModal initial={meta} onClose={() => setMeta(null)} />
    </Page>
  );
}
