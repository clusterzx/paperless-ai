import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'wouter';
import { ArrowLeft, Download, ExternalLink, FileText, History, MessageSquareText, Play, Save, ScanText, Sparkles, Trash2, Undo2 } from 'lucide-react';
import type { ActivityItem, DocumentDetail } from '@shared/api';
import { Page } from '../components/Layout';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LinkButton, Skeleton, Tabs, TagInput, tabPanelProps, Textarea, useConfirm, useToast } from '../components/ui';
import { ChatScroll, Composer, MessageView, useChatStream } from '../components/chat';
import { StatusIcon, useArchive } from '../components/documents';
import { VersionsPanel } from '../components/versions';
import { RunWorkflowModal } from '../components/workflowEditor';
import { ApiError, del, errorMessage, get, patch, post } from '../lib/api';
import { useAsync, useUnsavedChanges } from '../lib/hooks';
import { cn, formatDate, timeAgo } from '../lib/format';
import { useMetadata, type MetadataLookup } from '../lib/metadata';
import { useLiveEvents } from '../lib/live';
import { useSession } from '../lib/session';
import { CustomFieldInput, fieldDraftValue } from '../components/customFieldInput';

type TabId = 'details' | 'text' | 'versions' | 'activity' | 'chat';

interface Draft {
  title: string;
  created: string;
  correspondent: string;
  documentType: string;
  tags: string[];
  asn: string;
  fields: Record<string, string>;
}

function draftOf(d: DocumentDetail, meta: MetadataLookup): Draft {
  const fields: Record<string, string> = {};
  for (const f of d.custom_fields) {
    const def = meta.customFields.find((c) => c.id === f.field);
    if (def) fields[def.name] = fieldDraftValue(def, f.value);
  }
  return {
    title: d.title,
    created: d.created ?? '',
    correspondent: meta.correspondentName(d.correspondent) ?? '',
    documentType: meta.documentTypeName(d.document_type) ?? '',
    tags: d.tags.map((t) => meta.tagName(t)),
    asn: d.archive_serial_number != null ? String(d.archive_serial_number) : '',
    fields,
  };
}

function Viewer({ doc }: { doc: DocumentDetail }) {
  const url = `/api/documents/${doc.id}/file`;
  const type = doc.mime_type ?? '';
  if (/^image\//.test(type) && !/tiff/.test(type)) {
    return (
      <div className="flex h-full items-start justify-center overflow-auto bg-surface-2 p-4">
        <img src={`${url}?original=true`} alt={doc.title} className="max-w-full shadow-card" />
      </div>
    );
  }
  if (!type || /pdf/.test(type) || doc.mime_type === null) {
    return <iframe title={doc.title} src={url} className="h-full w-full border-0 bg-surface-2" />;
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState icon={<FileText className="size-6" />} title="No preview for this file type">
        <LinkButton href={`${url}?original=true&inline=false`} icon={<Download className="size-4" />}>
          Download
        </LinkButton>
      </EmptyState>
    </div>
  );
}

