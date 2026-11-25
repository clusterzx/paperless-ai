/**
 * File versions of a document (built-in archive): list, upload a new version, make one current,
 * delete one (library owners) and compare the text of two versions.
 */
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Download, FileDiff, Layers, Trash2, Upload } from 'lucide-react';
import type { DocumentVersionInfo, TextDiffLine, UploadResult } from '@shared/api';
import { Alert, Badge, Button, EmptyState, Field, Input, Select, Skeleton, useConfirm, useToast } from './ui';
import { del, errorMessage, get, post, postForm } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatDate, timeAgo } from '../lib/format';

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function VersionsPanel({
  docId,
  canEdit,
  isOwner,
  revision,
  onChanged,
}: {
  docId: number;
  canEdit: boolean;
  isOwner: boolean;
  revision: string | undefined;
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const versions = useAsync(
    (signal) => get<DocumentVersionInfo[]>(`/api/documents/${docId}/versions`, signal),
    [docId, revision],
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null);
  // One row per version: the uploaded file; a PDF made of it (Office documents, e-mails) is offered with it.
  const list = (versions.data ?? []).filter((v) => v.kind === 'original');
  const withPdf = new Set((versions.data ?? []).filter((v) => v.kind === 'archive').map((v) => v.version));

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      toast.success(done);
      await versions.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = () =>
    run(async () => {
      if (!file) return;
      const form = new FormData();
      form.append('comment', comment);
      form.append('file', file, file.name);
      const res = await postForm<{ results: UploadResult[] }>(`/api/documents/${docId}/versions`, form);
      const r = res.results[0];
      if (r?.status !== 'stored') throw new Error(r?.reason ?? `The file was not added (${r?.status ?? 'no result'})`);
      setFile(null);
      setComment('');
      if (fileRef.current) fileRef.current.value = '';
    }, 'New version added');

  const activate = (v: DocumentVersionInfo) =>
    run(() => post(`/api/documents/${docId}/versions/${v.version}/activate`), `Version ${v.version} is current now`);
  const remove = async (v: DocumentVersionInfo) => {
    if (
      !(await confirm({
        title: `Delete version ${v.version}?`,
        message: 'The file of this version and its text are removed. The other versions stay.',
        confirmLabel: 'Delete version',
        danger: true,
      }))
    )
      return;
    await run(() => del(`/api/documents/${docId}/versions/${v.version}`), `Version ${v.version} deleted`);
  };

  if (versions.error) return <Alert tone="danger">{versions.error}</Alert>;
  if (!versions.data) return <Skeleton className="h-40" />;

  return (
    <div className="space-y-5">
      {list.length === 0 ? (
        <EmptyState icon={<Layers className="size-6" />} title="No versions" />
      ) : (
        <ol className="divide-y divide-border rounded-xl border border-border">
          {list.map((v) => (
            <li key={v.version} className="flex items-start gap-3 px-3 py-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-sm font-semibold text-fg">
                {v.version}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-fg">{v.filename ?? `Version ${v.version}`}</span>
                  {v.current && (
                    <Badge tone="success">
                      <CheckCircle2 className="mr-1 size-3" /> current
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {formatDate(v.createdAt, true)} · {timeAgo(v.createdAt)}
                  {v.createdBy ? ` · ${v.createdBy}` : ''} · {size(v.size)}
                  {v.pages ? ` · ${v.pages} page${v.pages === 1 ? '' : 's'}` : ''}
                  {v.textLength != null ? ` · ${v.textLength.toLocaleString()} characters of text` : ''}
                </div>
                {v.comment && <div className="mt-0.5 text-sm text-fg">{v.comment}</div>}
                <div className="-ml-2 mt-1 flex flex-wrap gap-1">
                  <a
                    className="inline-flex items-center rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                    href={`/api/documents/${docId}/file?original=true&inline=false&version=${v.version}`}
                  >
                    <Download className="mr-1 size-3.5" /> File
                  </a>
                  {withPdf.has(v.version) && (
                    <a
                      className="inline-flex items-center rounded-lg px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
                      href={`/api/documents/${docId}/file?inline=false&version=${v.version}`}
                    >
                      <Download className="mr-1 size-3.5" /> PDF
                    </a>
                  )}
                  {canEdit && !v.current && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => activate(v)}>
                      Make current
                    </Button>
                  )}
                  {isOwner && !v.current && list.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      icon={<Trash2 className="size-3.5" />}
                      onClick={() => remove(v)}
                      aria-label={`Delete version ${v.version}`}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {list.length > 1 && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Compare version" className="w-32">
            <Select
              value={compare?.from ?? list[1].version}
              onChange={(e) => setCompare({ from: Number(e.target.value), to: compare?.to ?? list[0].version })}
            >
              {list.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="with" className="w-32">
            <Select
              value={compare?.to ?? list[0].version}
              onChange={(e) => setCompare({ from: compare?.from ?? list[1].version, to: Number(e.target.value) })}
            >
              {list.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            icon={<FileDiff className="size-4" />}
            onClick={() => setCompare({ from: compare?.from ?? list[1].version, to: compare?.to ?? list[0].version })}
          >
            Compare
          </Button>
        </div>
      )}
      {compare && <TextDiff docId={docId} from={compare.from} to={compare.to} />}

      {canEdit && (
        <div className="space-y-3 rounded-xl border border-dashed border-border p-4">
          <div className="text-sm font-medium text-fg">Upload a new version</div>
          <p className="text-xs text-muted">
            The new file becomes the current version. Title, tags and the other details stay; the text is read again.
          </p>
          <input
            ref={fileRef}
            type="file"
            aria-label="File of the new version"
            className="block w-full text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-fg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Field label="Comment (optional)">
            <Input value={comment} maxLength={500} placeholder="e.g. signed copy" onChange={(e) => setComment(e.target.value)} />
          </Field>
          <Button variant="primary" icon={<Upload className="size-4" />} disabled={!file || busy} onClick={upload}>
            Add version
          </Button>
        </div>
      )}
    </div>
  );
}

function TextDiff({ docId, from, to }: { docId: number; from: number; to: number }) {
  const diff = useAsync(
    (signal) => get<{ lines: TextDiffLine[] }>(`/api/documents/${docId}/text/diff?from=${from}&to=${to}`, signal),
    [docId, from, to],
  );
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [from, to]);
  if (diff.error) return <Alert tone="danger">{diff.error}</Alert>;
  if (!diff.data) return <Skeleton className="h-32" />;
  const lines = diff.data.lines;
  const changed = lines.filter((l) => l.type !== 'same').length;
  // Unchanged lines far from a change are folded away.
  const near = new Set<number>();
  lines.forEach((l, i) => {
    if (l.type !== 'same') for (let j = i - 2; j <= i + 2; j++) near.add(j);
  });
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          Version {from} → {to}: {changed ? `${changed} changed line${changed === 1 ? '' : 's'}` : 'the same text'}
        </span>
        {changed > 0 && (
          <button type="button" className="hover:text-fg" onClick={() => setShowAll((x) => !x)}>
            {showAll ? 'Only changes' : 'Whole text'}
          </button>
        )}
      </div>
      <pre
        className="max-h-[45vh] overflow-auto rounded-xl border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
        aria-label="Text differences"
      >
        {lines.map((l, i) =>
          showAll || !changed || near.has(i) ? (
            <div
              key={i}
              className={cn(
                l.type === 'add' && 'bg-success-soft text-fg',
                l.type === 'del' && 'bg-danger-soft text-muted line-through',
              )}
            >
              <span className="mr-2 select-none text-faint">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
              {l.text || ' '}
            </div>
          ) : near.has(i - 1) ? (
            <div key={i} className="select-none text-faint">
              ⋯
            </div>
          ) : null,
        )}
      </pre>
    </div>
  );
}
