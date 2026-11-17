import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ExternalLink, Eye, Gauge, RefreshCw, ScanText, Search, Settings2, Undo2, Wand2 } from 'lucide-react';
import type { OcrDocumentItem, OcrDocumentText, OcrFilter, OcrListResponse, OcrStatus, TextQualityLevel } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Input, LinkButton, Modal, PageHeader, Pagination, Select, Skeleton, Tabs, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post, qs } from '../lib/api';
import { useAsync, useDebounced, useInterval } from '../lib/hooks';
import { cn, duration, formatDate, formatNumber, timeAgo } from '../lib/format';

const LEVEL_TONE: Record<TextQualityLevel, 'danger' | 'warn' | 'info' | 'success'> = { missing: 'danger', poor: 'danger', fair: 'warn', good: 'success' };
const LEVEL_LABEL: Record<TextQualityLevel, string> = { missing: 'No text', poor: 'Poor', fair: 'Fair', good: 'Good' };
const BAR: Record<TextQualityLevel, string> = { missing: 'bg-danger', poor: 'bg-danger', fair: 'bg-warn', good: 'bg-success' };

const FILTER_TABS: { id: OcrFilter; label: string }[] = [
  { id: 'needs', label: 'Needs OCR' },
  { id: 'missing', label: 'No text' },
  { id: 'poor', label: 'Poor' },
  { id: 'fair', label: 'Fair' },
  { id: 'good', label: 'Good' },
  { id: 'done', label: 'OCR done' },
  { id: 'failed', label: 'Failed' },
  { id: 'all', label: 'All' },
];

const MODE_LABEL: Record<string, string> = {
  manual: 'manual only',
  missing: 'automatic for documents without text',
  poor: 'automatic for documents without or with poor text',
  always: 'automatic for every document',
};

function QualityCell({ item }: { item: OcrDocumentItem }) {
  const q = item.quality;
  return (
    <div className="min-w-[9rem]" title={q.reasons.join('\n') || undefined}>
      <div className="flex items-center gap-2">
        <Badge tone={LEVEL_TONE[q.level]}>{LEVEL_LABEL[q.level]}</Badge>
        <span className="text-xs text-faint tabular-nums">{q.score}/100</span>
      </div>
      <div className="mt-1.5 h-1.5 w-28 overflow-hidden rounded-full bg-surface-3">
        <div className={cn('h-full rounded-full', BAR[q.level])} style={{ width: `${Math.max(q.score, 3)}%` }} />
      </div>
      {q.reasons[0] && <div className="mt-1 max-w-[16rem] truncate text-[11px] text-faint">{q.reasons[0]}</div>}
    </div>
  );
}

function OcrCell({ item }: { item: OcrDocumentItem }) {
  if (item.job?.state === 'running') {
    return (
      <Badge tone="info">
        <RefreshCw className="size-3 animate-spin" />
        {item.job.reading ? `Reading${item.job.pages ? ` page ${item.job.page}/${item.job.pages}` : '…'}` : 'AI analysis…'}
      </Badge>
    );
  }
  if (item.job?.state === 'queued') return <Badge tone="info">Queued</Badge>;
  const r = item.ocr;
  if (!r) return <span className="text-faint">–</span>;
  if (r.status === 'failed') {
    return (
      <div className="max-w-[16rem]">
        <Badge tone="danger">Failed</Badge>
        <div className="mt-1 truncate text-[11px] text-danger" title={r.error ?? undefined}>
          {r.error}
        </div>
      </div>
    );
  }
  return (
    <div className="text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <Badge tone={r.revertedAt ? 'warn' : 'success'}>{r.revertedAt ? 'Reverted' : r.writtenBack ? 'Saved in Paperless' : 'Done'}</Badge>
        {r.provider && <Badge>{r.provider.toUpperCase()}</Badge>}
      </div>
      <div className="mt-1 text-faint" title={formatDate(r.at, true)}>
        {formatNumber(r.chars)} chars · {r.meanScore !== null ? `${Math.round(r.meanScore * 100)} % conf.` : ''}
        {r.durationMs !== null ? ` · ${duration(r.durationMs)}` : ''} · {timeAgo(r.at)}
        {r.totalPages && r.pages && r.totalPages > r.pages ? ` · first ${r.pages}/${r.totalPages} pages` : ''}
      </div>
    </div>
  );
}

