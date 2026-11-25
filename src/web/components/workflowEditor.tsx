/**
 * Editor of a workflow: When (trigger) / If (conditions, nested groups) / Then (actions), dry run
 * against a document, and the run log (docs/standalone/workflows.md §10).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, ListTree, Play, Plus, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import type { LibraryCandidates, LibraryInfo, LibraryPrompt, PromptLibrary, UserInfo, GroupInfo } from '@shared/api';
import { EVENT_KINDS } from '@shared/api';
import type { PromptRulesInfo } from '@shared/promptRules';
import { emptyOverrides } from '@shared/promptRules';
import {
  INTAKE_CHANNELS,
  isGroup,
  TEMPLATE_FIELDS,
  type Action,
  type ActionType,
  type Condition,
  type ConditionGroup,
  type ConditionType,
  type DryRunResult,
  type RunStep,
  type Trigger,
  type TriggerType,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@shared/workflows';
import { Alert, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, NumberInput, Select, Skeleton, Switch, TagInput, Textarea, useConfirm, useToast } from './ui';
import { DocumentPicker } from './DocumentPicker';
import { OverridesForm } from './promptRules';
import { del, errorMessage, get, post, put } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { cn, formatDate, timeAgo } from '../lib/format';
import { useMetadata } from '../lib/metadata';
import { useSession } from '../lib/session';

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  'document.added': 'A document was added',
  'analysis.before': 'Before the AI analysis',
  'document.processed': 'After the AI analysis',
  'document.updated': 'A document was changed',
  'document.version_added': 'A new version was added',
  schedule: 'On a schedule',
  'date.reached': 'A date is reached',
  manual: 'Only when started by hand',
};

const CONDITION_LABELS: Record<ConditionType, string> = {
  tags: 'Tags',
  correspondent: 'Correspondent',
  document_type: 'Document type',
  storage_path: 'Storage path',
  owner: 'Owner',
  custom_field: 'Custom field',
  library: 'Library',
  channel: 'Arrived by',
  mail_from: 'Mail sender',
  mail_subject: 'Mail subject',
  folder_path: 'Folder',
  filename: 'File name',
  mime_type: 'File type',
  page_count: 'Number of pages',
  text: 'Text of the document',
  created: 'Document date',
  added_within: 'Added recently',
  processed: 'Analysed by the AI',
  analysis_failed: 'Analysis failed',
  ai_question: 'Ask the AI',
};

const ACTION_LABELS: Record<ActionType, string> = {
  set_title: 'Set the title',
  add_tags: 'Add tags',
  remove_tags: 'Remove tags',
  set_correspondent: 'Set the correspondent',
  set_document_type: 'Set the document type',
  set_storage_path: 'Set the storage path',
  set_custom_field: 'Set a custom field',
  assign_asn: 'Assign the next ASN',
  set_owner: 'Set the owner',
  move_to_library: 'Move to a library',
  analyze: 'Analyse with a prompt',
  skip_analysis: 'Skip the AI analysis',
  run_ocr: 'Read with OCR',
  ai_extract: 'Ask the AI for a value',
  add_calendar_event: 'Add a calendar date',
  notify_email: 'Send an e-mail',
  notify_webhook: 'Call a webhook',
  notify_inapp: 'Notify in the app',
  move_to_trash: 'Move to the trash',
};

const UPDATE_FIELDS = ['title', 'tags', 'correspondent', 'document_type', 'created', 'custom_fields', 'archive_serial_number', 'library_id', 'version'];

export function triggerSummary(t: Trigger): string {
  switch (t.type) {
    case 'document.added':
      return t.channels?.length ? `${TRIGGER_LABELS[t.type]} (${t.channels.join(', ')})` : TRIGGER_LABELS[t.type];
    case 'document.updated':
      return t.fields?.length ? `${TRIGGER_LABELS[t.type]} (${t.fields.join(', ')})` : TRIGGER_LABELS[t.type];
    case 'schedule':
      return `${TRIGGER_LABELS.schedule} (${t.cron})`;
    case 'date.reached':
      return `${t.source === 'created' ? 'Document date' : t.source === 'calendar' ? 'Calendar date' : `“${t.field ?? ''}”`} ${t.offsetDays >= 0 ? '+' : ''}${t.offsetDays} days`;
    default:
      return TRIGGER_LABELS[t.type];
  }
}

function newCondition(type: ConditionType): Condition {
  switch (type) {
    case 'tags':
      return { type, mode: 'any', names: [] };
    case 'custom_field':
      return { type, name: '', op: 'set' };
    case 'library':
      return { type, ids: [] };
    case 'channel':
      return { type, channels: [] };
    case 'mail_from':
    case 'mail_subject':
    case 'folder_path':
      return { type, contains: '' };
    case 'filename':
      return { type, pattern: '*.pdf' };
    case 'mime_type':
      return { type, types: ['application/pdf'] };
    case 'page_count':
      return { type, min: 1 };
    case 'text':
      return { type, contains: '' };
    case 'created':
      return { type };
    case 'added_within':
      return { type, days: 7 };
    case 'processed':
    case 'analysis_failed':
      return { type, value: true };
    case 'ai_question':
      return { type, question: '', expect: true };
    default:
      return { type, names: [] } as Condition;
  }
}

function newAction(type: ActionType): Action {
  switch (type) {
    case 'set_title':
      return { type, template: '{correspondent} – {document_type} {created}' };
    case 'add_tags':
    case 'remove_tags':
      return { type, names: [] };
    case 'set_correspondent':
    case 'set_document_type':
    case 'set_storage_path':
      return { type, name: null };
    case 'set_custom_field':
      return { type, name: '', value: '' };
    case 'set_owner':
      return { type, username: null };
    case 'move_to_library':
      return { type, libraryId: 0 };
    case 'analyze':
      return { type, prompt: null, overrides: emptyOverrides() };
    case 'ai_extract':
      return { type, question: '', field: '' };
    case 'add_calendar_event':
      return { type, source: 'created', offsetDays: 14, title: 'Follow up: {title}', kind: 'deadline' };
    case 'notify_email':
      return { type, to: [], users: [], groups: [], subject: '{title}', body: 'A workflow found this document.' };
    case 'notify_webhook':
      return { type, url: 'https://', preset: 'generic' };
    case 'notify_inapp':
      return { type, users: [], groups: [], title: '{title}', body: '' };
    case 'move_to_trash':
      return { type, confirm: false };
    default:
      return { type } as Action;
  }
}

/** Users and groups for notifications: admins see all, owners the candidates of their library. */
function useDirectory(libraryId: number | null, admin: boolean) {
  return useAsync<LibraryCandidates>(
    async (signal) => {
      if (admin) {
        const [users, groups] = await Promise.all([get<UserInfo[]>('/api/users', signal), get<GroupInfo[]>('/api/groups', signal)]);
        return { users: users.filter((u) => !u.disabled).map((u) => ({ id: u.id, name: u.displayName ? `${u.displayName} (${u.username})` : u.username })), groups: groups.map((g) => ({ id: g.id, name: g.name })) };
      }
      if (libraryId === null) return { users: [], groups: [] };
      return get<LibraryCandidates>(`/api/libraries/${libraryId}/candidates`, signal);
    },
    [libraryId, admin],
  );
}

