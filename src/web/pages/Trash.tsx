import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { DocumentRow } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Button, EmptyState, PageHeader, Skeleton, useConfirm, useToast } from '../components/ui';
import { DocumentThumb } from '../components/documents';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatDate, timeAgo } from '../lib/format';
import { useMetadata } from '../lib/metadata';

type TrashRow = DocumentRow & { deletedAt: number; deletedBy: string | null; purgeAt: number | null };

export default function TrashPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMetadata();
  const trash = useAsync((signal) => get<TrashRow[]>('/api/trash', signal), []);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const rows = trash.data ?? [];
  const ids = selected.size ? [...selected] : rows.map((r) => r.id);

  const restore = async (list: number[]) => {
    setBusy(true);
    try {
      await post('/api/documents/bulk', { ids: list, action: 'restore' });
      toast.success(`${list.length} document(s) restored`);
      setSelected(new Set());
      await trash.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const purge = async (list: number[]) => {
    if (!(await confirm({ title: `Delete ${list.length} document(s) for good?`, message: 'The files and everything recorded about them are removed. This cannot be undone.', confirmLabel: 'Delete for good', danger: true })))
      return;
    setBusy(true);
    try {
      const res = await post<{ purged: number; failed: { error: string }[] }>('/api/trash/purge', { ids: list });
      if (res.failed.length) toast.error(res.failed[0].error);
      if (res.purged) toast.success(`${res.purged} document(s) deleted for good`);
      setSelected(new Set());
      await trash.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Trash"
        description="Deleted documents stay here for a while – the library decides how long – and can be restored."
        actions={
          rows.length > 0 && (
            <>
              <Button icon={<RotateCcw className="size-4" />} disabled={busy} onClick={() => restore(ids)}>
                Restore {selected.size ? selected.size : 'all'}
              </Button>
              <Button variant="ghost" icon={<Trash2 className="size-4" />} disabled={busy} onClick={() => purge(ids)}>
                Delete {selected.size ? selected.size : 'all'} for good
              </Button>
            </>
          )
        }
      />
      {trash.error && <Alert tone="danger">{trash.error}</Alert>}
      {!trash.data ? (
        <Skeleton className="h-48 rounded-2xl" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Trash2 className="size-6" />} title="The trash is empty" />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-3">
              <input
                type="checkbox"
                aria-label={`Select ${r.title}`}
                checked={selected.has(r.id)}
                onChange={(e) =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(r.id);
                    else n.delete(r.id);
                    return n;
                  })
                }
              />
              <DocumentThumb id={r.id} className="h-12 w-9 shrink-0 rounded border border-border" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.title}</div>
                <div className="text-xs text-muted">
                  {formatDate(r.created)}
                  {r.correspondent ? ` · ${meta.correspondentName(r.correspondent)}` : ''} · deleted {timeAgo(r.deletedAt)}
                  {r.deletedBy ? ` by ${r.deletedBy}` : ''}
                  {r.purgeAt ? ` · gone for good ${formatDate(r.purgeAt)}` : ''}
                </div>
              </div>
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={busy} onClick={() => restore([r.id])}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
