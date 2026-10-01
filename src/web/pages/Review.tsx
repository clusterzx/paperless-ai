import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Check, ExternalLink, FileSearch, MessageSquareText, PanelLeft, Plus, Save, Sparkles, Undo2 } from 'lucide-react';
import type { AnalysisResult, DocumentDetail } from '@shared/api';
import { DocumentPicker } from '../components/DocumentPicker';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Skeleton, TagInput, useToast } from '../components/ui';
import { errorMessage, get, post } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { duration, formatNumber } from '../lib/format';
import { useMetadata, type MetadataLookup } from '../lib/metadata';

interface FormState {
  title: string;
  correspondent: string;
  documentType: string;
  created: string;
  tags: string[];
  customFields: { field_name: string; value: string }[];
}

function fromDocument(doc: DocumentDetail, meta: MetadataLookup): FormState {
  return {
    title: doc.title ?? '',
    correspondent: meta.correspondentName(doc.correspondent) ?? '',
    documentType: meta.documentTypeName(doc.document_type) ?? '',
    created: doc.created ?? '',
    tags: doc.tags.map((t) => meta.tagName(t)),
    customFields: doc.custom_fields
      .map((f) => ({ field_name: meta.customFields.find((c) => c.id === f.field)?.name ?? `#${f.field}`, value: f.value == null ? '' : String(f.value) }))
      .filter((f) => f.value !== ''),
  };
}

function Changed({ on }: { on: boolean }) {
  return on ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle" title="Changed" /> : null;
}

