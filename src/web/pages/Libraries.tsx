/**
 * Libraries of the built-in archive: separate collections with their own members, roles, tags and
 * settings. Owners manage their library here; administrators manage all of them and the watch
 * folders (paths on the server).
 */
import { useState } from 'react';
import { FolderInput, Library, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import type { LibraryCandidates, LibraryInfo, LibraryMember, LibraryRole, LibrarySettings, WatchFolder } from '@shared/api';
import { Page } from '../components/Layout';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Skeleton,
  SlideOver,
  Switch,
  TagInput,
  Tabs,
  tabPanelProps,
  Textarea,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, errorMessage, get, patch, post, put } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { formatDate, formatNumber } from '../lib/format';
import { useSession } from '../lib/session';

const ROLE_LABEL: Record<LibraryRole, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const ROLE_HINT: Record<LibraryRole, string> = {
  owner: 'everything, including members and settings',
  editor: 'add and change documents',
  viewer: 'read and ask only',
};

export default function LibrariesPage() {
  const { session } = useSession();
  const admin = session?.user?.role === 'admin';
  const libraries = useAsync((signal) => get<LibraryInfo[]>('/api/libraries', signal), []);
  const [open, setOpen] = useState<LibraryInfo | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <Page>
      <PageHeader
        title="Libraries"
        description="Each library is a separate collection with its own members, tags and settings. Members only see the libraries they belong to."
        actions={
          admin && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New library
            </Button>
          )
        }
      />
      {libraries.error && <Alert tone="danger">{libraries.error}</Alert>}
      {!libraries.data ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : libraries.data.length === 0 ? (
        <EmptyState icon={<Library className="size-6" />} title="No library yet" />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {libraries.data.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => setOpen(l)}
                className="w-full rounded-2xl border border-border bg-surface p-4 text-left shadow-card transition hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-fg">{l.name}</div>
                    {l.description && <div className="mt-0.5 line-clamp-2 text-sm text-muted">{l.description}</div>}
                  </div>
                  {l.role ? (
                    <Badge tone={l.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABEL[l.role]}</Badge>
                  ) : (
                    <Badge>admin</Badge>
                  )}
                </div>
                <div className="mt-3 text-xs text-muted">
                  {formatNumber(l.documents)} document{l.documents === 1 ? '' : 's'} · since {formatDate(l.createdAt)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      <NewLibraryModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async (l) => {
          setCreating(false);
          await libraries.reload();
          setOpen(l);
        }}
      />
      {open && (
        <LibraryPanel
          library={open}
          admin={admin}
          onClose={() => setOpen(null)}
          onChanged={async () => {
            const list = await get<LibraryInfo[]>('/api/libraries');
            libraries.setData(list);
            setOpen(list.find((x) => x.id === open.id) ?? null);
          }}
        />
      )}
    </Page>
  );
}

function NewLibraryModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (l: LibraryInfo) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const l = await post<LibraryInfo>('/api/libraries', { name, description });
      toast.success(`Library “${l.name}” created`);
      setName('');
      setDescription('');
      onCreated(l);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New library"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={create}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input
            value={name}
            maxLength={100}
            autoFocus
            placeholder="e.g. Family, Company, Club"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Description (optional)">
          <Textarea value={description} maxLength={500} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="text-xs text-muted">You become its owner and can add members afterwards.</p>
      </div>
    </Modal>
  );
}

type PanelTab = 'settings' | 'members' | 'folders';

