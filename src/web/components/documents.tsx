/**
 * Building blocks of the document pages: thumbnails, tag chips, status, filter ↔ URL helpers.
 */
import { useState, type ReactNode } from 'react';
import { CheckCircle2, CircleAlert, CircleDashed, FileText, MinusCircle } from 'lucide-react';
import type { DocumentFilterParams, DocumentRow, DocumentSortKey, DocumentStatus } from '@shared/api';
import { Badge } from './ui';
import { cn } from '../lib/format';
import { useSession } from '../lib/session';

/** The archive mode and capabilities (null while not configured). */
export function useArchive() {
  const { session } = useSession();
  return session?.archive ?? null;
}

export function DocumentThumb({ id, className, alt = '' }: { id: number; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('flex items-center justify-center overflow-hidden bg-surface-2', className)}>
      {failed ? (
        <FileText className="size-6 text-faint" />
      ) : (
        <img src={`/api/documents/${id}/thumb`} alt={alt} loading="lazy" className="h-full w-full object-cover object-top" onError={() => setFailed(true)} />
      )}
    </div>
  );
}

export function TagChips({ ids, name, max = 4, className }: { ids: number[]; name: (id: number) => string; max?: number; className?: string }) {
  if (!ids.length) return null;
  const shown = ids.slice(0, max);
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {shown.map((t) => (
        <Badge key={t}>{name(t)}</Badge>
      ))}
      {ids.length > max && <Badge title={ids.slice(max).map(name).join(', ')}>+{ids.length - max}</Badge>}
    </div>
  );
}

const STATUS: Record<DocumentStatus, { label: string; icon: ReactNode; className: string }> = {
  processed: { label: 'Analysed by the AI', icon: <CheckCircle2 className="size-4" />, className: 'text-success' },
  failed: { label: 'Analysis failed', icon: <CircleAlert className="size-4" />, className: 'text-danger' },
  skipped: { label: 'Skipped', icon: <MinusCircle className="size-4" />, className: 'text-muted' },
};

export function StatusIcon({ status }: { status: DocumentRow['status'] }) {
  const s = status ? STATUS[status] : { label: 'Not analysed yet', icon: <CircleDashed className="size-4" />, className: 'text-faint' };
  return (
    <span title={s.label} aria-label={s.label} className={s.className}>
      {s.icon}
    </span>
  );
}

export interface ListState extends DocumentFilterParams {
  sort?: DocumentSortKey;
  view?: 'table' | 'grid';
}

const KEYS: (keyof ListState)[] = ['q', 'tags', 'tagsAll', 'tagsNone', 'correspondent', 'documentType', 'storagePath', 'library', 'createdFrom', 'createdTo', 'addedFrom', 'addedTo', 'cf', 'sort', 'view'];

export function stateFromSearch(search: string): ListState {
  const p = new URLSearchParams(search);
  const out: ListState = {};
  for (const k of KEYS) {
    const v = p.get(k);
    if (v) (out as Record<string, string>)[k] = v;
  }
  return out;
}

export function searchFromState(s: ListState): string {
  const p = new URLSearchParams();
  for (const k of KEYS) {
    const v = s[k];
    if (v) p.set(k, String(v));
  }
  const str = p.toString();
  return str ? `?${str}` : '';
}

/** Filter parameters of the API (without the UI-only keys). */
export function apiParams(s: ListState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    if (k === 'view') continue;
    const v = s[k];
    if (v) out[k] = String(v);
  }
  return out;
}

export function idSet(v: string | undefined): number[] {
  return v ? v.split(',').filter(Boolean).map(Number) : [];
}

export function toggleId(v: string | undefined, id: number): string | undefined {
  const ids = new Set(idSet(v));
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return ids.size ? [...ids].join(',') : undefined;
}

export const SORT_OPTIONS: { value: DocumentSortKey; label: string }[] = [
  { value: '-created', label: 'Date (newest)' },
  { value: 'created', label: 'Date (oldest)' },
  { value: '-added', label: 'Added (newest)' },
  { value: 'added', label: 'Added (oldest)' },
  { value: 'title', label: 'Title (A–Z)' },
  { value: '-title', label: 'Title (Z–A)' },
  { value: '-modified', label: 'Last changed' },
  { value: 'relevance', label: 'Relevance (search)' },
];