function ReviewDocument({ documentId }: { documentId: number }) {
  const meta = useMetadata();
  const toast = useToast();
  const [, navigate] = useLocation();
  const doc = useAsync((signal) => get<DocumentDetail>(`/api/documents/${documentId}`, signal), [documentId]);
  const original = useMemo(() => (doc.data && meta.loaded ? fromDocument(doc.data, meta) : null), [doc.data, meta.loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  const [form, setForm] = useState<FormState | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setForm(original), [original]);

  const analyze = async () => {
    if (!form) return;
    setAnalyzing(true);
    setError(null);
    try {
      const res = await post<AnalysisResult>(`/api/documents/${documentId}/analyze`, {});
      setAnalysis(res);
      const s = res.suggestion;
      setForm((f) =>
        f && {
          ...f,
          title: s.title ?? f.title,
          correspondent: s.correspondent ?? f.correspondent,
          documentType: s.document_type ?? f.documentType,
          created: s.document_date ?? f.created,
          tags: [...f.tags, ...s.tags.filter((t) => !f.tags.some((x) => x.toLowerCase() === t.toLowerCase()))],
          customFields: [...f.customFields.filter((c) => !s.custom_fields.some((x) => x.field_name === c.field_name)), ...s.custom_fields],
        },
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const save = async () => {
    if (!form || !original) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (form.title !== original.title) body.title = form.title;
      if (form.correspondent !== original.correspondent) body.correspondent = form.correspondent || null;
      if (form.documentType !== original.documentType) body.documentType = form.documentType || null;
      if (form.created !== original.created && form.created) body.created = form.created;
      if (JSON.stringify(form.tags) !== JSON.stringify(original.tags)) body.tags = form.tags;
      if (JSON.stringify(form.customFields) !== JSON.stringify(original.customFields)) body.customFields = form.customFields.filter((c) => c.value.trim());
      const res = await post<{ changed: string[]; notes: string[] }>(`/api/documents/${documentId}/apply`, body);
      toast.success(res.changed.length ? `Saved: ${res.changed.join(', ')}` : 'No changes to save');
      for (const n of res.notes) toast.info(n);
      meta.reload();
      await doc.reload();
      setAnalysis(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (doc.error) return <Alert tone="danger" className="m-6">{doc.error}</Alert>;
  if (!doc.data || !form || !original) return <Skeleton className="m-6 h-96 rounded-xl" />;
  const d = doc.data;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => f && { ...f, [k]: v });
  const dirty = JSON.stringify(form) !== JSON.stringify(original);
  const suggestedMissing = analysis?.suggestion.tags.filter((t) => !form.tags.some((x) => x.toLowerCase() === t.toLowerCase())) ?? [];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{d.title}</h2>
          <p className="text-xs text-muted">
            #{d.id}
            {d.original_file_name ? ` · ${d.original_file_name}` : ''}
            {d.user_can_change === false && <Badge tone="warn" className="ml-2">read-only for the API user</Badge>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" icon={<MessageSquareText className="size-4" />} onClick={() => navigate(`/chat?doc=${d.id}`)}>
            Chat
          </Button>
          <a href={d.url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost" icon={<ExternalLink className="size-4" />}>
              Paperless
            </Button>
          </a>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Content" description={`${formatNumber(d.content.length)} characters`} bodyClassName="p-0">
          {d.content ? (
            <pre className="max-h-[70vh] overflow-auto p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted">{d.content}</pre>
          ) : (
            <EmptyState title="No text content" />
          )}
        </Card>
        <Card
          title="Metadata"
          description={analysis ? `AI suggestion by ${analysis.model} · ${formatNumber(analysis.usage.totalTokens)} tokens · ${duration(analysis.durationMs)}${analysis.truncated ? ' · content truncated' : ''}` : 'Edit manually or let the AI suggest values'}
          actions={
            <Button size="sm" variant="subtle" icon={<Sparkles className="size-4" />} loading={analyzing} onClick={analyze}>
              {analysis ? 'Analyze again' : 'Analyze with AI'}
            </Button>
          }
        >
          <div className="space-y-4">
            <Field label={<>Title<Changed on={form.title !== original.title} /></>}>
              <Input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={128} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={<>Correspondent<Changed on={form.correspondent !== original.correspondent} /></>}>
                <Input list="review-correspondents" value={form.correspondent} onChange={(e) => set('correspondent', e.target.value)} placeholder="None" />
                <datalist id="review-correspondents">
                  {meta.correspondents.map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
              </Field>
              <Field label={<>Document type<Changed on={form.documentType !== original.documentType} /></>}>
                <Input list="review-types" value={form.documentType} onChange={(e) => set('documentType', e.target.value)} placeholder="None" />
                <datalist id="review-types">
                  {meta.documentTypes.map((c) => (
                    <option key={c.id} value={c.name} />
                  ))}
                </datalist>
              </Field>
            </div>
            <Field label={<>Document date<Changed on={form.created !== original.created} /></>}>
              <Input type="date" value={form.created} onChange={(e) => set('created', e.target.value)} className="max-w-xs" />
            </Field>
            <Field label={<>Tags<Changed on={JSON.stringify(form.tags) !== JSON.stringify(original.tags)} /></>} hint="New tags are created in Paperless when saving.">
              <TagInput value={form.tags} onChange={(v) => set('tags', v)} suggestions={meta.tags.map((t) => t.name)} />
            </Field>
            {suggestedMissing.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted">AI suggested:</span>
                {suggestedMissing.map((t) => (
                  <button key={t} onClick={() => set('tags', [...form.tags, t])} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 font-medium text-accent-text hover:brightness-95">
                    <Plus className="size-3" /> {t}
                  </button>
                ))}
              </div>
            )}
            {form.customFields.length > 0 && (
              <div>
                <div className="label">
                  Custom fields
                  <Changed on={JSON.stringify(form.customFields) !== JSON.stringify(original.customFields)} />
                </div>
                <div className="space-y-2">
                  {form.customFields.map((c, i) => (
                    <div key={c.field_name} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-2">
                      <span className="truncate text-sm text-muted" title={c.field_name}>
                        {c.field_name}
                      </span>
                      <Input value={c.value} onChange={(e) => set('customFields', form.customFields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
              <Button variant="ghost" icon={<Undo2 className="size-4" />} disabled={!dirty || saving} onClick={() => setForm(original)}>
                Reset
              </Button>
              <Button variant="primary" icon={<Save className="size-4" />} disabled={!dirty} loading={saving} onClick={save}>
                Save to Paperless
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const fromUrl = Number(new URLSearchParams(search).get('doc')) || null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const meta = useMetadata();
  const select = (id: number) => {
    setPickerOpen(false);
    navigate(`/review?doc=${id}`);
  };
  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-80 shrink-0 flex-col border-r border-border bg-surface p-4 lg:flex">
        <h1 className="mb-3 flex items-center gap-2 font-semibold">
          <FileSearch className="size-4 text-accent" /> Manual review
        </h1>
        <DocumentPicker selected={fromUrl} onSelect={select} meta={meta} />
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="border-b border-border px-4 py-2 lg:hidden">
          <Button size="sm" icon={<PanelLeft className="size-4" />} onClick={() => setPickerOpen(true)}>
            Choose document
          </Button>
        </div>
        {fromUrl ? (
          <ReviewDocument key={fromUrl} documentId={fromUrl} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState icon={<Check className="size-5" />} title="Select a document to review">
              Let the AI suggest title, tags, correspondent, type, date and custom fields – then decide what to save. Useful for sensitive documents you do not want to process automatically.
            </EmptyState>
          </div>
        )}
      </div>
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose a document" size="lg">
        <div className="h-[65vh]">
          <DocumentPicker selected={fromUrl} onSelect={select} meta={meta} />
        </div>
      </Modal>
    </div>
  );
}