function DetailsForm({ doc, meta, onSaved }: { doc: DocumentDetail; meta: MetadataLookup & { reload: () => void }; onSaved: (d: DocumentDetail) => void }) {
  const toast = useToast();
  const original = useMemo(() => draftOf(doc, meta), [doc, meta]);
  const [draft, setDraft] = useState<Draft>(original);
  useEffect(() => setDraft(original), [original]);
  const [busy, setBusy] = useState(false);
  const [newField, setNewField] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  useUnsavedChanges(dirty);
  const readOnly = doc.role === 'viewer';
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (draft.title !== original.title) body.title = draft.title;
      if (draft.created !== original.created) body.created = draft.created || null;
      if (draft.correspondent !== original.correspondent) body.correspondent = draft.correspondent.trim() || null;
      if (draft.documentType !== original.documentType) body.documentType = draft.documentType.trim() || null;
      if (JSON.stringify(draft.tags) !== JSON.stringify(original.tags)) body.tags = draft.tags;
      if (draft.asn !== original.asn) body.archiveSerialNumber = draft.asn ? Number(draft.asn) : null;
      const changedFields = Object.entries(draft.fields).filter(([k, v]) => original.fields[k] !== v);
      if (changedFields.length) body.customFields = changedFields.map(([field_name, value]) => ({ field_name, value }));
      const res = await patch<{ document: DocumentDetail; notes: string[] }>(`/api/documents/${doc.id}`, body);
      for (const n of res.notes) toast.error(n);
      toast.success('Saved');
      meta.reload();
      onSaved(res.document);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const unusedFields = meta.customFields.filter((f) => !(f.name in draft.fields));
  return (
    <div className="space-y-4">
      {readOnly && <Alert tone="info">You can view this document; changing it needs the editor role in its library.</Alert>}
      <Field label="Title">
        <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} disabled={readOnly} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date">
          <Input type="date" value={draft.created} onChange={(e) => set({ created: e.target.value })} disabled={readOnly} />
        </Field>
        <Field label="ASN" hint="Archive serial number">
          <Input type="number" min={0} value={draft.asn} onChange={(e) => set({ asn: e.target.value })} disabled={readOnly} />
        </Field>
        <Field label="Correspondent">
          <Input list="doc-correspondents" value={draft.correspondent} onChange={(e) => set({ correspondent: e.target.value })} disabled={readOnly} />
          <datalist id="doc-correspondents">
            {meta.correspondents.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Document type">
          <Input list="doc-types" value={draft.documentType} onChange={(e) => set({ documentType: e.target.value })} disabled={readOnly} />
          <datalist id="doc-types">
            {meta.documentTypes.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
      </div>
      <Field label="Tags">
        <TagInput value={draft.tags} onChange={(tags) => set({ tags })} suggestions={meta.tags.map((t) => t.name)} disabled={readOnly} />
      </Field>
      {Object.keys(draft.fields).length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(draft.fields).map(([name, value]) => {
            const def = meta.customFields.find((c) => c.name === name);
            return (
              <Field key={name} label={name} className={def?.data_type === 'longtext' ? 'sm:col-span-2' : undefined}>
                <CustomFieldInput field={def} value={value} onChange={(v) => set({ fields: { ...draft.fields, [name]: v } })} disabled={readOnly} />
              </Field>
            );
          })}
        </div>
      )}
      {!readOnly && unusedFields.length > 0 && (
        <div className="flex items-center gap-2">
          <select className="input h-8 w-auto text-sm" value={newField} onChange={(e) => setNewField(e.target.value)} aria-label="Add custom field">
            <option value="">Add a custom field…</option>
            {unusedFields.map((f) => (
              <option key={f.id} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="ghost"
            disabled={!newField}
            onClick={() => {
              set({ fields: { ...draft.fields, [newField]: '' } });
              setNewField('');
            }}
          >
            Add
          </Button>
        </div>
      )}
      {!readOnly && (
        <div className="flex gap-2 pt-2">
          <Button variant="primary" icon={<Save className="size-4" />} loading={busy} disabled={!dirty} onClick={save}>
            Save
          </Button>
          <Button variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(original)}>
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

function ActivityList({ docId, version, onChanged }: { docId: number; version: string | undefined; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const activity = useAsync((signal) => get<ActivityItem[]>(`/api/documents/${docId}/activity`, signal), [docId, version]);
  const undo = async (item: ActivityItem) => {
    if (!item.undo) return;
    const message =
      item.kind === 'version' ? 'The version that was current before becomes current again.' : item.kind === 'deleted' ? 'The document is restored from the trash.' : 'The previous values are restored.';
    if (!(await confirm({ title: 'Undo this change?', message, confirmLabel: 'Undo', danger: true }))) return;
    const eventUndo = (force: boolean) => post(`/api/documents/${docId}/events/${item.undo!.id}/undo`, { force });
    try {
      if (item.undo.kind === 'history') await post('/api/history/revert', { documentIds: [docId] });
      else {
        try {
          await eventUndo(false);
        } catch (err) {
          // Changed again since then: the later change would be overwritten – ask first.
          if (!(err instanceof ApiError && err.body?.code === 'undo_conflict')) throw err;
          if (!(await confirm({ title: 'Undo anyway?', message: err.message, confirmLabel: 'Undo anyway', danger: true }))) return;
          await eventUndo(true);
        }
      }
      toast.success('Undone');
      await activity.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (activity.error) return <Alert tone="danger">{activity.error}</Alert>;
  if (!activity.data) return <Skeleton className="h-40" />;
  if (!activity.data.length) return <EmptyState icon={<History className="size-6" />} title="Nothing recorded yet" />;
  return (
    <ol className="relative space-y-4 border-l border-border pl-5">
      {activity.data.map((a, i) => (
        <li key={i} className="relative">
          <span className={cn('absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-surface', a.kind === 'ai' ? 'bg-accent' : a.kind === 'ocr' ? 'bg-info' : a.kind === 'workflow' ? 'bg-success' : 'bg-muted')} />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn('font-medium', a.reverted && 'line-through opacity-60')}>{a.title}</span>
            {a.reverted && <Badge tone="warn">undone</Badge>}
          </div>
          <div className="text-xs text-muted">
            {formatDate(a.at, true)} · {timeAgo(a.at)}
            {a.actor ? ` · ${a.actor}` : ''}
          </div>
          {a.details && a.details.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-xs">
              {a.details.map((d, j) => (
                <li key={j}>
                  <span className="text-muted">{d.field}:</span> <span className="text-faint line-through">{show(d.before)}</span> → <span>{show(d.after)}</span>
                </li>
              ))}
            </ul>
          )}
          {a.undo && (
            <Button size="sm" variant="ghost" className="mt-1" icon={<Undo2 className="size-3.5" />} onClick={() => undo(a)}>
              Undo
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function DocChat({ docId }: { docId: number }) {
  const chat = useChatStream(`/api/chat/document/${docId}`);
  const send = (text: string) => chat.send(text, (history, message) => ({ message, history: history.slice(-12) }));
  return (
    <div className="flex h-[60vh] min-h-0 flex-col">
      <ChatScroll deps={[chat.messages]}>
        <div className="space-y-5 py-2">
          {!chat.messages.length && <p className="py-6 text-center text-sm text-muted">Ask anything about this document.</p>}
          {chat.messages.map((m, i) => (
            <MessageView key={i} message={m} />
          ))}
        </div>
      </ChatScroll>
      <Composer onSend={send} busy={chat.busy} onStop={chat.stop} placeholder="Ask about this document…" />
    </div>
  );
}

export default function DocumentPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMetadata();
  const archive = useArchive();
  const { session } = useSession();
  const [, navigate] = useLocation();
  // ?tab=chat (links from the history, the review and the command menu) opens that tab.
  const [tab, setTab] = useState<TabId>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'text' || t === 'versions' || t === 'activity' || t === 'chat' ? t : 'details';
  });
  const [runWorkflow, setRunWorkflow] = useState(false);
  const doc = useAsync((signal) => get<DocumentDetail>(`/api/documents/${id}`, signal), [id]);
  useLiveEvents((e) => {
    if ('id' in e && e.id === id && e.type !== 'document.deleted') void doc.reload();
  });
  const d = doc.data;
  const canEdit = d?.role !== 'viewer';

  const analyse = async (ocr = false) => {
    try {
      await post('/api/documents/bulk', { ids: [id], action: ocr ? 'ocr' : 'analyze' });
      toast.success(ocr ? 'Queued for OCR and analysis' : 'Queued for analysis');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const remove = async () => {
    const trash = archive?.capabilities.trash === 'native';
    if (!(await confirm({ title: 'Delete this document?', message: trash ? 'It goes to the trash and can be restored there.' : `It is deleted in ${archive?.label ?? 'the archive'}.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await del(`/api/documents/${id}`);
      toast.success('Deleted');
      navigate('/documents');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (doc.error)
    return (
      <Page>
        <Alert tone="danger">{doc.error}</Alert>
      </Page>
    );

  return (
    <Page wide>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={() => window.history.length > 1 ? window.history.back() : navigate('/documents')} className="mb-1 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
            <ArrowLeft className="size-4" /> Documents
          </button>
          {d ? (
            <>
              <h1 className="text-xl font-semibold tracking-tight break-words text-fg">{d.title}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                <span>#{d.id}</span>
                <span>{formatDate(d.created)}</span>
                {d.correspondent && <span>{meta.correspondentName(d.correspondent)}</span>}
                {d.page_count ? <span>{d.page_count} page{d.page_count === 1 ? '' : 's'}</span> : null}
                <span className="inline-flex items-center gap-1">
                  <StatusIcon status={d.status ?? null} />
                </span>
              </div>
            </>
          ) : (
            <Skeleton className="h-8 w-80" />
          )}
        </div>
        {d && (
          <div className="flex flex-wrap gap-2">
            {archive?.capabilities.externalLink && (
              <LinkButton href={d.url} variant="ghost" icon={<ExternalLink className="size-4" />}>
                {archive.label}
              </LinkButton>
            )}
            <LinkButton href={`/api/documents/${id}/file?original=true&inline=false`} variant="ghost" icon={<Download className="size-4" />}>
              Download
            </LinkButton>
            {canEdit && (
              <Button variant="ghost" icon={<Sparkles className="size-4" />} onClick={() => analyse(false)}>
                Analyse again
              </Button>
            )}
            {canEdit && session?.user?.role === 'admin' && (
              <Button variant="ghost" icon={<ScanText className="size-4" />} onClick={() => analyse(true)}>
                OCR
              </Button>
            )}
            {canEdit && (
              <Button variant="ghost" icon={<Play className="size-4" />} onClick={() => setRunWorkflow(true)}>
                Workflow
              </Button>
            )}
            {canEdit && (
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={remove}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="h-[70vh] overflow-hidden rounded-2xl border border-border shadow-card lg:sticky lg:top-6 lg:h-[calc(100vh-8rem)]">
          {d ? <Viewer doc={d} /> : <Skeleton className="h-full" />}
        </div>
        <Card bodyClassName="p-5">
          <Tabs
            id="document"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'details', label: 'Details' },
              { id: 'text', label: 'Text' },
              ...(archive?.capabilities.fileVersions ? [{ id: 'versions' as const, label: d?.current_version && d.current_version > 1 ? `Versions (${d.current_version})` : 'Versions' }] : []),
              { id: 'activity', label: 'Activity' },
              { id: 'chat', label: 'Chat', icon: <MessageSquareText className="size-4" /> },
            ]}
          />
          <div className="mt-5" {...tabPanelProps('document', tab)}>
            {!d ? (
              <Skeleton className="h-64" />
            ) : tab === 'details' ? (
              <DetailsForm doc={d} meta={meta} onSaved={(n) => doc.setData(n)} />
            ) : tab === 'text' ? (
              d.content ? (
                <Textarea readOnly value={d.content} className="h-[55vh] font-mono text-xs leading-relaxed" aria-label="Text of the document" />
              ) : (
                <EmptyState icon={<FileText className="size-6" />} title="No text yet">
                  The text is extracted when the document is read (text layer or OCR).
                </EmptyState>
              )
            ) : tab === 'versions' ? (
              <VersionsPanel docId={id} canEdit={canEdit} isOwner={d.role === 'owner' || (!d.role && session?.user?.role === 'admin')} revision={d.modified} onChanged={() => void doc.reload()} />
            ) : tab === 'activity' ? (
              <ActivityList docId={id} version={d.modified} onChanged={() => void doc.reload()} />
            ) : (
              <DocChat docId={id} />
            )}
          </div>
        </Card>
      </div>
      {runWorkflow && <RunWorkflowModal documentIds={[id]} onClose={() => setRunWorkflow(false)} />}
    </Page>
  );
}