function TextModal({ id, onClose, onRevert }: { id: number | null; onClose: () => void; onRevert: (id: number) => void }) {
  const data = useAsync((signal) => (id ? get<OcrDocumentText>(`/api/ocr/documents/${id}`, signal) : Promise.resolve(null)), [id]);
  const d = data.data;
  return (
    <Modal
      open={id !== null}
      onClose={onClose}
      size="xl"
      title={d ? `#${d.id} ${d.title}` : 'Document text'}
      footer={
        d?.ocr?.status === 'done' && !d.ocr.revertedAt ? (
          <Button variant="danger" icon={<Undo2 className="size-4" />} onClick={() => onRevert(d.id)}>
            Revert OCR text
          </Button>
        ) : undefined
      }
    >
      {data.error && <Alert tone="danger">{data.error}</Alert>}
      {!d ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {[
            { label: 'Text in Paperless', text: d.paperlessText, extra: <Badge tone={LEVEL_TONE[d.quality.level]}>{`${LEVEL_LABEL[d.quality.level]} · ${d.quality.score}/100`}</Badge> },
            { label: 'PaddleOCR result', text: d.ocrText, extra: d.ocr?.writtenBack && !d.ocr.revertedAt ? <Badge tone="success">saved in Paperless</Badge> : null },
          ].map((col) => (
            <div key={col.label} className="min-w-0">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-faint uppercase">
                {col.label}
                {col.extra}
              </div>
              <pre className="max-h-[55vh] overflow-auto rounded-xl border border-border bg-surface-2 p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
                {col.text?.trim() ? col.text : <span className="text-faint">(no text)</span>}
              </pre>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function OcrPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<OcrFilter>('needs');
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const status = useAsync((signal) => get<OcrStatus>('/api/ocr/status', signal), []);
  const list = useAsync((signal) => get<OcrListResponse>(`/api/ocr/documents${qs({ filter, search: q || undefined, page, pageSize })}`, signal), [filter, q, page, pageSize]);
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  useEffect(() => setSelected(new Set()), [filter, q, page, pageSize]);

  const s = status.data;
  // Fast refresh while anything runs – the status and every listed document are checked, so a
  // moment between two jobs never looks like "idle".
  const working = Boolean((s && (s.queue > 0 || s.active || s.analysis.running)) || items.some((i) => i.job));
  // Live progress while something is running; otherwise refresh now and then.
  useInterval(
    () => {
      void status.reload();
      void list.reload();
    },
    working ? 2000 : 30_000,
  );

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([status.reload(), list.reload()]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const run = (body: { ids?: number[]; filter?: OcrFilter }, count: number) =>
    act(async () => {
      const writeBack = s?.writeBack ?? true;
      const ok = await confirm({
        title: `Read ${count} document(s) with OCR?`,
        message: `PaddleOCR reads the documents${writeBack ? ' and replaces their text in Paperless (can be reverted)' : ''}. Afterwards they run through the AI analysis again (title, tags, correspondent, …).`,
        confirmLabel: 'Start OCR',
      });
      if (!ok) return;
      const res = await post<{ queued: number }>('/api/ocr/run', body);
      setSelected(new Set());
      toast.success(`${res.queued} document(s) queued for OCR`);
    });

  const revert = (id: number) =>
    act(async () => {
      const ok = await confirm({
        title: 'Revert the OCR text?',
        message: 'The text Paperless had before the OCR is restored. Title, tags etc. set by the AI stay – undo them in the history if needed.',
        confirmLabel: 'Revert',
        danger: true,
      });
      if (!ok) return;
      await post(`/api/ocr/documents/${id}/revert`);
      setDetail(null);
      toast.success('OCR text reverted');
    });

  const counts = list.data?.counts;
  const disabled = s && !s.enabled;

  return (
    <Page wide>
      <PageHeader
        title="OCR"
        description="Find documents whose text is missing or garbled and read them again with PaddleOCR – locally, on CPU or GPU. Afterwards the AI names and tags them."
        actions={
          <>
            <Button variant="ghost" icon={<RefreshCw className={cn('size-4', s?.analysis.running && 'animate-spin')} />} onClick={() => act(() => post('/api/ocr/assess', { full: true }).then(() => undefined))} disabled={busy || s?.analysis.running}>
              Re-check text quality
            </Button>
            <Button
              variant="primary"
              icon={<Wand2 className="size-4" />}
              disabled={busy || disabled || !counts?.needs}
              onClick={() => run({ filter: 'needs' }, counts?.needs ?? 0)}
            >
              OCR all that need it{counts?.needs ? ` (${formatNumber(counts.needs)})` : ''}
            </Button>
          </>
        }
      />

      {s && !s.available && (
        <Alert tone="danger" className="mb-4" title="OCR is not available">
          The OCR libraries (onnxruntime-node, sharp, @hyzyla/pdfium) are not installed in this installation.
        </Alert>
      )}
      {disabled && (
        <Alert
          tone="warn"
          className="mb-4"
          title="OCR is disabled"
          action={
            <Link href="/settings?tab=ocr" className="self-center text-sm font-medium text-accent-text hover:underline">
              Enable in settings
            </Link>
          }
        >
          The text quality is still checked, but no document is read until OCR is enabled.
        </Alert>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="sm:col-span-2" bodyClassName="flex h-full flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-sm">
          <span className="flex items-center gap-2">
            <Settings2 className="size-4 text-faint" /> Mode: <b className="font-medium">{s ? MODE_LABEL[s.mode] ?? s.mode : '…'}</b>
          </span>
          <span>
            Text in Paperless: <b className="font-medium">{s?.writeBack ? 'replaced (with undo)' : 'unchanged'}</b>
          </span>
          <span>
            Device: <b className="font-medium">{s?.provider ? s.provider.toUpperCase() : 'loaded on first use'}</b>
          </span>
          <Link href="/settings?tab=ocr" className="ml-auto text-xs text-accent-text hover:underline">
            OCR settings
          </Link>
        </Card>
        <Card bodyClassName="flex h-full items-center px-5 py-4 text-sm">
          {s?.active ? (
            <div>
              <div className="flex items-center gap-2 font-medium">
                <ScanText className="size-4 animate-pulse text-accent" /> Reading #{s.active.documentId}
                {s.active.pages ? ` – page ${s.active.page}/${s.active.pages}` : ''}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">{s.active.title}</div>
              {s.queue > 0 && <div className="mt-1 text-xs text-faint">{s.queue} more queued</div>}
            </div>
          ) : s?.analysis.running ? (
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-accent" /> Checking text quality {s.analysis.total ? `${s.analysis.done}/${s.analysis.total}` : '…'}
            </div>
          ) : s?.queue ? (
            <div>{s.queue} document(s) queued (processing paused or busy)</div>
          ) : (
            <div className="text-muted">
              Idle{s?.analysis.lastAt ? ` · quality checked ${timeAgo(s.analysis.lastAt)}` : ''}
              {s?.analysis.error && <div className="mt-1 text-xs text-danger">{s.analysis.error}</div>}
            </div>
          )}
        </Card>
      </div>

      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-3 p-4">
          <Tabs
            id="ocr-filter"
            value={filter}
            onChange={(v) => (setFilter(v), setPage(1))}
            tabs={FILTER_TABS.map((t) => ({ id: t.id, label: `${t.label}${counts ? ` ${formatNumber(counts[t.id])}` : ''}` }))}
          />
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input className="pl-9" placeholder="Search title or ID…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="animate-pop fixed inset-x-0 bottom-5 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-full border border-border bg-surface/90 py-2 pr-2 pl-5 text-sm shadow-pop backdrop-blur-xl lg:ml-[calc(50%+126px)] lg:-translate-x-1/2">
            <span className="mr-1 font-medium">{selected.size} document(s) selected</span>
            <Button size="sm" variant="primary" icon={<ScanText className="size-3.5" />} onClick={() => run({ ids: [...selected] }, selected.size)} loading={busy} disabled={disabled}>
              Run OCR
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {list.error && <Alert tone="danger" className="m-3">{list.error}</Alert>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-y border-border bg-surface-2/70 text-left text-[11px] tracking-wide text-faint uppercase">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="accent-[var(--accent)]"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
                  />
                </th>
                <th className="w-20 px-3 py-2.5 font-medium">ID</th>
                <th className="px-3 py-2.5 font-medium">Title</th>
                <th className="px-3 py-2.5 font-medium">Text quality</th>
                <th className="px-3 py-2.5 font-medium">OCR</th>
                <th className="w-36 px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.loading && !list.data
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i}>
                      <td colSpan={6} className="p-3">
                        <Skeleton className="h-6" />
                      </td>
                    </tr>
                  ))
                : items.map((i) => (
                    <tr key={i.id} className={cn('group align-top transition hover:bg-surface-2/60', selected.has(i.id) && 'bg-accent-soft/40')}>
                      <td className="px-3 py-3.5">
                        <input
                          type="checkbox"
                          className="accent-[var(--accent)]"
                          aria-label={`Select ${i.title}`}
                          checked={selected.has(i.id)}
                          onChange={() =>
                            setSelected((cur) => {
                              const n = new Set(cur);
                              if (n.has(i.id)) n.delete(i.id);
                              else n.add(i.id);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-3.5 font-mono text-xs text-faint">#{i.id}</td>
                      <td className="max-w-[24rem] px-3 py-3.5">
                        <div className="truncate font-medium text-fg">{i.title || '–'}</div>
                        <div className="mt-0.5 text-xs text-faint">
                          {i.created ? formatDate(i.created) : ''}
                          {i.pages ? ` · ${i.pages} page${i.pages === 1 ? '' : 's'}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-3.5">
                        <QualityCell item={i} />
                      </td>
                      <td className="px-3 py-3.5">
                        <OcrCell item={i} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-0.5 opacity-70 transition group-focus-within:opacity-100 group-hover:opacity-100">
                          <Button size="sm" variant="ghost" aria-label="Show text" title="Compare the texts" onClick={() => setDetail(i.id)}>
                            <Eye className="size-4" />
                          </Button>
                          <Button size="sm" variant="ghost" aria-label="Run OCR" title="Read with OCR" disabled={disabled || Boolean(i.job)} onClick={() => run({ ids: [i.id] }, 1)}>
                            <ScanText className="size-4" />
                          </Button>
                          <LinkButton href={i.url} size="sm" variant="ghost" aria-label="Open in Paperless" title="Open in Paperless">
                            <ExternalLink className="size-4" />
                          </LinkButton>
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {list.data && !items.length && (
            <EmptyState icon={<ScanText className="size-5" />} title={list.data.counts.all ? 'No documents in this view' : 'No documents checked yet'}>
              {list.data.counts.all
                ? filter === 'needs'
                  ? 'Every document has usable text. 🎉'
                  : 'Try another filter.'
                : s?.analysis.running
                  ? 'The text quality of your documents is being checked…'
                  : 'Click “Re-check text quality” to look at all documents.'}
            </EmptyState>
          )}
        </div>
        {list.data && list.data.total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
            <Select className="h-8 w-28 py-0 text-xs" value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))} aria-label="Page size">
              {[25, 50, 100, 200].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
            <div className="flex-1">
              <Pagination page={page} pageSize={pageSize} total={list.data.total} onPage={setPage} />
            </div>
          </div>
        )}
      </Card>
      <TextModal id={detail} onClose={() => setDetail(null)} onRevert={revert} />
    </Page>
  );
}