function Chips<T extends string>({ options, value, onChange, labels }: { options: readonly T[]; value: T[]; onChange: (v: T[]) => void; labels?: Partial<Record<T, string>> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])}
            className={cn('rounded-full border px-2.5 py-0.5 text-xs transition', on ? 'border-accent bg-accent-soft text-fg' : 'border-border text-muted hover:text-fg')}
          >
            {labels?.[o] ?? o}
          </button>
        );
      })}
    </div>
  );
}

function IdPicker({ label, options, value, onChange }: { label: string; options: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1.5">
        {options.length === 0 && <span className="text-xs text-faint">–</span>}
        {options.map((o) => {
          const on = value.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs transition', on ? 'border-accent bg-accent-soft text-fg' : 'border-border text-muted hover:text-fg')}
            >
              {o.name}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

interface EditorData {
  libraries: LibraryInfo[];
  prompts: LibraryPrompt[];
  ruleInfo: PromptRulesInfo | null;
  directory: LibraryCandidates;
}

// ---------------------------------------------------------------- conditions

function ConditionEditor({ c, onChange, data }: { c: Condition; onChange: (c: Condition) => void; data: EditorData }) {
  const meta = useMetadata();
  const names = (list: string[], suggestions: string[], placeholder?: string) => (
    <TagInput value={list} onChange={(v) => onChange({ ...c, names: v } as Condition)} suggestions={suggestions} placeholder={placeholder} />
  );
  switch (c.type) {
    case 'tags':
      return (
        <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
          <Select aria-label="Tag condition" value={c.mode} onChange={(e) => onChange({ ...c, mode: e.target.value as 'any' })}>
            <option value="any">any of</option>
            <option value="all">all of</option>
            <option value="none">none of</option>
          </Select>
          {names(c.names, meta.tags.map((t) => t.name))}
        </div>
      );
    case 'correspondent':
      return names(c.names, meta.correspondents.map((t) => t.name), 'is one of …');
    case 'document_type':
      return names(c.names, meta.documentTypes.map((t) => t.name), 'is one of …');
    case 'storage_path':
      return names(c.names, data.ruleInfo?.storagePaths ?? []);
    case 'owner':
      return names(c.names, data.ruleInfo?.owners ?? []);
    case 'custom_field':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem_1fr]">
          <Input aria-label="Field" list="wf-custom-fields" value={c.name} placeholder="Field" onChange={(e) => onChange({ ...c, name: e.target.value })} />
          <Select aria-label="Comparison" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'set' })}>
            <option value="set">is set</option>
            <option value="equals">equals</option>
            <option value="gte">≥</option>
            <option value="lte">≤</option>
          </Select>
          {c.op !== 'set' && <Input aria-label="Value" value={c.value ?? ''} onChange={(e) => onChange({ ...c, value: e.target.value })} />}
        </div>
      );
    case 'library':
      return <IdPicker label="One of" options={data.libraries.map((l) => ({ id: l.id, name: l.name }))} value={c.ids} onChange={(ids) => onChange({ ...c, ids })} />;
    case 'channel':
      return <Chips options={INTAKE_CHANNELS} value={c.channels} onChange={(channels) => onChange({ ...c, channels })} />;
    case 'mail_from':
    case 'mail_subject':
    case 'folder_path':
      return <Input aria-label="contains" placeholder="contains …" value={c.contains} onChange={(e) => onChange({ ...c, contains: e.target.value })} />;
    case 'filename':
      return <Input aria-label="Pattern" placeholder="e.g. scan_*.pdf" value={c.pattern} onChange={(e) => onChange({ ...c, pattern: e.target.value })} />;
    case 'mime_type':
      return <TagInput value={c.types} onChange={(types) => onChange({ ...c, types })} suggestions={['application/pdf', 'image/*', 'image/jpeg', 'image/png', 'image/tiff', 'text/*', 'text/html', 'message/rfc822']} />;
    case 'page_count':
      return (
        <div className="grid grid-cols-2 gap-2">
          <NumberInput aria-label="At least" min={0} value={c.min ?? 0} onChange={(v) => onChange({ ...c, min: v })} />
          <NumberInput aria-label="At most" min={0} value={c.max ?? 9999} onChange={(v) => onChange({ ...c, max: v })} />
        </div>
      );
    case 'text':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Text contains" placeholder="contains …" value={c.contains ?? ''} onChange={(e) => onChange({ ...c, contains: e.target.value || undefined })} />
          <Input aria-label="Regular expression" placeholder="or matches /…/ (optional)" value={c.regex ?? ''} onChange={(e) => onChange({ ...c, regex: e.target.value || undefined })} />
        </div>
      );
    case 'created':
      return (
        <div className="grid grid-cols-2 gap-2">
          <Input aria-label="From" type="date" value={c.from ?? ''} onChange={(e) => onChange({ ...c, from: e.target.value || undefined })} />
          <Input aria-label="To" type="date" value={c.to ?? ''} onChange={(e) => onChange({ ...c, to: e.target.value || undefined })} />
        </div>
      );
    case 'added_within':
      return <NumberInput aria-label="Days" min={0} value={c.days} onChange={(days) => onChange({ ...c, days })} />;
    case 'processed':
    case 'analysis_failed':
      return (
        <Select aria-label={CONDITION_LABELS[c.type]} value={c.value ? 'yes' : 'no'} onChange={(e) => onChange({ ...c, value: e.target.value === 'yes' })}>
          <option value="yes">yes</option>
          <option value="no">no</option>
        </Select>
      );
    case 'ai_question':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
          <Textarea aria-label="Question" rows={2} placeholder="e.g. Is this an invoice above 500 €?" value={c.question} onChange={(e) => onChange({ ...c, question: e.target.value })} />
          <Select aria-label="Expected answer" value={c.expect ? 'yes' : 'no'} onChange={(e) => onChange({ ...c, expect: e.target.value === 'yes' })}>
            <option value="yes">answer: yes</option>
            <option value="no">answer: no</option>
          </Select>
        </div>
      );
  }
}

