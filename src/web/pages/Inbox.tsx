import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link } from 'wouter';
import { CheckCircle2, CircleAlert, FileUp, Loader2, RotateCcw, UploadCloud } from 'lucide-react';
import type { AccountInfo } from '@shared/api';
import { ACCEPT_ALWAYS, ACCEPT_OFFICE } from '@shared/fileTypes';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Select, Switch, TagInput, useToast } from '../components/ui';
import { useArchive } from '../components/documents';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatDate } from '../lib/format';
import { useMetadata } from '../lib/metadata';
import { useLiveEvents } from '../lib/live';
import { clearFinishedUploads, enqueueUploads, useUploads, type UploadItem } from '../lib/uploads';

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

/** "12 of 200 stored · 3 being sent · 185 waiting" */
function sessionSummary(items: UploadItem[]): string {
  const count = (f: (i: UploadItem) => boolean) => items.filter(f).length;
  const parts = [
    `${count((i) => i.state === 'done' && (i.result?.status === 'stored' || i.result?.status === 'forwarded'))} of ${items.length} stored`,
    `${count((i) => i.state === 'done' && i.result?.status === 'duplicate')} duplicate(s)`,
    `${count((i) => i.state === 'error' || (i.state === 'done' && (i.result?.status === 'rejected' || i.result?.status === 'failed')))} not stored`,
    `${count((i) => i.state === 'processing')} being stored`,
    `${count((i) => i.state === 'sending')} being sent`,
    `${count((i) => i.state === 'queued')} waiting`,
  ];
  return parts.filter((p, n) => n === 0 || !p.startsWith('0 ')).join(' · ');
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
  // Uploads go on in the background when another page is opened (lib/uploads.ts).
  const items = useUploads();
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
  // At most one reload a second (hundreds of uploads send two events each).
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (reloadTimer.current && clearTimeout(reloadTimer.current)), []);
  useLiveEvents((e) => {
    if ((e.type !== 'intake' && e.type !== 'document.processed') || reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void intake.reload();
    }, 1000);
  }, native);

  // Libraries the user can add to (administrators are not members of every library: role null).
  const writable = (libraries.data ?? []).filter((l) => l.role === 'owner' || l.role === 'editor');
  const account = useAsync((signal) => (archive?.capabilities.libraries ? get<AccountInfo>('/api/account', signal) : Promise.resolve(null)), [archive?.capabilities.libraries]);
  // Where "Default" goes: the user's default library, else the oldest one they can add to.
  const defaultLibrary = writable.find((l) => l.id === account.data?.defaultLibraryId) ?? [...writable].sort((a, b) => a.id - b.id)[0];
  const start = (files: File[]) => {
    const fields: Record<string, string> = {};
    if (tags.length) fields.tags = tags.join(',');
    if (skipAnalysis) fields.skipAnalysis = 'true';
    if (library) fields.libraryId = library;
    enqueueUploads(files, fields);
  };
  // New tags and the intake list once uploads have finished.
  const finished = items.filter((i) => i.state === 'done' || i.state === 'error').length;
  const reloads = useRef({ meta: meta.reload, intake: intake.reload });
  reloads.current = { meta: meta.reload, intake: intake.reload };
  useEffect(() => {
    if (!finished) return;
    reloads.current.meta();
    void reloads.current.intake();
  }, [finished]);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = [...e.dataTransfer.files];
    if (files.length) start(files);
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
            <p className="font-medium">Drop documents here</p>
            <p className="mt-1 max-w-md text-xs text-muted">PDF, images, text, HTML and e-mails (.eml){archive?.officeDocuments ? ', Word, Excel, PowerPoint and OpenDocument' : ''}</p>
            <p className="mt-1 text-sm text-muted">or</p>
            <Button className="mt-3" variant="primary" icon={<FileUp className="size-4" />} onClick={() => input.current?.click()}>
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              accept={archive?.officeDocuments ? `${ACCEPT_ALWAYS},${ACCEPT_OFFICE}` : ACCEPT_ALWAYS}
              capture={undefined}
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) start(files);
              }}
            />
          </div>

          {items.length > 0 && (
            <Card
              title="This session"
              description={sessionSummary(items)}
              actions={
                items.some((i) => i.state === 'done' || i.state === 'error') ? (
                  <Button size="sm" variant="ghost" onClick={clearFinishedUploads}>
                    Clear finished
                  </Button>
                ) : undefined
              }
              bodyClassName="p-0"
            >
              <ul className="max-h-[32rem] divide-y divide-border overflow-auto">
                {items.map((it) => {
                  const final = it.state === 'done' ? it.result?.status : it.state === 'error' ? 'failed' : null;
                  const bad = final === 'rejected' || final === 'failed';
                  return (
                    <li key={it.key} className="flex items-center gap-3 px-5 py-3 text-sm">
                      {bad ? (
                        <CircleAlert className="size-4 shrink-0 text-danger" />
                      ) : final ? (
                        <CheckCircle2 className="size-4 shrink-0 text-success" />
                      ) : (
                        <Loader2 className={cn('size-4 shrink-0 text-muted', it.state !== 'queued' && 'animate-spin')} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{it.file.name}</div>
                        {it.state === 'sending' && (
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                          </div>
                        )}
                        {it.state === 'queued' && <div className="text-xs text-muted">Waiting to be sent</div>}
                        {it.state === 'processing' && <div className="text-xs text-muted">Received – being stored and read</div>}
                        {(it.error || (bad && it.result?.reason)) && <div className="text-xs text-danger">{it.error ?? it.result?.reason}</div>}
                        {final === 'duplicate' && it.result?.reason && <div className="text-xs text-muted">{it.result.reason}</div>}
                        {final === 'forwarded' && <div className="text-xs text-muted">Handed to {archive?.label} – it appears in the list once it is consumed.</div>}
                      </div>
                      {final && <Badge tone={STATUS_TONE[final] ?? 'neutral'}>{final}</Badge>}
                      {final && it.result?.documentId && (
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
