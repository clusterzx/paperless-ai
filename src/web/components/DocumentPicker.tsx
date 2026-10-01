import { useState } from 'react';
import { CheckCircle2, FileText, Search, XCircle } from 'lucide-react';
import type { DocumentSummary } from '@shared/api';
import { get, qs } from '../lib/api';
import { useAsync, useDebounced } from '../lib/hooks';
import { cn, formatDate } from '../lib/format';
import type { MetadataLookup } from '../lib/metadata';
import { Alert, Input, Pagination, Skeleton } from './ui';

type Doc = DocumentSummary & { status?: string | null };

/** Searchable list of Paperless documents. */
export function DocumentPicker({
  selected,
  onSelect,
  meta,
  pageSize = 12,
}: {
  selected: number | null;
  onSelect: (id: number) => void;
  meta: MetadataLookup;
  pageSize?: number;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(query, 300);
  const list = useAsync((signal) => get<{ count: number; results: Doc[] }>(`/api/documents${qs({ query: q, page, pageSize })}`, signal), [q, page, pageSize]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input
          className="pl-9"
          placeholder="Search title and content…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {list.error && <Alert tone="danger">{list.error}</Alert>}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {list.loading && !list.data
          ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-14" />)
          : list.data?.results.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => onSelect(d.id)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition',
                    selected === d.id ? 'bg-accent-soft' : 'hover:bg-surface-2',
                  )}
                >
                  <FileText className={cn('mt-0.5 size-4 shrink-0', selected === d.id ? 'text-accent' : 'text-faint')} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{d.title || `Document ${d.id}`}</div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      #{d.id} · {formatDate(d.created)}
                      {d.correspondent ? ` · ${meta.correspondentName(d.correspondent) ?? ''}` : ''}
                    </div>
                  </div>
                  {d.status === 'processed' && <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-accent" aria-label="Processed by AI" />}
                  {d.status === 'failed' && <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Processing failed" />}
                </button>
              </li>
            ))}
        {list.data && !list.data.results.length && <li className="px-3 py-6 text-center text-sm text-muted">No documents found</li>}
      </ul>
      {list.data && list.data.count > pageSize && (
        <div className="mt-3 border-t border-border pt-3">
          <Pagination page={page} pageSize={pageSize} total={list.data.count} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
