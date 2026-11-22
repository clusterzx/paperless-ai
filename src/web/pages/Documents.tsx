import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import {
  Bookmark,
  CheckSquare,
  FileUp,
  Filter,
  LayoutGrid,
  List,
  RefreshCw,
  ScanText,
  Search,
  Play,
  Sparkles,
  Square,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import type { BulkEditInput, BulkEditResult, DocumentFacetsResponse, DocumentListResponse, DocumentRow, SavedView, SearchInterpretation } from '@shared/api';
import { DocumentSearchBox } from '../components/searchBox';
import { parseSearch } from '@shared/searchSyntax';
import { Page } from '../components/Layout';
import { RunWorkflowModal } from '../components/workflowEditor';
import { Alert, Badge, Button, EmptyState, Field, IconButton, Input, LinkButton, Modal, PageHeader, Select, SlideOver, Skeleton, TagInput, useConfirm, useToast } from '../components/ui';
import { apiParams, DocumentThumb, idSet, searchFromState, SORT_OPTIONS, stateFromSearch, StatusIcon, TagChips, toggleId, useArchive, type ListState } from '../components/documents';
import { errorMessage, get, post, qs } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { cn, formatDate, formatNumber } from '../lib/format';
import { useMetadata, type MetadataLookup } from '../lib/metadata';
import { useLiveEvents } from '../lib/live';
import { useSession } from '../lib/session';

const PAGE = 50;

// ---------------------------------------------------------------- filters

function FacetList({
  title,
  items,
  selected,
  onToggle,
  extra,
}: {
  title: string;
  items: { id: number; name: string; count: number }[];
  selected: number[];
  onToggle: (id: number) => void;
  extra?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const [find, setFind] = useState('');
  const sorted = [...items].sort((a, b) => Number(selected.includes(b.id)) - Number(selected.includes(a.id)) || b.count - a.count || a.name.localeCompare(b.name));
  const filtered = find ? sorted.filter((i) => i.name.toLowerCase().includes(find.toLowerCase())) : sorted;
  const shown = all || find ? filtered : filtered.slice(0, 8);
  if (!items.length && !extra) return null;
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {items.length > 12 && <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find…" className="mb-1.5 h-8 text-sm" aria-label={`Find ${title}`} />}
      <ul className="space-y-0.5">
        {shown.map((i) => {
          const on = selected.includes(i.id);
          return (
            <li key={i.id}>
              <button
                type="button"
                onClick={() => onToggle(i.id)}
                aria-pressed={on}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition hover:bg-surface-2', on && 'bg-accent-soft text-accent-text')}
              >
                {on ? <CheckSquare className="size-3.5 shrink-0" /> : <Square className="size-3.5 shrink-0 text-faint" />}
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                <span className="text-xs text-muted tabular-nums">{formatNumber(i.count)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {extra}
      {!find && filtered.length > 8 && (
        <button type="button" className="mt-1 px-2 text-xs text-accent-text hover:underline" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${filtered.length}`}
        </button>
      )}
    </section>
  );
}

function Filters({ state, set, facets, meta }: { state: ListState; set: (patch: Partial<ListState>) => void; facets: DocumentFacetsResponse | null; meta: MetadataLookup }) {
  const archive = useArchive();
  const count = (list: { id: number; count: number }[] | undefined, id: number) => list?.find((x) => x.id === id)?.count ?? 0;
  const withCounts = (items: { id: number; name: string }[], list: { id: number; count: number }[] | undefined, selected: number[]) =>
    items.filter((i) => count(list, i.id) > 0 || selected.includes(i.id)).map((i) => ({ id: i.id, name: i.name, count: count(list, i.id) }));
  const libraries = useMemo(() => (facets?.libraries ?? []).map((l) => ({ id: l.id, name: `Library ${l.id}`, count: l.count })), [facets]);
  return (
    <div className="space-y-5">
      {archive?.capabilities.libraries && libraries.length > 1 && (
        <FacetList title="Library" items={libraries} selected={idSet(state.library)} onToggle={(id) => set({ library: toggleId(state.library, id) })} />
      )}
      <FacetList title="Tags" items={withCounts(meta.tags, facets?.tags, idSet(state.tags))} selected={idSet(state.tags)} onToggle={(id) => set({ tags: toggleId(state.tags, id) })} />
      <FacetList
        title="Correspondent"
        items={withCounts(meta.correspondents, facets?.correspondents, state.correspondent === 'none' ? [] : idSet(state.correspondent))}
        selected={state.correspondent === 'none' ? [] : idSet(state.correspondent)}
        onToggle={(id) => set({ correspondent: toggleId(state.correspondent === 'none' ? undefined : state.correspondent, id) })}
        extra={
          <button type="button" className={cn('mt-0.5 px-2 text-xs hover:underline', state.correspondent === 'none' ? 'text-accent-text' : 'text-muted')} onClick={() => set({ correspondent: state.correspondent === 'none' ? undefined : 'none' })}>
            {state.correspondent === 'none' ? '✓ ' : ''}Without correspondent
          </button>
        }
      />
      <FacetList
        title="Document type"
        items={withCounts(meta.documentTypes, facets?.documentTypes, state.documentType === 'none' ? [] : idSet(state.documentType))}
        selected={state.documentType === 'none' ? [] : idSet(state.documentType)}
        onToggle={(id) => set({ documentType: toggleId(state.documentType === 'none' ? undefined : state.documentType, id) })}
      />
      <section>
        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Date</h3>
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" aria-label="From" value={state.createdFrom ?? ''} onChange={(e) => set({ createdFrom: e.target.value || undefined })} className="h-8 text-sm" />
          <Input type="date" aria-label="To" value={state.createdTo ?? ''} onChange={(e) => set({ createdTo: e.target.value || undefined })} className="h-8 text-sm" />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- bulk actions

type BulkKind = 'addTags' | 'removeTags' | 'correspondent' | 'documentType';

function BulkEditModal({ kind, meta, onClose, onApply }: { kind: BulkKind; meta: MetadataLookup; onClose: () => void; onApply: (edit: BulkEditInput['edit']) => void }) {
  const [tags, setTags] = useState<string[]>([]);
  const [value, setValue] = useState('');
  const titles: Record<BulkKind, string> = { addTags: 'Add tags', removeTags: 'Remove tags', correspondent: 'Set the correspondent', documentType: 'Set the document type' };
  const listId = `bulk-${kind}`;
  const options = kind === 'correspondent' ? meta.correspondents : meta.documentTypes;
  return (
    <Modal
      open
      onClose={onClose}
      title={titles[kind]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={kind === 'addTags' || kind === 'removeTags' ? !tags.length : false}
            onClick={() => onApply(kind === 'addTags' ? { addTags: tags } : kind === 'removeTags' ? { removeTags: tags } : { [kind]: value.trim() || null })}
          >
            Apply
          </Button>
        </>
      }
    >
      {kind === 'addTags' || kind === 'removeTags' ? (
        <Field label="Tags" hint={kind === 'addTags' ? 'New tags are created.' : undefined}>
          <TagInput value={tags} onChange={setTags} suggestions={meta.tags.map((t) => t.name)} />
        </Field>
      ) : (
        <Field label={kind === 'correspondent' ? 'Correspondent' : 'Document type'} hint="Empty removes it. A new name is created.">
          <Input list={listId} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o.id} value={o.name} />
            ))}
          </datalist>
        </Field>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- page

export default function DocumentsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMetadata();
  const archive = useArchive();
  const { session } = useSession();
  const search = useSearch();
  const [, navigate] = useLocation();
  const state = useMemo(() => stateFromSearch(search), [search]);
  const set = useCallback((patch: Partial<ListState>) => navigate(`/documents${searchFromState({ ...state, ...patch })}`, { replace: true }), [navigate, state]);
  const [text, setText] = useState(state.q ?? '');
  const q = useDebounced(text, 350);
  useEffect(() => {
    // Relevance only for words to search for – tag:, created: … alone keep the date order.
    const words = Boolean(q && parseSearch(q).text);
    if ((q || undefined) !== state.q) set({ q: q || undefined, sort: words && !state.sort ? 'relevance' : state.sort === 'relevance' && !words ? undefined : state.sort });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const params = useMemo(() => apiParams(state), [state]);
  /** The search has words to rank by (not only tag:, created: …). */
  const searchWords = Boolean(state.q && parseSearch(state.q).text);
  const key = JSON.stringify(params);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [count, setCount] = useState<number | null>(null);
  /** How the server understood tag:, title: … of the search. */
  const [interpretation, setInterpretation] = useState<SearchInterpretation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<DocumentFacetsResponse | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [runWorkflow, setRunWorkflow] = useState(false);
  const [allMatching, setAllMatching] = useState(false);
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const view = state.view ?? 'table';
  const generation = useRef(0);

  const load = useCallback(
    async (append: string | null = null) => {
      const gen = append ? generation.current : ++generation.current;
      setLoading(true);
      try {
        const res = await get<DocumentListResponse>(`/api/documents${qs({ ...params, limit: PAGE, cursor: append ?? undefined, count: !append })}`);
        if (gen !== generation.current) return;
        setRows((r) => (append ? [...r, ...res.results] : res.results));
        setCursor(res.nextCursor);
        if (!append) {
          setCount(res.count);
          setInterpretation(res.search ?? []);
        }
        setError(null);
        setStale(false);
      } catch (err) {
        if (gen === generation.current) setError(errorMessage(err));
      } finally {
        if (gen === generation.current) setLoading(false);
      }
    },
    [params],
  );

  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    void load();
    get<DocumentFacetsResponse>(`/api/documents/facets${qs(params)}`).then(setFacets, () => setFacets(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Infinite scroll: load the next page when the sentinel becomes visible.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !cursor) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !loading) void load(cursor);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [cursor, loading, load]);

  useLiveEvents((e) => {
    if (e.type.startsWith('document.')) setStale(true);
  });

  const views = useMemoAsync(() => get<SavedView[]>('/api/saved-views'), []);
  const saveView = async () => {
    const name = window.prompt('Name of the view');
    if (!name?.trim()) return;
    try {
      await post('/api/saved-views', { name: name.trim(), filter: { ...params, ...(state.sort ? { sort: state.sort } : {}) }, inNavigation: true });
      toast.success('View saved – it is in the navigation now');
      views.reload();
      window.dispatchEvent(new Event('saved-views-changed'));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const target = (): Pick<BulkEditInput, 'ids' | 'filter'> => (allMatching ? { filter: params } : { ids: [...selected] });
  const targetCount = allMatching ? (count ?? selected.size) : selected.size;
  const runBulk = async (input: Omit<BulkEditInput, 'ids' | 'filter'>, label: string) => {
    setBusy(true);
    try {
      const res = await post<BulkEditResult>('/api/documents/bulk', { ...target(), ...input });
      if (res.failed.length) toast.error(`${label}: ${res.failed.length} failed – ${res.failed[0].error}`);
      else toast.success(`${label}: ${formatNumber(res.ok)} document(s)`);
      setSelected(new Set());
      setAllMatching(false);
      meta.reload();
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const allOnScreen = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allOnScreen ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      setAllMatching(false);
      return n;
    });

  const activeFilters = Object.keys(params).filter((k) => k !== 'sort' && k !== 'q').length;
  const admin = session?.user?.role === 'admin';

  return (
    <Page wide>
      <PageHeader
        title="Documents"
        description={count !== null ? `${formatNumber(count)} document${count === 1 ? '' : 's'}${activeFilters || state.q ? ' match' : ''}` : 'Your archive'}
        actions={
          <>
            <LinkButton href="/inbox" icon={<FileUp className="size-4" />}>
              Upload
            </LinkButton>
            <Button variant="ghost" icon={<Bookmark className="size-4" />} onClick={saveView} disabled={!activeFilters && !state.q}>
              Save view
            </Button>
          </>
        }
      />
      {views.data && views.data.length > 0 && (
        <div className="-mt-2 mb-4 flex flex-wrap gap-2">
          {views.data.map((v) => (
            <button
              key={v.id}
              type="button"
              className="rounded-full border border-border px-3 py-1 text-sm text-muted transition hover:border-accent hover:text-fg"
              onClick={() => navigate(`/documents${searchFromState(v.filter)}`)}
            >
              {v.name}
            </button>
          ))}
        </div>
      )}
      <div className="lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8">
        <aside className="hidden lg:block">
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pr-1">
            <Filters state={state} set={set} facets={facets} meta={meta} />
          </div>
        </aside>
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <DocumentSearchBox value={text} onChange={setText} meta={meta} interpretation={interpretation} libraries={Boolean(archive?.capabilities.libraries)} />
            <Button className="lg:hidden" icon={<Filter className="size-4" />} onClick={() => setFiltersOpen(true)}>
              Filters{activeFilters ? ` (${activeFilters})` : ''}
            </Button>
            <Select aria-label="Sort" value={state.sort ?? (searchWords ? 'relevance' : '-created')} onChange={(e) => set({ sort: e.target.value as ListState['sort'] })} className="w-auto">
              {SORT_OPTIONS.filter((o) => o.value !== 'relevance' || searchWords).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <div className="flex rounded-xl border border-border p-0.5">
              <IconButton label="Table" aria-pressed={view === 'table'} onClick={() => set({ view: undefined })} className={cn(view === 'table' && 'bg-surface-2')}>
                <List className="size-4" />
              </IconButton>
              <IconButton label="Grid" aria-pressed={view === 'grid'} onClick={() => set({ view: 'grid' })} className={cn(view === 'grid' && 'bg-surface-2')}>
                <LayoutGrid className="size-4" />
              </IconButton>
            </div>
          </div>
          {activeFilters > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              {idSet(state.tags).map((t) => (
                <Badge key={`t${t}`} tone="accent">
                  <Tag className="size-3" /> {meta.tagName(t)}
                  <button type="button" aria-label="Remove filter" onClick={() => set({ tags: toggleId(state.tags, t) })}>
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
              {state.correspondent && (
                <Badge tone="accent">
                  {state.correspondent === 'none' ? 'Without correspondent' : idSet(state.correspondent).map((c) => meta.correspondentName(c)).join(', ')}
                  <button type="button" aria-label="Remove filter" onClick={() => set({ correspondent: undefined })}>
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
              {state.documentType && (
                <Badge tone="accent">
                  {idSet(state.documentType).map((c) => meta.documentTypeName(c)).join(', ')}
                  <button type="button" aria-label="Remove filter" onClick={() => set({ documentType: undefined })}>
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
              {(state.createdFrom || state.createdTo) && (
                <Badge tone="accent">
                  {state.createdFrom ? formatDate(state.createdFrom) : '…'} – {state.createdTo ? formatDate(state.createdTo) : '…'}
                  <button type="button" aria-label="Remove filter" onClick={() => set({ createdFrom: undefined, createdTo: undefined })}>
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
              <button type="button" className="text-xs text-muted hover:text-fg hover:underline" onClick={() => navigate(`/documents${searchFromState({ view: state.view })}`, { replace: true })}>
                Clear all
              </button>
            </div>
          )}
          {stale && (
            <Alert tone="info" className="mb-3" action={<Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={() => void load()}>Refresh</Button>}>
              Documents were added or changed.
            </Alert>
          )}
          {error && <Alert tone="danger">{error}</Alert>}

          {!error && !loading && rows.length === 0 ? (
            <EmptyState icon={<Search className="size-6" />} title={activeFilters || state.q ? 'No documents match' : 'No documents yet'}>
              {activeFilters || state.q ? 'Try fewer filters or another search.' : 'Upload your first documents in the inbox.'}
            </EmptyState>
          ) : view === 'grid' ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
              {rows.map((d) => (
                <div key={d.id} className={cn('group relative overflow-hidden rounded-2xl border bg-surface shadow-card transition hover:shadow-pop', selected.has(d.id) ? 'border-accent' : 'border-border')}>
                  <button type="button" className="absolute top-2 left-2 z-10 rounded bg-surface/90 p-0.5" aria-label="Select" onClick={() => toggle(d.id)}>
                    {selected.has(d.id) ? <CheckSquare className="size-4 text-accent" /> : <Square className="size-4 text-muted" />}
                  </button>
                  <Link href={`/documents/${d.id}`} className="block">
                    <DocumentThumb id={d.id} className="aspect-[3/4] border-b border-border" />
                    <div className="space-y-1 p-3">
                      <div className="line-clamp-2 text-sm font-medium">{d.title}</div>
                      <div className="flex items-center justify-between text-xs text-muted">
                        <span>{formatDate(d.created)}</span>
                        <StatusIcon status={d.status} />
                      </div>
                      <div className="truncate text-xs text-muted">{meta.correspondentName(d.correspondent) ?? ''}</div>
                    </div>
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border bg-surface shadow-card">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <button type="button" aria-label={allOnScreen ? 'Select none' : 'Select all'} onClick={toggleAll}>
                        {allOnScreen ? <CheckSquare className="size-4 text-accent" /> : <Square className="size-4" />}
                      </button>
                    </th>
                    <th className="px-2 py-2.5 font-medium">Title</th>
                    <th className="hidden px-2 py-2.5 font-medium md:table-cell">Correspondent</th>
                    <th className="hidden px-2 py-2.5 font-medium xl:table-cell">Type</th>
                    <th className="hidden px-2 py-2.5 font-medium lg:table-cell">Tags</th>
                    <th className="px-2 py-2.5 font-medium whitespace-nowrap">Date</th>
                    <th className="w-8 px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((d) => (
                    <tr key={d.id} className={cn('align-top transition hover:bg-surface-2/60', selected.has(d.id) && 'bg-accent-soft/40')}>
                      <td className="px-3 py-2.5">
                        <button type="button" aria-label="Select" onClick={() => toggle(d.id)}>
                          {selected.has(d.id) ? <CheckSquare className="size-4 text-accent" /> : <Square className="size-4 text-faint" />}
                        </button>
                      </td>
                      <td className="px-2 py-2">
                        <Link href={`/documents/${d.id}`} className="flex min-w-0 gap-3">
                          <DocumentThumb id={d.id} className="hidden h-12 w-9 shrink-0 rounded border border-border sm:flex" />
                          <span className="min-w-0">
                            <span className="block font-medium text-fg hover:underline">{d.title}</span>
                            {d.snippet ? (
                              <span className="mt-0.5 line-clamp-2 block text-xs text-muted [&_mark]:rounded [&_mark]:bg-warn/25 [&_mark]:px-0.5 [&_mark]:text-fg" dangerouslySetInnerHTML={{ __html: sanitizeSnippet(d.snippet) }} />
                            ) : (
                              <span className="block text-xs text-faint">
                                #{d.id}
                                {d.page_count ? ` · ${d.page_count} page${d.page_count === 1 ? '' : 's'}` : ''}
                              </span>
                            )}
                          </span>
                        </Link>
                      </td>
                      <td className="hidden px-2 py-2.5 text-muted md:table-cell">{meta.correspondentName(d.correspondent) ?? '–'}</td>
                      <td className="hidden px-2 py-2.5 text-muted xl:table-cell">{meta.documentTypeName(d.document_type) ?? '–'}</td>
                      <td className="hidden px-2 py-2.5 lg:table-cell">
                        <TagChips ids={d.tags} name={meta.tagName} max={3} />
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap text-muted">{formatDate(d.created)}</td>
                      <td className="px-3 py-2.5">
                        <StatusIcon status={d.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {loading && <Skeleton className="mt-3 h-24 rounded-2xl" />}
          <div ref={sentinel} className="h-8" />
        </div>
      </div>

      {/* Bulk bar */}
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-5 transition duration-300 lg:pl-[252px]',
          selected.size ? 'translate-y-0 opacity-100' : 'invisible translate-y-4 opacity-0',
        )}
        aria-hidden={!selected.size}
      >
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-3xl border border-border bg-surface/95 px-4 py-2 shadow-pop backdrop-blur-xl">
          <span className="text-sm font-medium">{formatNumber(targetCount)} selected</span>
          {allOnScreen && !allMatching && count !== null && count > rows.length && (
            <button type="button" className="text-xs text-accent-text hover:underline" onClick={() => setAllMatching(true)}>
              Select all {formatNumber(count)}
            </button>
          )}
          <span className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBulk('addTags')}>
            Add tags
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBulk('removeTags')}>
            Remove tags
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBulk('correspondent')}>
            Correspondent
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBulk('documentType')}>
            Type
          </Button>
          <Button size="sm" variant="ghost" icon={<Sparkles className="size-3.5" />} disabled={busy} onClick={() => runBulk({ action: 'analyze' }, 'Queued for analysis')}>
            Analyse
          </Button>
          {!allMatching && (
            <Button size="sm" variant="ghost" icon={<Play className="size-3.5" />} disabled={busy} onClick={() => setRunWorkflow(true)}>
              Workflow…
            </Button>
          )}
          {admin && (
            <Button size="sm" variant="ghost" icon={<ScanText className="size-3.5" />} disabled={busy} onClick={() => runBulk({ action: 'ocr' }, 'Queued for OCR')}>
              OCR
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" />}
            disabled={busy}
            onClick={async () => {
              const trash = archive?.capabilities.trash;
              if (
                !(await confirm({
                  title: `Delete ${formatNumber(targetCount)} document(s)?`,
                  message:
                    trash === 'native'
                      ? 'They go to the trash and can be restored there.'
                      : trash === 'external'
                        ? `They go to the trash of ${archive?.label ?? 'the archive'} and can be restored there (menu: Trash).`
                        : `They are deleted in ${archive?.label ?? 'the archive'}.`,
                  confirmLabel: 'Delete',
                  danger: true,
                }))
              )
                return;
              await runBulk({ action: 'delete' }, 'Deleted');
            }}
          >
            Delete
          </Button>
          <IconButton label="Clear selection" onClick={() => setSelected(new Set())}>
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      {runWorkflow && <RunWorkflowModal documentIds={[...selected]} onClose={() => setRunWorkflow(false)} />}
      {bulk && (
        <BulkEditModal
          kind={bulk}
          meta={meta}
          onClose={() => setBulk(null)}
          onApply={(edit) => {
            setBulk(null);
            void runBulk({ action: 'edit', edit }, 'Changed');
          }}
        />
      )}
      <SlideOver open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
        <Filters state={state} set={set} facets={facets} meta={meta} />
      </SlideOver>
    </Page>
  );
}

/** Snippets come with <mark> highlights from the server; everything else is escaped. */
function sanitizeSnippet(html: string): string {
  const escaped = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}

/** Small async loader with a reload function. */
function useMemoAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fn().then(
      (d) => alive && setData(d),
      () => alive && setData(undefined),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, reload: () => setNonce((n) => n + 1) };
}
