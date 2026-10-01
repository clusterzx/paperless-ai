import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowDown, ArrowUp, ExternalLink, Eye, History as HistoryIcon, MessageSquareText, RefreshCw, RotateCcw, Search, Undo2 } from 'lucide-react';
import type { HistoryPage as HistoryPageData } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Pagination, Select, Skeleton, Switch, useConfirm, useToast } from '../components/ui';
import { errorMessage, get, post, qs } from '../lib/api';
import { useAsync, useDebounced } from '../lib/hooks';
import { cn, formatDate, formatNumber } from '../lib/format';
import { useMetadata } from '../lib/metadata';

type Item = HistoryPageData['items'][number];
type SortKey = 'createdAt' | 'documentId' | 'title' | 'correspondent';

function DetailModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const meta = useMetadata();
  if (!item) return null;
  const b = item.before;
  const a = item.after as Record<string, unknown>;
  const tagNames = (ids?: unknown) => (Array.isArray(ids) ? ids.map((id) => meta.tagName(Number(id))).join(', ') : '–');
  const rows: [string, string, string | null][] = [
    ['Title', b.title ?? '–', (a.title as string) ?? null],
    ['Tags', tagNames(b.tags), a.tags ? tagNames(a.tags) : null],
    ['Correspondent', meta.correspondentName(b.correspondent) ?? '–', a.correspondent !== undefined ? (meta.correspondentName(a.correspondent as number) ?? item.correspondent ?? '–') : null],
    ['Document type', meta.documentTypeName(b.document_type) ?? '–', a.document_type !== undefined ? (meta.documentTypeName(a.document_type as number) ?? item.documentType ?? '–') : null],
    ['Date', b.created ?? '–', (a.created as string) ?? null],
  ];
  return (
    <Modal open onClose={onClose} title={`Document #${item.documentId}`} size="lg">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge>{formatDate(item.createdAt, true)}</Badge>
          <Badge tone="info">{item.source}</Badge>
          {item.model && <Badge>{item.model}</Badge>}
          {item.totalTokens > 0 && <Badge>{formatNumber(item.totalTokens)} tokens</Badge>}
          {item.revertedAt && <Badge tone="warn">reverted {formatDate(item.revertedAt, true)}</Badge>}
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="w-32 pb-2 font-medium">Field</th>
              <th className="pb-2 font-medium">Before</th>
              <th className="pb-2 font-medium">After</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(([label, before, after]) => (
              <tr key={label} className="align-top">
                <td className="py-2 text-muted">{label}</td>
                <td className="py-2 pr-3 break-words">{before}</td>
                <td className={cn('py-2 break-words', after !== null && after !== before ? 'font-medium text-accent-text' : 'text-faint')}>{after ?? 'unchanged'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {Boolean(item.suggestion) && (
          <details>
            <summary className="cursor-pointer text-xs font-medium text-muted">Raw AI suggestion</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs">{JSON.stringify(item.suggestion, null, 2)}</pre>
          </details>
        )}
      </div>
    </Modal>
  );
}

export default function HistoryPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [correspondent, setCorrespondent] = useState('');
  const [includeReverted, setIncludeReverted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<{ key: SortKey; order: 'asc' | 'desc' }>({ key: 'createdAt', order: 'desc' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useDebounced(search, 300);

  const filters = useAsync(() => get<{ tags: { id: number; name: string }[]; correspondents: string[] }>('/api/history/filters'), []);
  const data = useAsync(
    (signal) =>
      get<HistoryPageData>(
        `/api/history${qs({ page, pageSize, search: q, tag, correspondent, sort: sort.key, order: sort.order, includeReverted: includeReverted || undefined })}`,
        signal,
      ),
    [page, pageSize, q, tag, correspondent, sort, includeReverted],
  );
  const items = useMemo(() => data.data?.items ?? [], [data.data]);
  const selectedDocs = useMemo(() => [...new Set(items.filter((i) => selected.has(i.id)).map((i) => i.documentId))], [items, selected]);
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  const sortBy = (key: SortKey) => setSort((s) => ({ key, order: s.key === key && s.order === 'desc' ? 'asc' : 'desc' }));
  const SortHead = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={cn('px-3 py-2.5 font-medium', className)}>
      <button className="inline-flex items-center gap-1 hover:text-fg" onClick={() => sortBy(k)}>
        {children}
        {sort.key === k && (sort.order === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
      </button>
    </th>
  );

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setSelected(new Set());
      await data.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revert = (docIds: number[]) =>
    act(async () => {
      if (
        !(await confirm({
          title: `Undo AI changes of ${docIds.length} document(s)?`,
          message: 'Title, tags, correspondent, document type, date and custom fields are restored to the values before the first AI change. The documents will not be processed automatically again.',
          confirmLabel: 'Undo changes',
          danger: true,
        }))
      )
        return;
      const res = await post<{ results: { documentId: number; ok: boolean; error?: string }[] }>('/api/history/revert', { documentIds: docIds });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) toast.error(`${failed.length} could not be restored: ${failed[0].error}`);
      if (res.results.length - failed.length) toast.success(`${res.results.length - failed.length} document(s) restored`);
    });

  const reprocess = (docIds: number[]) =>
    act(async () => {
      if (!(await confirm({ title: `Process ${docIds.length} document(s) again?`, message: 'The documents are analyzed again with the current settings and prompt.', confirmLabel: 'Process again' }))) return;
      const res = await post<{ queued: number }>('/api/processing/documents', { ids: docIds });
      toast.success(`${res.queued} document(s) queued`);
    });

  const resetAll = () =>
    act(async () => {
      if (
        !(await confirm({
          title: 'Reset processing state of all documents?',
          message: 'Paperless-AI forgets which documents it has processed. With automatic processing enabled, ALL matching documents will be analyzed again (this may cost tokens). The history is kept.',
          confirmLabel: 'Reset all',
          danger: true,
        }))
      )
        return;
      const res = await post<{ reset: number }>('/api/history/reset', { all: true });
      toast.success(`Processing state of ${res.reset} document(s) reset`);
    });

  return (
    <Page wide>
      <PageHeader
        title="History"
        description="Every change the AI made – with undo. Reverting restores the original values in Paperless."
        actions={
          <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={resetAll} disabled={busy}>
            Reset all
          </Button>
        }
      />
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input
              className="pl-9"
              placeholder="Search title, correspondent, type or ID…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select className="w-44" value={tag} onChange={(e) => (setTag(e.target.value), setPage(1))} aria-label="Tag">
            <option value="">All tags</option>
            {filters.data?.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Select className="w-48" value={correspondent} onChange={(e) => (setCorrespondent(e.target.value), setPage(1))} aria-label="Correspondent">
            <option value="">All correspondents</option>
            {filters.data?.correspondents.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <div className="px-2">
            <Switch label={<span className="text-xs font-normal text-muted">Show reverted</span>} checked={includeReverted} onChange={(v) => (setIncludeReverted(v), setPage(1))} />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-soft/50 px-3 py-2 text-sm">
            <span className="font-medium">{selectedDocs.length} document(s) selected</span>
            <Button size="sm" variant="danger" icon={<Undo2 className="size-3.5" />} onClick={() => revert(selectedDocs)} loading={busy}>
              Undo AI changes
            </Button>
            <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => reprocess(selectedDocs)} disabled={busy}>
              Process again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {data.error && <Alert tone="danger" className="m-3">{data.error}</Alert>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <thead className="border-b border-border bg-surface-2/60 text-left text-xs text-muted">
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
                <SortHead k="documentId" className="w-20">
                  ID
                </SortHead>
                <SortHead k="title">Title</SortHead>
                <th className="px-3 py-2.5 font-medium">Tags</th>
                <SortHead k="correspondent">Correspondent</SortHead>
                <SortHead k="createdAt" className="w-40">
                  Changed
                </SortHead>
                <th className="w-36 px-3 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.loading && !data.data
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i}>
                      <td colSpan={7} className="p-3">
                        <Skeleton className="h-6" />
                      </td>
                    </tr>
                  ))
                : items.map((i: Item) => (
                    <tr key={i.id} className={cn('align-top transition hover:bg-surface-2/50', i.revertedAt && 'opacity-60', selected.has(i.id) && 'bg-accent-soft/30')}>
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          className="accent-[var(--accent)]"
                          aria-label={`Select ${i.title}`}
                          checked={selected.has(i.id)}
                          onChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(i.id)) n.delete(i.id);
                              else n.add(i.id);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="px-3 py-3 text-muted tabular-nums">#{i.documentId}</td>
                      <td className="max-w-[22rem] px-3 py-3">
                        <div className="font-medium text-fg">{i.title ?? '–'}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {i.documentType && <Badge tone="info">{i.documentType}</Badge>}
                          <Badge>{i.source}</Badge>
                          {i.revertedAt && <Badge tone="warn">reverted</Badge>}
                        </div>
                      </td>
                      <td className="max-w-[18rem] px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {i.tagNames.length ? i.tagNames.map((t) => <Badge key={t}>{t}</Badge>) : <span className="text-faint">–</span>}
                        </div>
                      </td>
                      <td className="px-3 py-3">{i.correspondent ?? <span className="text-faint">–</span>}</td>
                      <td className="px-3 py-3 text-xs text-muted">{formatDate(i.createdAt, true)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-0.5">
                          <Button size="sm" variant="ghost" aria-label="Details" title="Details" onClick={() => setDetail(i)}>
                            <Eye className="size-4" />
                          </Button>
                          <Button size="sm" variant="ghost" aria-label="Chat" title="Chat about this document" onClick={() => navigate(`/chat?doc=${i.documentId}`)}>
                            <MessageSquareText className="size-4" />
                          </Button>
                          <a href={i.url} target="_blank" rel="noreferrer">
                            <Button size="sm" variant="ghost" aria-label="Open in Paperless" title="Open in Paperless">
                              <ExternalLink className="size-4" />
                            </Button>
                          </a>
                          {i.canRevert && (
                            <Button size="sm" variant="ghost" aria-label="Undo" title="Undo AI changes" onClick={() => revert([i.documentId])}>
                              <Undo2 className="size-4 text-danger" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {data.data && !items.length && (
            <EmptyState icon={<HistoryIcon className="size-5" />} title="No entries">
              {data.data.total ? 'No entries match your filters.' : 'Changes made by the AI will appear here.'}
            </EmptyState>
          )}
        </div>
        {data.data && data.data.filtered > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-3">
            <Select className="h-8 w-28 py-0 text-xs" value={pageSize} onChange={(e) => (setPageSize(Number(e.target.value)), setPage(1))} aria-label="Page size">
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
            <div className="flex-1">
              <Pagination page={page} pageSize={pageSize} total={data.data.filtered} onPage={setPage} />
            </div>
          </div>
        )}
      </Card>
      <DetailModal item={detail} onClose={() => setDetail(null)} />
    </Page>
  );
}