function LibraryPanel({
  library,
  admin,
  onClose,
  onChanged,
}: {
  library: LibraryInfo;
  admin: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const manage = admin || library.role === 'owner';
  const [tab, setTab] = useState<PanelTab>('settings');
  const tabs: { id: PanelTab; label: string }[] = [
    { id: 'settings', label: 'Settings' },
    { id: 'members', label: 'Members' },
    ...(manage ? [{ id: 'folders' as const, label: 'Watch folders' }] : []),
  ];
  return (
    <SlideOver open onClose={onClose} title={library.name} description={`${formatNumber(library.documents)} documents`}>
      <Tabs id="library" value={tab} onChange={setTab} tabs={tabs} />
      <div className="mt-5" {...tabPanelProps('library', tab)}>
        {tab === 'settings' ? (
          <SettingsTab library={library} manage={manage} onChanged={onChanged} onDeleted={onClose} />
        ) : tab === 'members' ? (
          <MembersTab library={library} manage={manage} />
        ) : (
          <FoldersTab library={library} admin={admin} />
        )}
      </div>
    </SlideOver>
  );
}

function SettingsTab({
  library,
  manage,
  onChanged,
  onDeleted,
}: {
  library: LibraryInfo;
  manage: boolean;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(library.name);
  const [description, setDescription] = useState(library.description);
  const [settings, setSettings] = useState<LibrarySettings>(library.settings);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof LibrarySettings>(key: K, value: LibrarySettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      await patch(`/api/libraries/${library.id}`, { name, description, settings });
      toast.success('Saved');
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirm({
        title: `Delete the library “${library.name}”?`,
        message: 'Only empty libraries can be deleted (including the trash).',
        confirmLabel: 'Delete library',
        danger: true,
      }))
    )
      return;
    try {
      await del(`/api/libraries/${library.id}`);
      toast.success('Library deleted');
      onDeleted();
      await onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-5">
      <Field label="Name">
        <Input value={name} maxLength={100} disabled={!manage} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <Textarea
          value={description}
          maxLength={500}
          rows={2}
          disabled={!manage}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Days in the trash" hint="Deleted documents are removed for good afterwards.">
          <NumberInput
            min={1}
            max={3650}
            value={settings.trashDays ?? 30}
            disabled={!manage}
            onChange={(v) => set('trashDays', v)}
          />
        </Field>
        <Field label="Keep versions" hint="Per document, the newest ones; 0 = all.">
          <NumberInput
            min={0}
            max={1000}
            value={settings.maxVersions ?? 0}
            disabled={!manage}
            onChange={(v) => set('maxVersions', v)}
          />
        </Field>
        <Field label="Delete versions older than (days)" hint="Never the current one or the first; 0 = never.">
          <NumberInput
            min={0}
            max={36500}
            value={settings.maxVersionAgeDays ?? 0}
            disabled={!manage}
            onChange={(v) => set('maxVersionAgeDays', v)}
          />
        </Field>
      </div>
      <Switch
        checked={Boolean(settings.reanalyzeOnNewVersion)}
        disabled={!manage}
        onChange={(v) => set('reanalyzeOnNewVersion', v)}
        label="Analyse new versions again"
        description="Title, tags and dates are suggested again for the new file. Off: the details stay as they are."
      />
      <Switch
        checked={Boolean(settings.allowDuplicates)}
        disabled={!manage}
        onChange={(v) => set('allowDuplicates', v)}
        label="Allow duplicates"
        description="Store a file again although the same file is in this library already."
      />
      {manage && (
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
          <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={remove}>
            Delete library
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={save}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function MembersTab({ library, manage }: { library: LibraryInfo; manage: boolean }) {
  const toast = useToast();
  const members = useAsync((signal) => get<LibraryMember[]>(`/api/libraries/${library.id}/members`, signal), [library.id]);
  const candidates = useAsync(
    (signal) => (manage ? get<LibraryCandidates>(`/api/libraries/${library.id}/candidates`, signal) : Promise.resolve(null)),
    [library.id, manage],
  );
  const [draft, setDraft] = useState<LibraryMember[] | null>(null);
  const [adding, setAdding] = useState<{ key: string; role: LibraryRole }>({ key: '', role: 'viewer' });
  const [busy, setBusy] = useState(false);
  const list = draft ?? members.data ?? [];
  const key = (m: { type: string; id: number }) => `${m.type}:${m.id}`;
  const taken = new Set(list.map(key));
  const options = [
    ...(candidates.data?.users ?? []).map((u) => ({ key: `user:${u.id}`, label: u.name, type: 'user' as const, id: u.id })),
    ...(candidates.data?.groups ?? []).map((g) => ({
      key: `group:${g.id}`,
      label: `${g.name} (group)`,
      type: 'group' as const,
      id: g.id,
    })),
  ].filter((o) => !taken.has(o.key));

  const change = (next: LibraryMember[]) => setDraft(next);
  const add = () => {
    const o = options.find((x) => x.key === adding.key);
    if (!o) return;
    change([...list, { type: o.type, id: o.id, name: o.label, role: adding.role }]);
    setAdding({ key: '', role: adding.role });
  };
  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/libraries/${library.id}/members`, { members: list.map((m) => ({ type: m.type, id: m.id, role: m.role })) });
      toast.success('Members saved');
      setDraft(null);
      await members.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (members.error) return <Alert tone="danger">{members.error}</Alert>;
  if (!members.data) return <Skeleton className="h-32" />;
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border rounded-xl border border-border">
        {list.length === 0 && <li className="px-3 py-4 text-sm text-muted">Nobody yet.</li>}
        {list.map((m) => (
          <li key={key(m)} className="flex items-center gap-3 px-3 py-2">
            {m.type === 'group' ? <Users className="size-4 shrink-0 text-muted" /> : <span className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate text-sm text-fg">{m.name}</span>
            {manage ? (
              <>
                <Select
                  aria-label={`Role of ${m.name}`}
                  className="w-32"
                  value={m.role}
                  onChange={(e) =>
                    change(list.map((x) => (key(x) === key(m) ? { ...x, role: e.target.value as LibraryRole } : x)))
                  }
                >
                  {(['owner', 'editor', 'viewer'] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
                <IconButton label={`Remove ${m.name}`} onClick={() => change(list.filter((x) => key(x) !== key(m)))}>
                  <Trash2 className="size-4" />
                </IconButton>
              </>
            ) : (
              <Badge>{ROLE_LABEL[m.role]}</Badge>
            )}
          </li>
        ))}
      </ul>
      {manage && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Add" className="min-w-48 flex-1">
              <Select value={adding.key} onChange={(e) => setAdding({ ...adding, key: e.target.value })}>
                <option value="">Choose a user or group…</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Role" className="w-32">
              <Select value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value as LibraryRole })}>
                {(['viewer', 'editor', 'owner'] as const).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button icon={<UserPlus className="size-4" />} disabled={!adding.key} onClick={add}>
              Add
            </Button>
          </div>
          <ul className="space-y-0.5 text-xs text-muted">
            {(['owner', 'editor', 'viewer'] as const).map((r) => (
              <li key={r}>
                <span className="font-medium text-fg">{ROLE_LABEL[r]}:</span> {ROLE_HINT[r]}
              </li>
            ))}
          </ul>
          {draft && (
            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
              <Button variant="primary" disabled={busy} onClick={save}>
                Save members
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FoldersTab({ library, admin }: { library: LibraryInfo; admin: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const folders = useAsync((signal) => get<WatchFolder[]>(`/api/libraries/${library.id}/intake/folders`, signal), [library.id]);
  const [form, setForm] = useState({
    path: '',
    subfolders: 'tags' as WatchFolder['subfolders'],
    after: 'delete' as WatchFolder['after'],
    tags: [] as string[],
    skipAnalysis: false,
  });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await post(`/api/libraries/${library.id}/intake/folders`, form);
      toast.success('Watch folder added');
      setForm({ ...form, path: '', tags: [] });
      await folders.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: WatchFolder) => {
    if (!(await confirm({ title: 'Stop watching this folder?', message: f.path, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await del(`/api/intake/folders/${f.id}`);
      await folders.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (folders.error) return <Alert tone="danger">{folders.error}</Alert>;
  if (!folders.data) return <Skeleton className="h-32" />;
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Files put into a watch folder are stored in this library once they stopped changing, then removed from the folder.
      </p>
      {folders.data.length === 0 ? (
        <EmptyState icon={<FolderInput className="size-6" />} title="No watch folder" />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {folders.data.map((f) => (
            <li key={f.id} className="flex items-start gap-3 px-3 py-2.5">
              <FolderInput className="mt-0.5 size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm break-all text-fg">{f.path}</div>
                <div className="text-xs text-muted">
                  Subfolders:{' '}
                  {f.subfolders === 'tags' ? 'become tags' : f.subfolders === 'library' ? 'choose the library' : 'ignored'}
                  {f.tags.length ? ` · tags ${f.tags.join(', ')}` : ''}
                  {f.skipAnalysis ? ' · no AI analysis' : ''}
                  {!f.enabled ? ' · paused' : ''}
                </div>
              </div>
              <IconButton label={`Remove ${f.path}`} onClick={() => remove(f)}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      {admin ? (
        <div className="space-y-3 rounded-xl border border-dashed border-border p-4">
          <div className="text-sm font-medium text-fg">Add a watch folder</div>
          <Field
            label="Folder on the server"
            hint="An absolute path the Paperless-AI process can read and write, e.g. a mounted scanner share."
          >
            <Input value={form.path} placeholder="/scans/family" onChange={(e) => setForm({ ...form, path: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Subfolders">
              <Select
                value={form.subfolders}
                onChange={(e) => setForm({ ...form, subfolders: e.target.value as WatchFolder['subfolders'] })}
              >
                <option value="tags">Become tags</option>
                <option value="ignore">Ignored</option>
              </Select>
            </Field>
            <Field label="Tags for every file">
              <TagInput value={form.tags} onChange={(tags) => setForm({ ...form, tags })} />
            </Field>
          </div>
          <Switch
            checked={form.skipAnalysis}
            onChange={(v) => setForm({ ...form, skipAnalysis: v })}
            label="Store only"
            description="Do not run the AI analysis for these files."
          />
          <Button variant="primary" disabled={!form.path.trim() || busy} onClick={add}>
            Add folder
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted">Only administrators can add folders – they are paths on the server.</p>
      )}
    </div>
  );
}