function GroupEditor({ group, onChange, onRemove, data, depth = 0 }: { group: ConditionGroup; onChange: (g: ConditionGroup) => void; onRemove?: () => void; data: EditorData; depth?: number }) {
  const [adding, setAdding] = useState<ConditionType>('tags');
  const set = (i: number, item: Condition | ConditionGroup) => onChange({ ...group, items: group.items.map((x, j) => (j === i ? item : x)) });
  const remove = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  return (
    <div className={cn('space-y-2', depth > 0 && 'rounded-xl border border-dashed border-border p-3')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">{depth > 0 ? 'Group:' : 'Documents where'}</span>
        <Select aria-label="Combine conditions" className="w-56" value={group.op} onChange={(e) => onChange({ ...group, op: e.target.value as 'all' })}>
          <option value="all">all of these match</option>
          <option value="any">any of these matches</option>
        </Select>
        {onRemove && (
          <IconButton label="Remove group" onClick={onRemove}>
            <X className="size-4" />
          </IconButton>
        )}
      </div>
      {group.items.length === 0 && <p className="text-xs text-faint">No condition: every document.</p>}
      {group.items.map((item, i) =>
        isGroup(item) ? (
          <GroupEditor key={i} group={item} depth={depth + 1} data={data} onChange={(g) => set(i, g)} onRemove={() => remove(i)} />
        ) : (
          <div key={i} className="rounded-xl bg-surface-2 p-2.5 ring-1 ring-border">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-fg">{CONDITION_LABELS[item.type]}</span>
              <IconButton label={`Remove condition ${CONDITION_LABELS[item.type]}`} onClick={() => remove(i)}>
                <X className="size-3.5" />
              </IconButton>
            </div>
            <ConditionEditor c={item} data={data} onChange={(c) => set(i, c)} />
          </div>
        ),
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Condition to add" className="w-48" value={adding} onChange={(e) => setAdding(e.target.value as ConditionType)}>
          {(Object.keys(CONDITION_LABELS) as ConditionType[]).map((t) => (
            <option key={t} value={t}>
              {CONDITION_LABELS[t]}
            </option>
          ))}
        </Select>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange({ ...group, items: [...group.items, newCondition(adding)] })}>
          Add condition
        </Button>
        {depth < 2 && (
          <Button size="sm" variant="ghost" icon={<ListTree className="size-3.5" />} onClick={() => onChange({ ...group, items: [...group.items, { op: group.op === 'all' ? 'any' : 'all', items: [] }] })}>
            Add group
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- actions

function ActionEditor({ a, onChange, data, wf }: { a: Action; onChange: (a: Action) => void; data: EditorData; wf: WorkflowDefinition }) {
  const meta = useMetadata();
  const template = (value: string, set: (v: string) => void, label: string) => (
    <Field label={label} hint={`Placeholders: ${TEMPLATE_FIELDS.map((f) => `{${f}}`).join(' ')} {field:Name}`}>
      <Input value={value} onChange={(e) => set(e.target.value)} />
    </Field>
  );
  switch (a.type) {
    case 'set_title':
      return template(a.template, (template) => onChange({ ...a, template }), 'Title');
    case 'add_tags':
    case 'remove_tags':
      return <TagInput value={a.names} onChange={(names) => onChange({ ...a, names })} suggestions={meta.tags.map((t) => t.name)} />;
    case 'set_correspondent':
    case 'set_document_type':
    case 'set_storage_path': {
      const suggestions = a.type === 'set_correspondent' ? meta.correspondents.map((c) => c.name) : a.type === 'set_document_type' ? meta.documentTypes.map((c) => c.name) : (data.ruleInfo?.storagePaths ?? []);
      return (
        <>
          <Input list={`wf-${a.type}`} aria-label="Name" placeholder="Empty: remove it" value={a.name ?? ''} onChange={(e) => onChange({ ...a, name: e.target.value || null })} />
          <datalist id={`wf-${a.type}`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      );
    }
    case 'set_custom_field':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Field" list="wf-custom-fields" placeholder="Field" value={a.name} onChange={(e) => onChange({ ...a, name: e.target.value })} />
          <Input aria-label="Value" placeholder="Value or {placeholder}" value={a.value} onChange={(e) => onChange({ ...a, value: e.target.value })} />
        </div>
      );
    case 'set_owner':
      return <Input aria-label="User name" placeholder="Empty: no owner" value={a.username ?? ''} onChange={(e) => onChange({ ...a, username: e.target.value || null })} />;
    case 'move_to_library':
      return (
        <Select aria-label="Target library" value={a.libraryId || ''} onChange={(e) => onChange({ ...a, libraryId: Number(e.target.value) })}>
          <option value="">Choose a library</option>
          {data.libraries
            .filter((l) => l.id !== wf.libraryId)
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </Select>
      );
    case 'analyze':
      return (
        <div className="space-y-3">
          <Field label="Prompt">
            <Select value={a.prompt === null ? '' : String(a.prompt)} onChange={(e) => onChange({ ...a, prompt: e.target.value ? Number(e.target.value) : null })}>
              <option value="">The system prompt</option>
              {data.prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm text-muted">Settings for these documents</summary>
            <div className="mt-3 space-y-4">
              <OverridesForm overrides={a.overrides} onChange={(patch) => onChange({ ...a, overrides: { ...a.overrides, ...patch } })} info={{ customFields: data.ruleInfo?.customFields ?? [], model: data.ruleInfo?.model ?? '' }} />
            </div>
          </details>
        </div>
      );
    case 'ai_extract':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
          <Textarea aria-label="Question" rows={2} placeholder="e.g. When does the contract end?" value={a.question} onChange={(e) => onChange({ ...a, question: e.target.value })} />
          <Input aria-label="Into the custom field" list="wf-custom-fields" placeholder="Custom field" value={a.field} onChange={(e) => onChange({ ...a, field: e.target.value })} />
        </div>
      );
    case 'add_calendar_event':
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select aria-label="From the date" value={a.source} onChange={(e) => onChange({ ...a, source: e.target.value as 'created' })}>
            <option value="created">Document date</option>
            <option value="custom_field">A date field</option>
          </Select>
          {a.source === 'custom_field' && <Input aria-label="Date field" list="wf-custom-fields" value={a.field ?? ''} onChange={(e) => onChange({ ...a, field: e.target.value })} />}
          <NumberInput aria-label="Days after" value={a.offsetDays} onChange={(offsetDays) => onChange({ ...a, offsetDays })} />
          <Select aria-label="Kind" value={a.kind} onChange={(e) => onChange({ ...a, kind: e.target.value as typeof a.kind })}>
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Input aria-label="Title" className="sm:col-span-2" value={a.title} onChange={(e) => onChange({ ...a, title: e.target.value })} />
        </div>
      );
    case 'notify_email':
    case 'notify_inapp':
      return (
        <div className="space-y-2">
          <IdPicker label="Users" options={data.directory.users} value={a.users} onChange={(users) => onChange({ ...a, users })} />
          <IdPicker label="Groups" options={data.directory.groups} value={a.groups} onChange={(groups) => onChange({ ...a, groups })} />
          {a.type === 'notify_email' && (
            <Field label="More addresses">
              <TagInput value={a.to} onChange={(to) => onChange({ ...a, to })} placeholder="name@example.com" />
            </Field>
          )}
          {template(a.type === 'notify_email' ? a.subject : a.title, (v) => onChange(a.type === 'notify_email' ? { ...a, subject: v } : { ...a, title: v }), a.type === 'notify_email' ? 'Subject' : 'Title')}
          <Field label="Text">
            <Textarea rows={2} value={a.body} onChange={(e) => onChange({ ...a, body: e.target.value })} />
          </Field>
          <p className="text-xs text-faint">Only people who may read the document are notified.</p>
        </div>
      );
    case 'notify_webhook':
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_9rem]">
          <Input aria-label="URL" value={a.url} onChange={(e) => onChange({ ...a, url: e.target.value })} />
          <Select aria-label="Format" value={a.preset} onChange={(e) => onChange({ ...a, preset: e.target.value as 'generic' })}>
            <option value="generic">JSON</option>
            <option value="ntfy">ntfy</option>
            <option value="gotify">Gotify</option>
          </Select>
          <Input aria-label="Secret" className="sm:col-span-2" placeholder="Secret for the signature header (optional)" value={a.secret ?? ''} onChange={(e) => onChange({ ...a, secret: e.target.value || undefined })} />
        </div>
      );
    case 'move_to_trash':
      return <Switch checked={a.confirm} onChange={(confirm) => onChange({ ...a, confirm })} label="Yes, move matching documents to the trash" description="They stay in the trash for the days the library keeps them." />;
    default:
      return <p className="text-xs text-faint">No settings.</p>;
  }
}

// ---------------------------------------------------------------- the editor

function Column({ title, children, step }: { title: string; step: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-baseline gap-2">
        <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent">{step}</span>
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function blankWorkflow(libraryId: number | null): WorkflowDefinition {
  return { name: '', enabled: true, libraryId, trigger: { type: 'document.added' }, conditions: { op: 'all', items: [] }, actions: [], stopAfterMatch: false, allowedLibraries: [] };
}

export function WorkflowEditor({ initial, onSaved, onDeleted }: { initial: Workflow | null; onSaved: (w: Workflow) => void; onDeleted: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMetadata();
  const { session } = useSession();
  const admin = session?.user?.role === 'admin';
  const builtin = Boolean(session?.archive?.capabilities.libraries);
  const libraries = useAsync((signal) => (builtin ? get<LibraryInfo[]>('/api/libraries', signal) : Promise.resolve([] as LibraryInfo[])), [builtin]);
  const ownLibraries = (libraries.data ?? []).filter((l) => admin || l.role === 'owner');
  const [wf, setWf] = useState<WorkflowDefinition>(() =>
    initial ? { name: initial.name, enabled: initial.enabled, libraryId: initial.libraryId, trigger: initial.trigger, conditions: initial.conditions, actions: initial.actions, stopAfterMatch: initial.stopAfterMatch, allowedLibraries: initial.allowedLibraries } : blankWorkflow(null),
  );
  // Owners (not admins) create workflows of their library – the first one they own by default.
  useEffect(() => {
    if (!initial && !admin && wf.libraryId === null && ownLibraries.length) setWf((w) => ({ ...w, libraryId: ownLibraries[0].id }));
  }, [initial, admin, wf.libraryId, ownLibraries]);
  const prompts = useAsync((signal) => get<PromptLibrary>('/api/prompts', signal).then((l) => l.prompts), []);
  const ruleInfo = useAsync((signal) => get<PromptRulesInfo>('/api/prompt-rules', signal).catch(() => null), []);
  const directory = useDirectory(wf.libraryId ?? ownLibraries[0]?.id ?? null, admin);
  const [adding, setAdding] = useState<ActionType>('add_tags');
  const [saving, setSaving] = useState(false);
  const [dry, setDry] = useState(false);
  const locked = Boolean(initial?.locked);
  const data: EditorData = { libraries: libraries.data ?? [], prompts: prompts.data ?? [], ruleInfo: ruleInfo.data ?? null, directory: directory.data ?? { users: [], groups: [] } };
  const analysisOnly = wf.trigger.type === 'analysis.before';
  const actionTypes = (Object.keys(ACTION_LABELS) as ActionType[]).filter(
    (t) => (!analysisOnly || t === 'analyze' || t === 'skip_analysis') && (builtin || t !== 'move_to_library') && (admin || t !== 'notify_webhook'),
  );

  const setTrigger = (type: TriggerType) => {
    const t: Trigger =
      type === 'schedule' ? { type, cron: '0 7 * * 1', limit: 200 } : type === 'date.reached' ? { type, source: 'created', offsetDays: 30 } : type === 'document.added' ? { type, channels: [] } : ({ type } as Trigger);
    setWf((w) => ({ ...w, trigger: t, stopAfterMatch: type === 'analysis.before' ? true : w.stopAfterMatch }));
  };
  const setAction = (i: number, a: Action) =>
    setWf((w) => {
      const actions = w.actions.map((x, j) => (j === i ? a : x));
      // A target library must be among the allowed ones.
      const allowed = [...new Set([...w.allowedLibraries.filter((l) => actions.some((x) => x.type === 'move_to_library' && x.libraryId === l)), ...actions.flatMap((x) => (x.type === 'move_to_library' && x.libraryId ? [x.libraryId] : []))])];
      return { ...w, actions, allowedLibraries: allowed };
    });
  const move = (i: number, d: -1 | 1) =>
    setWf((w) => {
      const actions = [...w.actions];
      [actions[i], actions[i + d]] = [actions[i + d], actions[i]];
      return { ...w, actions };
    });

  const save = async () => {
    setSaving(true);
    try {
      const saved = initial && initial.id > 0 ? await put<Workflow>(`/api/workflows/${initial.id}`, wf) : await post<Workflow>('/api/workflows', wf);
      toast.success('Workflow saved');
      onSaved(saved);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!initial || !(await confirm({ title: `Delete “${initial.name}”?`, message: 'Its run log is kept for a while.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await del(`/api/workflows/${initial.id}`);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="space-y-5">
      <datalist id="wf-custom-fields">
        {meta.customFields.map((f) => (
          <option key={f.id} value={f.name} />
        ))}
      </datalist>
      {locked && <Alert tone="info">This rule comes from the environment variable PROMPT_RULES and cannot be changed here.</Alert>}
      {initial?.suspendedReason && <Alert tone="warn" title="Suspended">{initial.suspendedReason} – saving it again (as an owner) resumes it.</Alert>}
      <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
        <Field label="Name">
          <Input value={wf.name} maxLength={200} placeholder="e.g. Invoices of the utility company" onChange={(e) => setWf({ ...wf, name: e.target.value })} />
        </Field>
        {builtin && (
          <Field label="Library">
            <Select value={wf.libraryId ?? ''} onChange={(e) => setWf({ ...wf, libraryId: e.target.value ? Number(e.target.value) : null })}>
              {admin && <option value="">All libraries (global)</option>}
              {ownLibraries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.2fr)]">
        <Column step="1" title="When">
          <Select aria-label="Trigger" value={wf.trigger.type} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
            {(Object.keys(TRIGGER_LABELS) as TriggerType[])
              .filter((t) => builtin || t !== 'document.version_added')
              .map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABELS[t]}
                </option>
              ))}
          </Select>
          {wf.trigger.type === 'document.added' && (
            <Field label="Only documents that arrived by" hint="None selected: all.">
              <Chips options={INTAKE_CHANNELS} value={wf.trigger.channels ?? []} onChange={(channels) => setWf({ ...wf, trigger: { type: 'document.added', channels } })} />
            </Field>
          )}
          {wf.trigger.type === 'document.updated' && (
            <Field label="When one of these changed" hint="None selected: any change. Changes of this workflow itself never start it again.">
              <Chips options={UPDATE_FIELDS} value={wf.trigger.fields ?? []} onChange={(fields) => setWf({ ...wf, trigger: { type: 'document.updated', fields } })} />
            </Field>
          )}
          {wf.trigger.type === 'schedule' && (
            <>
              <Field label="Schedule (cron)" hint="e.g. 0 7 * * 1 = Mondays at 7:00">
                <Input value={wf.trigger.cron} onChange={(e) => setWf({ ...wf, trigger: { ...(wf.trigger as Extract<Trigger, { type: 'schedule' }>), cron: e.target.value } })} />
              </Field>
              <Field label="Documents with these tags">
                <TagInput value={wf.trigger.tags ?? []} onChange={(tags) => setWf({ ...wf, trigger: { ...(wf.trigger as Extract<Trigger, { type: 'schedule' }>), tags } })} suggestions={meta.tags.map((t) => t.name)} />
              </Field>
              <Field label="… and this search (optional)">
                <Input value={wf.trigger.query ?? ''} onChange={(e) => setWf({ ...wf, trigger: { ...(wf.trigger as Extract<Trigger, { type: 'schedule' }>), query: e.target.value || undefined } })} />
              </Field>
            </>
          )}
          {wf.trigger.type === 'date.reached' && (
            <>
              <Field label="Date">
                <Select value={wf.trigger.source} onChange={(e) => setWf({ ...wf, trigger: { ...(wf.trigger as Extract<Trigger, { type: 'date.reached' }>), source: e.target.value as 'created' } })}>
                  <option value="created">Document date</option>
                  <option value="custom_field">A date field</option>
                  <option value="calendar">A calendar date of the document</option>
                </Select>
              </Field>
              {wf.trigger.source === 'custom_field' && (
                <Field label="Date field">
                  <Input list="wf-custom-fields" value={wf.trigger.field ?? ''} onChange={(e) => setWf({ ...wf, trigger: { ...(wf.trigger as Extract<Trigger, { type: 'date.reached' }>), field: e.target.value } })} />
                </Field>
              )}
              <Field label="Days after the date" hint="Negative: before the date.">
                <NumberInput value={wf.trigger.offsetDays} onChange={(offsetDays) => setWf({ ...wf, trigger: { ...(wf.trigger as Extract<Trigger, { type: 'date.reached' }>), offsetDays } })} />
              </Field>
            </>
          )}
          {analysisOnly && <p className="text-xs text-muted">Shapes the analysis: which prompt and settings, or no analysis at all. This is what prompt rules are.</p>}
          <Switch checked={wf.stopAfterMatch} onChange={(stopAfterMatch) => setWf({ ...wf, stopAfterMatch })} label="Stop after a match" description="Later workflows of this trigger are skipped for the document." />
          <Switch checked={wf.enabled} onChange={(enabled) => setWf({ ...wf, enabled })} label="Enabled" />
        </Column>

        <Column step="2" title="If">
          <GroupEditor group={wf.conditions} data={data} onChange={(conditions) => setWf({ ...wf, conditions })} />
        </Column>

        <Column step="3" title="Then">
          {wf.actions.length === 0 && <p className="text-xs text-faint">No action yet.</p>}
          <ol className="space-y-2">
            {wf.actions.map((a, i) => (
              <li key={i} className="rounded-xl bg-surface-2 p-2.5 ring-1 ring-border">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-fg">
                    {i + 1}. {ACTION_LABELS[a.type]}
                  </span>
                  <span className="flex">
                    <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-3.5" />
                    </IconButton>
                    <IconButton label="Move down" disabled={i === wf.actions.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-3.5" />
                    </IconButton>
                    <IconButton label={`Remove action ${ACTION_LABELS[a.type]}`} onClick={() => setWf((w) => ({ ...w, actions: w.actions.filter((_, j) => j !== i) }))}>
                      <X className="size-3.5" />
                    </IconButton>
                  </span>
                </div>
                <ActionEditor a={a} wf={wf} data={data} onChange={(x) => setAction(i, x)} />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Action to add" className="w-52" value={actionTypes.includes(adding) ? adding : actionTypes[0]} onChange={(e) => setAdding(e.target.value as ActionType)}>
              {actionTypes.map((t) => (
                <option key={t} value={t}>
                  {ACTION_LABELS[t]}
                </option>
              ))}
            </Select>
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setWf((w) => ({ ...w, actions: [...w.actions, newAction(actionTypes.includes(adding) ? adding : actionTypes[0])] }))}>
              Add action
            </Button>
          </div>
        </Column>
      </div>

      <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
        <div className="flex gap-2">
          {initial && initial.id > 0 && !locked && (
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={remove}>
              Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button icon={<FlaskConical className="size-4" />} onClick={() => setDry(true)}>
            Test with a document
          </Button>
          {!locked && (
            <Button variant="primary" loading={saving} disabled={!wf.name.trim()} onClick={() => void save()}>
              Save workflow
            </Button>
          )}
        </div>
      </div>
      {dry && <DryRunModal wf={wf} onClose={() => setDry(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- dry run

function StepList({ steps }: { steps: RunStep[] }) {
  if (!steps.length) return <p className="text-xs text-faint">No steps.</p>;
  return (
    <ol className="space-y-1.5" aria-label="Steps">
      {steps.map((s) => (
        <li key={s.idx} className="rounded-lg bg-surface-2 px-3 py-2 text-sm ring-1 ring-border">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.status === 'matched' || s.status === 'done' ? 'success' : s.status === 'planned' ? 'info' : s.status === 'failed' ? 'danger' : 'neutral'}>{s.status.replace('_', ' ')}</Badge>
            <span className="text-fg">{s.name}</span>
            {s.durationMs !== null && s.durationMs > 50 && <span className="text-xs text-faint">{s.durationMs} ms</span>}
          </div>
          {Object.keys(s.details).length > 0 && (
            <div className="mt-1 font-mono text-[11px] break-all text-muted">
              {Object.entries(s.details)
                .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                .join(' · ')}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function DryRunModal({ wf, onClose }: { wf: WorkflowDefinition; onClose: () => void }) {
  const meta = useMetadata();
  const [doc, setDoc] = useState<number | null>(null);
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (id: number) => {
    setDoc(id);
    setBusy(true);
    setError(null);
    try {
      setResult(await post<DryRunResult>('/api/workflows/dry-run', { documentId: id, workflow: { ...wf, name: wf.name || 'Test' } }));
    } catch (err) {
      setError(errorMessage(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} size="xl" title="Test with a document">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="h-[55vh] min-h-0">
          <DocumentPicker selected={doc} onSelect={(id) => void run(id)} meta={meta} pageSize={8} />
        </div>
        <div className="min-w-0 space-y-3">
          <p className="text-xs text-muted">Nothing is changed. AI questions are really asked (and cached for this version of the document).</p>
          {error && <Alert tone="danger">{error}</Alert>}
          {busy ? (
            <Skeleton className="h-40" />
          ) : result ? (
            <>
              <Alert tone={result.matched ? 'success' : 'info'} title={result.matched ? 'The workflow applies' : 'The workflow does not apply'}>
                {result.tokens ? `${result.tokens} tokens for AI questions.` : undefined}
              </Alert>
              <StepList steps={result.steps} />
              {result.changes.length > 0 && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Changes</h3>
                  <ul className="space-y-0.5 text-sm">
                    {result.changes.map((c, i) => (
                      <li key={i}>
                        <span className="text-muted">{c.field}:</span> <span className="text-faint line-through">{show(c.before)}</span> → <span>{show(c.after)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <EmptyState icon={<FlaskConical className="size-6" />} title="Pick a document" />
          )}
        </div>
      </div>
    </Modal>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '–';
  if (Array.isArray(v)) return v.join(', ') || '–';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ---------------------------------------------------------------- run log

const STATUS_TONE: Record<WorkflowRun['status'], 'success' | 'danger' | 'neutral' | 'info' | 'warn'> = {
  succeeded: 'success',
  failed: 'danger',
  skipped: 'warn',
  not_matched: 'neutral',
  queued: 'info',
  running: 'info',
};

export function RunLog({ workflowId, documentId }: { workflowId?: number; documentId?: number }) {
  const toast = useToast();
  const query = useMemo(() => new URLSearchParams({ ...(workflowId ? { workflowId: String(workflowId) } : {}), ...(documentId ? { documentId: String(documentId) } : {}), limit: '100' }).toString(), [workflowId, documentId]);
  const runs = useAsync((signal) => get<WorkflowRun[]>(`/api/workflows/runs?${query}`, signal), [query]);
  const [open, setOpen] = useState<number | null>(null);
  const detail = useAsync((signal) => (open ? get<WorkflowRun>(`/api/workflows/runs/${open}`, signal) : Promise.resolve(null)), [open]);
  const act = async (url: string, done: string) => {
    try {
      await post(url, {});
      toast.success(done);
      await runs.reload();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  if (runs.error) return <Alert tone="danger">{runs.error}</Alert>;
  if (!runs.data) return <Skeleton className="h-32" />;
  if (!runs.data.length) return <EmptyState icon={<Play className="size-6" />} title="No runs yet" />;
  return (
    <Card bodyClassName="p-0">
      <ul className="divide-y divide-border">
        {runs.data.map((r) => (
          <li key={r.id} className="px-4 py-2.5">
            <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>
              <span className="text-sm text-fg">{workflowId ? (r.documentId ? `Document #${r.documentId}` : '–') : r.workflowName}</span>
              <span className="text-xs text-muted">
                {TRIGGER_LABELS[r.trigger] ?? r.trigger} · {formatDate(r.queuedAt, true)} · {timeAgo(r.queuedAt)}
              </span>
              {r.error && <span className="w-full truncate text-xs text-danger">{r.error}</span>}
            </button>
            {open === r.id && (
              <div className="mt-3 space-y-3">
                {detail.data ? <StepList steps={detail.data.steps ?? []} /> : <Skeleton className="h-16" />}
                <div className="flex gap-2">
                  {r.documentId && (
                    <a className="text-sm text-accent hover:underline" href={`/documents/${r.documentId}`}>
                      Open the document
                    </a>
                  )}
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => void act(`/api/workflows/runs/${r.id}/rerun`, 'Queued again')}>
                    Run again
                  </Button>
                  {r.status === 'succeeded' && (
                    <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => void act(`/api/workflows/runs/${r.id}/undo`, 'Changes undone')}>
                      Undo its changes
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Start a workflow by hand for documents (document page, bulk action). */
export function RunWorkflowModal({ documentIds, onClose }: { documentIds: number[]; onClose: () => void }) {
  const toast = useToast();
  const list = useAsync((signal) => get<Workflow[]>('/api/workflows', signal), []);
  const [busy, setBusy] = useState<number | null>(null);
  const runnable = (list.data ?? []).filter((w) => w.id > 0 && w.enabled && !w.suspendedReason && w.trigger.type !== 'analysis.before');
  const run = async (w: Workflow) => {
    setBusy(w.id);
    try {
      const r = await post<{ queued: number[]; skipped: { id: number; error: string }[] }>(`/api/workflows/${w.id}/run`, { documentIds });
      if (r.skipped.length) toast.error(`${r.skipped.length} skipped: ${r.skipped[0].error}`);
      if (r.queued.length) toast.success(`“${w.name}” started for ${r.queued.length} document(s)`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Run a workflow for ${documentIds.length} document${documentIds.length === 1 ? '' : 's'}`}>
      {list.error && <Alert tone="danger">{list.error}</Alert>}
      {!list.data ? (
        <Skeleton className="h-24" />
      ) : runnable.length === 0 ? (
        <EmptyState icon={<Play className="size-6" />} title="No workflow to run" />
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {runnable.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{w.name}</div>
                <div className="text-xs text-muted">{triggerSummary(w.trigger)}</div>
              </div>
              <Button size="sm" icon={<Play className="size-3.5" />} loading={busy === w.id} onClick={() => void run(w)}>
                Run
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">The conditions of the workflow are checked for each document as usual.</p>
    </Modal>
  );
}
