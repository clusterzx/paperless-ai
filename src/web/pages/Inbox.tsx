import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'wouter';
import { CheckCircle2, CircleAlert, FileUp, Loader2, RotateCcw, UploadCloud } from 'lucide-react';
import type { AccountInfo, UploadResult } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Select, Switch, TagInput, useToast } from '../components/ui';
import { useArchive } from '../components/documents';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatDate } from '../lib/format';
import { useMetadata } from '../lib/metadata';
import { useLiveEvents } from '../lib/live';

interface Item {
  key: string;
  file: File;
  progress: number;
  result?: UploadResult;
  error?: string;
}

interface IntakeRow {
  id: number;
  channel: string;
  filename: string | null;
  status: 'pending' | 'stored' | 'duplicate' | 'failed' | 'rejected';
  documentId: number | null;
  error: string | null;
  createdAt: number;
}

interface LibraryOption {
  id: number;
  name: string;
  role: string | null;
}

/** Upload with progress (fetch cannot report upload progress). */
function upload(file: File, fields: Record<string, string>, onProgress: (p: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents/upload');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { results?: UploadResult[]; error?: string };
        if (xhr.status >= 400 || !body.results) reject(new Error(body.error ?? `Upload failed (HTTP ${xhr.status})`));
        else resolve(body.results[0]);
      } catch {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

const STATUS_TONE: Record<string, 'success' | 'warn' | 'danger' | 'info' | 'neutral'> = {
  stored: 'success',
  forwarded: 'success',
  duplicate: 'warn',
  rejected: 'danger',
  failed: 'danger',
  pending: 'info',
};

export default function InboxPage() {
  const toast = useToast();
  const meta = useMetadata();
  const archive = useArchive();
  const native = archive?.capabilities.upload === 'native';
  const [items, setItems] = useState<Item[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [skipAnalysis, setSkipAnalysis] = useState(false);
  const [library, setLibrary] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Files shared from another app (installed app, share target) arrive here.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('shared') && !q.has('shareError')) return;
    const error = q.get('shareError');
    if (error) toast.error(error);
    else toast.success(`${q.get('shared')} of ${q.get('of')} shared file(s) received`);
    window.history.replaceState(null, '', '/inbox');
  }, [toast]);
  const libraries = useAsync((signal) => (archive?.capabilities.libraries ? get<LibraryOption[]>('/api/libraries', signal) : Promise.resolve([])), [archive?.capabilities.libraries]);
  const intake = useAsync((signal) => (native ? get<IntakeRow[]>('/api/intake?limit=50', signal) : Promise.resolve([] as IntakeRow[])), [native]);
  useLiveEvents((e) => {
    if (e.type === 'intake' || e.type === 'document.processed') void intake.reload();
  }, native);

  // Libraries the user can add to (administrators are not members of every library: role null).
  const writable = (libraries.data ?? []).filter((l) => l.role === 'owner' || l.role === 'editor');
  const account = useAsync((signal) => (archive?.capabilities.libraries ? get<AccountInfo>('/api/account', signal) : Promise.resolve(null)), [archive?.capabilities.libraries]);
  // Where "Default" goes: the user's default library, else the oldest one they can add to.
  const defaultLibrary = writable.find((l) => l.id === account.data?.defaultLibraryId) ?? [...writable].sort((a, b) => a.id - b.id)[0];
  const start = async (files: File[]) => {
    const fresh = files.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, progress: 0 }));
    setItems((x) => [...fresh, ...x]);
    const fields: Record<string, string> = {};
    if (tags.length) fields.tags = tags.join(',');
    if (skipAnalysis) fields.skipAnalysis = 'true';
    if (library) fields.libraryId = library;
    for (const it of fresh) {
      try {
        const result = await upload(it.file, fields, (p) => setItems((x) => x.map((y) => (y.key === it.key ? { ...y, progress: p } : y))));
        setItems((x) => x.map((y) => (y.key === it.key ? { ...y, progress: 1, result } : y)));
      } catch (err) {
        setItems((x) => x.map((y) => (y.key === it.key ? { ...y, error: errorMessage(err) } : y)));
      }
    }
    meta.reload();
    void intake.reload();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void start(files);
  };
  const retry = async (row: IntakeRow) => {
    try {
      await post(`/api/intake/${row.id}/retry`, {});
      void intake.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Inbox"
        description={native ? 'Upload documents – they are stored, read and analysed right away.' : `Upload documents – they are handed to ${archive?.label ?? 'the archive'} and analysed once it has consumed them.`}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition',
              drag ? 'border-accent bg-accent-soft/50' : 'border-border bg-surface',
            )}
          >
            <UploadCloud className="mb-3 size-10 text-accent" />
            <p className="font-medium">Drop PDFs and images here</p>
            <p className="mt-1 text-sm text-muted">or</p>
            <Button className="mt-3" variant="primary" icon={<FileUp className="size-4" />} onClick={() => input.current?.click()}>
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept="application/pdf,image/*"
              capture={undefined}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void start(files);
              }}
            />
          </div>

          {items.length > 0 && (
            <Card title="This session" bodyClassName="p-0">
              <ul className="divide-y divide-border">
                {items.map((it) => {
                  const status = it.error ? 'failed' : (it.result?.status ?? 'uploading');
                  return (
                    <li key={it.key} className="flex items-center gap-3 px-5 py-3 text-sm">
                      {it.error || status === 'rejected' || status === 'failed' ? (
                        <CircleAlert className="size-4 shrink-0 text-danger" />
                      ) : it.result ? (
                        <CheckCircle2 className="size-4 shrink-0 text-success" />
                      ) : (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{it.file.name}</div>
                        {!it.result && !it.error && (
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                          </div>
                        )}
                        {(it.error || it.result?.reason) && <div className="text-xs text-danger">{it.error ?? it.result?.reason}</div>}
                        {it.result?.status === 'forwarded' && <div className="text-xs text-muted">Handed to {archive?.label} – it appears in the list once it is consumed.</div>}
                      </div>
                      {it.result && <Badge tone={STATUS_TONE[it.result.status] ?? 'neutral'}>{it.result.status}</Badge>}
                      {it.result?.documentId && (
                        <Link href={`/documents/${it.result.documentId}`} className="text-xs text-accent-text hover:underline">
                          Open
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card title="Options">
            <div className="space-y-4">
              {writable.length > 1 && (
                <Field label="Library">
                  <Select value={library} onChange={(e) => setLibrary(e.target.value)}>
                    <option value="">{defaultLibrary ? `Default (${defaultLibrary.name})` : 'Default'}</option>
                    {writable.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Tags for the uploads" hint="In addition to what the AI suggests.">
                <TagInput value={tags} onChange={setTags} suggestions={meta.tags.map((t) => t.name)} />
              </Field>
              <Switch checked={skipAnalysis} onChange={setSkipAnalysis} label="Do not analyse with the AI" description="Store and read only (OCR and search)." />
            </div>
          </Card>
          {native && (
            <Card title="Recent intake" description="Uploads, watch folder, e-mail and WebDAV." bodyClassName="p-0">
              {intake.error && <Alert tone="danger">{intake.error}</Alert>}
              {!intake.data?.length ? (
                <EmptyState title="Nothing received yet" />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {intake.data.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 px-5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{r.filename ?? `#${r.id}`}</div>
                        <div className="text-xs text-muted">
                          {r.channel} · {formatDate(r.createdAt, true)}
                          {r.error ? ` · ${r.error}` : ''}
                        </div>
                      </div>
                      <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                      {r.documentId && (
                        <Link href={`/documents/${r.documentId}`} className="text-xs text-accent-text hover:underline" aria-label="Open document">
                          Open
                        </Link>
                      )}
                      {r.status === 'failed' && (
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => retry(r)}>
                          Retry
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
