import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowDown, ArrowUp, ArrowUpDown, Combine, Copy, Pencil, Plus, Sparkles, Tags, Trash2 } from 'lucide-react';
import type { MetadataItem, MetadataKindParam, SimilarMetadataGroup } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, PageHeader, Select, Skeleton, Tabs, tabPanelProps, useConfirm, useToast } from '../components/ui';
import { del, errorMessage, get, patch, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatNumber } from '../lib/format';
import { loadMetadata } from '../lib/metadata';

const KINDS: { id: MetadataKindParam; label: string; singular: string; filter: string }[] = [
  { id: 'tags', label: 'Tags', singular: 'tag', filter: 'tags' },
  { id: 'correspondents', label: 'Correspondents', singular: 'correspondent', filter: 'correspondent' },
  { id: 'document-types', label: 'Document types', singular: 'document type', filter: 'documentType' },
  { id: 'custom-fields', label: 'Custom fields', singular: 'custom field', filter: '' },
];
const FIELD_TYPES = ['string', 'longtext', 'integer', 'float', 'monetary', 'date', 'boolean', 'url', 'select', 'documentlink'];

type SortKey = 'name' | 'count';
type Sort = { key: SortKey; order: 'asc' | 'desc' };
const SORT_STORE = 'pai-metadata-sort';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The sort chosen last (kept in this browser); A–Z by default. */
function storedSort(): Sort {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_STORE) ?? 'null') as Sort | null;
    if (v && (v.key === 'name' || v.key === 'count') && (v.order === 'asc' || v.order === 'desc')) return v;
  } catch {
    // no storage (private window): the default
  }
  return { key: 'name', order: 'asc' };
}

function SortButton({ k, sort, onSort, children }: { k: SortKey; sort: Sort; onSort: (k: SortKey) => void; children: ReactNode }) {
  const active = sort.key === k;
  const direction = sort.order === 'asc' ? ' (ascending)' : ' (descending)';
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={`Sort by ${k === 'name' ? 'name' : 'number of documents'}${active ? direction : ''}`}
      className={cn('inline-flex items-center gap-1 tracking-wide uppercase hover:text-fg', active && 'text-fg')}
    >
      {children}
      {!active ? <ArrowUpDown className="size-3 opacity-50" /> : sort.order === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />}
    </button>
  );
}

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

const REASON_LABEL: Record<SimilarMetadataGroup['reason'], string> = {
  same: 'Same name',
  extends: 'One name continues the other – please check',
  spelling: 'Similar spelling',
  ai: 'Suggested by the AI',
};

