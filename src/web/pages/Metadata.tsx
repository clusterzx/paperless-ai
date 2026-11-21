import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { Combine, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import type { MetadataItem, MetadataKindParam } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, Tabs, tabPanelProps, useConfirm, useToast } from '../components/ui';
import { del, errorMessage, get, patch, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatNumber } from '../lib/format';
import { loadMetadata } from '../lib/metadata';

const KINDS: { id: MetadataKindParam; label: string; singular: string; filter: string }[] = [
  { id: 'tags', label: 'Tags', singular: 'tag', filter: 'tags' },
  { id: 'correspondents', label: 'Correspondents', singular: 'correspondent', filter: 'correspondent' },
  { id: 'document-types', label: 'Document types', singular: 'document type', filter: 'documentType' },
  { id: 'custom-fields', label: 'Custom fields', singular: 'custom field', filter: '' },
];
const FIELD_TYPES = ['string', 'longtext', 'integer', 'float', 'monetary', 'date', 'boolean', 'url', 'select', 'documentlink'];

function EditModal({ kind, item, onClose, onSaved }: { kind: (typeof KINDS)[number]; item: MetadataItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(item?.name ?? '');
  const [color, setColor] = useState(item?.color ?? '#6366f1');
  const [dataType, setDataType] = useState('string');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      if (item) await patch(`/api/${kind.id}/${item.id}`, { name: name.trim(), ...(kind.id === 'tags' ? { color } : {}) });
      else await post(`/api/${kind.id}`, { name: name.trim(), ...(kind.id === 'tags' ? { color } : {}), ...(kind.id === 'custom-fields' ? { dataType } : {}) });
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={item ? `Rename ${kind.singular}` : `New ${kind.singular}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        {kind.id === 'tags' && (
          <Field label="Colour">
            <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-20 p-1" />
          </Field>
        )}
        {kind.id === 'custom-fields' && !item && (
          <Field label="Type">
            <Select value={dataType} onChange={(e) => setDataType(e.target.value)}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function MergeModal({ kind, items, onClose, onDone }: { kind: (typeof KINDS)[number]; items: MetadataItem[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [target, setTarget] = useState(items[0]?.id ?? 0);
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    setBusy(true);
    try {
      const res = await post<{ documents: number }>(`/api/${kind.id}/merge`, { sourceIds: items.map((i) => i.id).filter((i) => i !== target), targetId: target });
      toast.success(`Merged – ${formatNumber(res.documents)} document(s) changed`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Merge ${items.length} ${kind.label.toLowerCase()}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={merge}>
            Merge
          </Button>
        </>
      }
    >
      <Field label="Keep" hint="The documents of the others get this one instead; the others are deleted.">
        <Select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({formatNumber(i.document_count)})
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  );
}

export default function MetadataPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const search = useSearch();
  const [, navigate] = useLocation();
  const kindId = (new URLSearchParams(search).get('kind') as MetadataKindParam | null) ?? 'tags';
  const kind = KINDS.find((k) => k.id === kindId) ?? KINDS[0];
  const [find, setFind] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [edit, setEdit] = useState<MetadataItem | null | 'new'>(null);
  const [merging, setMerging] = useState(false);
  const data = useAsync((signal) => get<MetadataItem[]>(`/api/${kind.id}`, signal), [kind.id]);
  const items = useMemo(() => (data.data ?? []).filter((i) => !find || i.name.toLowerCase().includes(find.toLowerCase())), [data.data, find]);
  const reload = () => {
    setSelected(new Set());
    void data.reload();
    void loadMetadata(true);
  };
  const remove = async (item: MetadataItem) => {
    if (
      !(await confirm({
        title: `Delete “${item.name}”?`,
        message: item.document_count ? `It is removed from ${formatNumber(item.document_count)} document(s).` : 'No document uses it.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await del(`/api/${kind.id}/${item.id}`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const selectedItems = (data.data ?? []).filter((i) => selected.has(i.id));
  return (
    <Page>
      <PageHeader title="Tags & metadata" description="Rename, merge and clean up what the AI and you have created." />
      <Tabs
        id="metadata"
        value={kind.id}
        onChange={(k) => {
          setSelected(new Set());
          navigate(`/metadata?kind=${k}`, { replace: true });
        }}
        tabs={KINDS.map((k) => ({ id: k.id, label: k.label }))}
      />
      <div className="mt-5" {...tabPanelProps('metadata', kind.id)}>
        <Card
          bodyClassName="p-0"
          title={
            <div className="flex items-center gap-2">
              <Tags className="size-4" /> {formatNumber(data.data?.length ?? 0)} {kind.label.toLowerCase()}
            </div>
          }
          actions={
            <>
              <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find…" className="h-8 w-48 text-sm" aria-label="Find" />
              {selected.size > 1 && (
                <Button size="sm" icon={<Combine className="size-4" />} onClick={() => setMerging(true)}>
                  Merge {selected.size}
                </Button>
              )}
              <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>
                New
              </Button>
            </>
          }
        >
          {data.error && <Alert tone="danger">{data.error}</Alert>}
          {!data.data ? (
            <Skeleton className="m-5 h-40" />
          ) : items.length === 0 ? (
            <EmptyState title={find ? 'Nothing found' : `No ${kind.label.toLowerCase()} yet`} />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Select ${i.name}`}
                    checked={selected.has(i.id)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(i.id);
                        else n.delete(i.id);
                        return n;
                      })
                    }
                  />
                  {i.color && <span className="size-3 shrink-0 rounded-full" style={{ background: i.color }} />}
                  <span className="min-w-0 flex-1 truncate font-medium">{i.name}</span>
                  {i.data_type && <Badge>{i.data_type}</Badge>}
                  {kind.filter ? (
                    <Link href={`/documents?${kind.filter}=${i.id}`} className="text-xs text-muted tabular-nums hover:text-fg hover:underline">
                      {formatNumber(i.document_count)} documents
                    </Link>
                  ) : (
                    <span className="text-xs text-muted tabular-nums">{formatNumber(i.document_count)} documents</span>
                  )}
                  <IconButton label="Rename" onClick={() => setEdit(i)}>
                    <Pencil className="size-4" />
                  </IconButton>
                  <IconButton label="Delete" onClick={() => remove(i)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {edit && <EditModal kind={kind} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {merging && <MergeModal kind={kind} items={selectedItems} onClose={() => setMerging(false)} onDone={reload} />}
    </Page>
  );
}