/** Suggestions for objects that mean the same: merge them under one name, or mark them as different. */
function DuplicatesPanel({ kind, items, onChanged, onClose }: { kind: (typeof KINDS)[number]; items: MetadataItem[]; onChanged: () => void; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [groups, setGroups] = useState<SimilarMetadataGroup[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyOf = (g: SimilarMetadataGroup) => g.ids.join(',');
  const count = (id: number) => items.find((i) => i.id === id)?.document_count ?? 0;
  const load = async () => {
    setError(null);
    try {
      const res = await get<{ groups: SimilarMetadataGroup[] }>(`/api/${kind.id}/similar`);
      setGroups(res.groups);
      setNames(Object.fromEntries(res.groups.map((g) => [keyOf(g), g.suggested])));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind.id]);

  const mergeOne = async (g: SimilarMetadataGroup) => {
    const name = (names[keyOf(g)] ?? g.suggested).trim();
    const keepName = g.names[0];
    const res = await post<{ documents: number }>(`/api/${kind.id}/merge`, { targetId: g.keepId, sourceIds: g.ids.slice(1), ...(name && name !== keepName ? { name } : {}) });
    return res.documents;
  };
  /** Suggestions can overlap ("to check" ones span certain groups): after a merge they are computed anew; the AI's stay while their objects exist. */
  const refresh = async (merged: SimilarMetadataGroup[]) => {
    const gone = new Set(merged.flatMap((g) => g.ids.slice(1)));
    const ai = (groups ?? []).filter((g) => g.reason === 'ai' && !merged.some((m) => keyOf(m) === keyOf(g)) && !g.ids.some((i) => gone.has(i)));
    try {
      const res = await get<{ groups: SimilarMetadataGroup[] }>(`/api/${kind.id}/similar`);
      setGroups([...res.groups, ...ai]);
      setNames((n) => ({ ...Object.fromEntries(res.groups.map((g) => [keyOf(g), g.suggested])), ...n }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const obvious = (groups ?? []).filter((g) => g.reason === 'same' || g.reason === 'spelling');
  const merge = async (g: SimilarMetadataGroup) => {
    setBusy(keyOf(g));
    try {
      const n = await mergeOne(g);
      toast.success(`Merged into “${names[keyOf(g)] || g.suggested}” – ${formatNumber(n)} document(s) changed`);
      onChanged();
      await refresh([g]);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  /** Only the obvious ones (same name, spelling) – continuations and the AI's are checked one by one. */
  const mergeAll = async () => {
    const list = obvious;
    if (!(await confirm({ title: `Merge ${list.length} obvious group(s)?`, message: 'Same names apart from case, punctuation or legal form, typos and plurals – each under the name shown. Suggestions to check stay.', confirmLabel: 'Merge' }))) return;
    setBusy('all');
    let docs = 0;
    try {
      for (const g of list) docs += await mergeOne(g);
      toast.success(`${list.length} group(s) merged – ${formatNumber(docs)} document(s) changed`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
      onChanged();
      await refresh(list);
    }
  };
  const dismiss = async (g: SimilarMetadataGroup) => {
    try {
      await post(`/api/${kind.id}/similar/dismiss`, { ids: g.ids });
      setGroups((list) => (list ?? []).filter((x) => keyOf(x) !== keyOf(g)));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const askAi = async () => {
    setBusy('ai');
    try {
      const res = await post<{ groups: SimilarMetadataGroup[]; tokens: number }>(`/api/${kind.id}/similar/ai`, {});
      const known = new Set((groups ?? []).map(keyOf));
      const fresh = res.groups.filter((g) => !known.has(keyOf(g)));
      setGroups((list) => [...(list ?? []), ...fresh]);
      setNames((n) => ({ ...n, ...Object.fromEntries(fresh.map((g) => [keyOf(g), g.suggested])) }));
      toast.success(fresh.length ? `The AI found ${fresh.length} more group(s) (${formatNumber(res.tokens)} tokens)` : `The AI found nothing more (${formatNumber(res.tokens)} tokens)`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      className="mb-5"
      title={
        <div className="flex items-center gap-2">
          <Copy className="size-4" /> Possible duplicates
        </div>
      }
      description="Same name apart from case, punctuation or legal form (GmbH, AG …), one name continuing the other, typos and plurals. Nothing changes until you merge."
      actions={
        <>
          <Button size="sm" icon={<Sparkles className="size-4" />} loading={busy === 'ai'} disabled={Boolean(busy) && busy !== 'ai'} onClick={() => void askAi()} title="Only the names are sent to the AI">
            Ask the AI for more
          </Button>
          {obvious.length > 1 && (
            <Button size="sm" variant="primary" icon={<Combine className="size-4" />} loading={busy === 'all'} disabled={Boolean(busy) && busy !== 'all'} onClick={() => void mergeAll()}>
              Merge obvious ({obvious.length})
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {!groups ? (
        <Skeleton className="m-5 h-24" />
      ) : groups.length === 0 ? (
        <EmptyState title="No duplicates found">
          <p className="text-sm text-muted">The AI may still find some – it knows that “1&amp;1” and “1und1” are the same.</p>
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {groups.map((g) => (
            <li key={keyOf(g)} className="space-y-2 px-5 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {g.ids.map((id, i) => (
                  <Badge key={id}>
                    {g.names[i]} · {formatNumber(count(id))}
                  </Badge>
                ))}
                <span className="text-xs text-muted">{REASON_LABEL[g.reason]}</span>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Merge as" className="min-w-56 flex-1">
                  <Input list={`names-${keyOf(g)}`} value={names[keyOf(g)] ?? g.suggested} onChange={(e) => setNames({ ...names, [keyOf(g)]: e.target.value })} aria-label={`Name for ${g.names.join(', ')}`} />
                  <datalist id={`names-${keyOf(g)}`}>
                    {g.names.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </Field>
                <Button size="sm" variant="primary" icon={<Combine className="size-4" />} loading={busy === keyOf(g)} disabled={Boolean(busy) || !(names[keyOf(g)] ?? g.suggested).trim()} onClick={() => void merge(g)}>
                  Merge
                </Button>
                <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void dismiss(g)}>
                  Not the same
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
  const [duplicates, setDuplicates] = useState(false);
  const data = useAsync((signal) => get<MetadataItem[]>(`/api/${kind.id}`, signal), [kind.id]);
  const [sort, setSort] = useState<Sort>(storedSort);
  const onSort = (key: SortKey) => {
    // The same column again: the other direction; another column: A–Z, or the most used first.
    const next: Sort = sort.key === key ? { key, order: sort.order === 'asc' ? 'desc' : 'asc' } : { key, order: key === 'count' ? 'desc' : 'asc' };
    setSort(next);
    try {
      localStorage.setItem(SORT_STORE, JSON.stringify(next));
    } catch {
      // not kept – fine
    }
  };
  const items = useMemo(() => {
    const dir = sort.order === 'asc' ? 1 : -1;
    const byName = (a: MetadataItem, b: MetadataItem) => collator.compare(a.name, b.name);
    return (data.data ?? [])
      .filter((i) => !find || i.name.toLowerCase().includes(find.toLowerCase()))
      .sort((a, b) => (sort.key === 'count' ? ((a.document_count ?? 0) - (b.document_count ?? 0)) * dir || byName(a, b) : byName(a, b) * dir));
  }, [data.data, find, sort]);
  const allShown = items.length > 0 && items.every((i) => selected.has(i.id));
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
        {duplicates && kind.id !== 'custom-fields' && <DuplicatesPanel key={kind.id} kind={kind} items={data.data ?? []} onChanged={reload} onClose={() => setDuplicates(false)} />}
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
              {kind.id !== 'custom-fields' && !duplicates && (
                <Button size="sm" icon={<Copy className="size-4" />} onClick={() => setDuplicates(true)}>
                  Find duplicates
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
            <>
              <div className="flex items-center gap-3 border-b border-border px-5 py-2 text-xs font-medium text-muted">
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allShown}
                  ref={(el) => {
                    if (el) el.indeterminate = !allShown && items.some((i) => selected.has(i.id));
                  }}
                  onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
                />
                <div className="min-w-0 flex-1">
                  <SortButton k="name" sort={sort} onSort={onSort}>
                    Name
                  </SortButton>
                </div>
                <SortButton k="count" sort={sort} onSort={onSort}>
                  Documents
                </SortButton>
                <span className="w-[4.75rem] shrink-0" aria-hidden />
              </div>
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
            </>
          )}
        </Card>
      </div>
      {edit && <EditModal kind={kind} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {merging && <MergeModal kind={kind} items={selectedItems} onClose={() => setMerging(false)} onDone={reload} />}
    </Page>
  );
}
