import { useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Split, Trash2 } from 'lucide-react';
import type { LibraryPrompt } from '@shared/api';
import {
  emptyConditions,
  emptyOverrides,
  matchesEverything,
  RULE_FUNCTIONS,
  RULE_RESTRICTIONS,
  ruleLabel,
  type MatchedPromptRule,
  type PromptRuleConfig,
  type PromptRulesInfo,
  type RuleFunction,
  type RuleRestriction,
} from '@shared/promptRules';
import { Alert, Badge, Button, Card, Field, IconButton, Input, Modal, Select, Skeleton, Switch, TagInput, useConfirm, useToast } from './ui';
import { errorMessage, get, put } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useMetadata } from '../lib/metadata';

const FUNCTION_LABELS: Record<RuleFunction, string> = {
  title: 'Title',
  correspondent: 'Correspondent',
  documentType: 'Document type',
  tags: 'Tags',
  documentDate: 'Document date',
  customFields: 'Custom fields',
  events: 'Calendar dates',
};
const RESTRICTION_LABELS: Record<RuleRestriction, string> = {
  tags: 'Tags',
  correspondents: 'Correspondents',
  documentTypes: 'Document types',
};

type Rule = PromptRulesInfo['rules'][number];

/** The rule as stored (without the information added by the server). */
function toConfig(r: Rule | PromptRuleConfig): PromptRuleConfig {
  return { name: r.name, enabled: r.enabled, prompt: r.prompt, match: r.match, overrides: r.overrides };
}

/** "Tags: Unterricht or Mathe · Type: Arbeitsblatt" */
function describeConditions(r: PromptRuleConfig): string {
  const m = r.match;
  if (matchesEverything(m)) return 'Every document';
  const parts: string[] = [];
  if (m.tagsAny.length) parts.push(`Tag ${m.tagsAny.join(' or ')}`);
  if (m.tagsAll.length) parts.push(`Tags ${m.tagsAll.join(' and ')}`);
  if (m.documentTypes.length) parts.push(`Type ${m.documentTypes.join(' or ')}`);
  if (m.correspondents.length) parts.push(`From ${m.correspondents.join(' or ')}`);
  if (m.storagePaths.length) parts.push(`Storage path ${m.storagePaths.join(' or ')}`);
  if (m.owners.length) parts.push(`Owner ${m.owners.join(' or ')}`);
  if (m.customField) parts.push(m.customField.value ? `${m.customField.name} = ${m.customField.value}` : `${m.customField.name} set`);
  return parts.join(' · ');
}

function describeOverrides(r: PromptRuleConfig): string[] {
  const o = r.overrides;
  const out: string[] = [];
  const off = RULE_FUNCTIONS.filter((f) => o.functions[f] === false).map((f) => FUNCTION_LABELS[f].toLowerCase());
  const on = RULE_FUNCTIONS.filter((f) => o.functions[f] === true).map((f) => FUNCTION_LABELS[f].toLowerCase());
  if (off.length) out.push(`no ${off.join(', ')}`);
  if (on.length) out.push(`also ${on.join(', ')}`);
  if (o.customFields) out.push(`fields: ${o.customFields.join(', ') || 'none'}`);
  const only = RULE_RESTRICTIONS.filter((k) => o.restrict[k] === true).map((k) => RESTRICTION_LABELS[k].toLowerCase());
  if (only.length) out.push(`only existing ${only.join(', ')}`);
  if (o.allowedTags) out.push(`tags from a list (${o.allowedTags.length})`);
  if (o.allowedDocumentTypes) out.push(`types from a list (${o.allowedDocumentTypes.length})`);
  if (o.model) out.push(`model ${o.model}`);
  return out;
}

/** Prompt library: which prompt and settings documents are analysed with. */
export function PromptRulesCard({ prompts, onChanged }: { prompts: LibraryPrompt[]; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const info = useAsync((signal) => get<PromptRulesInfo>('/api/prompt-rules', signal), []);
  const [editing, setEditing] = useState<{ index: number | null; rule: PromptRuleConfig } | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = info.data?.rules ?? [];
  const locked = info.data?.locked ?? null;

  const save = async (next: PromptRuleConfig[], message?: string) => {
    setBusy(true);
    try {
      info.setData(await put<PromptRulesInfo>('/api/prompt-rules', { rules: next }));
      if (message) toast.success(message);
      onChanged();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const list = () => rules.map(toConfig);
  const move = (index: number, by: number) => {
    const next = list();
    const [rule] = next.splice(index, 1);
    next.splice(index + by, 0, rule);
    void save(next);
  };
  const remove = async (index: number) => {
    if (!(await confirm({ title: `Delete “${ruleLabel(rules[index], index)}”?`, message: 'Documents it applied to are analysed with the next matching rule or the system prompt.', confirmLabel: 'Delete', danger: true })))
      return;
    void save(list().filter((_, i) => i !== index), 'Rule deleted');
  };
  const add = () => {
    const prompt = prompts[0];
    if (prompt) setEditing({ index: null, rule: { name: '', enabled: true, prompt: prompt.id, match: emptyConditions(), overrides: emptyOverrides() } });
  };

  return (
    <Card
      className="mb-6"
      icon={<Split className="size-4" />}
      title="Prompt rules"
      description="Analyse documents with different prompts and settings – e.g. by a tag set by a Paperless workflow. The first matching rule wins; other documents get the system prompt."
      actions={
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={Boolean(locked) || !prompts.length || busy} onClick={add}>
          Add rule
        </Button>
      }
    >
      {info.error && <Alert tone="danger">{info.error}</Alert>}
      {locked && (
        <Alert tone="warn" className="mb-3">
          The rules are set by the environment variable {locked} and cannot be changed here.
        </Alert>
      )}
      {!info.data ? (
        <Skeleton className="h-16" />
      ) : !rules.length ? (
        <p className="text-sm text-muted">
          {prompts.length ? 'No rules yet – every document is analysed with the system prompt.' : 'Keep a prompt in the library first, then add a rule that uses it.'}
        </p>
      ) : (
        <ol className="space-y-2" aria-label="Prompt rules">
          {rules.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-2.5" aria-label={ruleLabel(r, i)}>
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{ruleLabel(r, i)}</span>
                  <span className="text-muted">→</span>
                  <Badge tone={r.promptName ? 'accent' : 'danger'}>{r.promptName ?? 'prompt missing'}</Badge>
                  {!r.enabled && <Badge>off</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-muted">{describeConditions(r)}</div>
                {describeOverrides(r).length > 0 && <div className="mt-0.5 text-xs text-faint">{describeOverrides(r).join(' · ')}</div>}
                {r.problem && <div className="mt-1 text-xs text-danger">{r.problem}</div>}
              </div>
              {!locked && (
                <div className="flex w-full shrink-0 items-center justify-end gap-1 sm:w-auto">
                  <Switch
                    label={<span className="sr-only">Rule {i + 1} enabled</span>}
                    checked={r.enabled}
                    disabled={busy}
                    onChange={(v) => void save(list().map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
                  />
                  <IconButton label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton label="Move down" disabled={busy || i === rules.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton label="Edit rule" onClick={() => setEditing({ index: i, rule: toConfig(r) })}>
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Delete rule" onClick={() => void remove(i)}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {editing && info.data && (
        <RuleEditor
          initial={editing.rule}
          title={editing.index === null ? 'New prompt rule' : `Edit “${ruleLabel(editing.rule, editing.index)}”`}
          prompts={prompts}
          info={info.data}
          onClose={() => setEditing(null)}
          onSave={async (rule) => {
            const next = list();
            if (editing.index === null) next.push(rule);
            else next[editing.index] = rule;
            if (await save(next, 'Prompt rules saved')) setEditing(null);
          }}
        />
      )}
    </Card>
  );
}

/** "As in the settings" / on / off */
function TriState({ label, value, onChange }: { label: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <Field label={label}>
      <Select value={value === undefined ? '' : value ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'on')}>
        <option value="">As in the settings</option>
        <option value="on">Yes</option>
        <option value="off">No</option>
      </Select>
    </Field>
  );
}

function RuleEditor({
  initial,
  title,
  prompts,
  info,
  onClose,
  onSave,
}: {
  initial: PromptRuleConfig;
  title: string;
  prompts: LibraryPrompt[];
  info: PromptRulesInfo;
  onClose: () => void;
  onSave: (rule: PromptRuleConfig) => Promise<void>;
}) {
  const meta = useMetadata();
  const [rule, setRule] = useState<PromptRuleConfig>(initial);
  const [saving, setSaving] = useState(false);
  const m = rule.match;
  const o = rule.overrides;
  const setMatch = (patch: Partial<PromptRuleConfig['match']>) => setRule((r) => ({ ...r, match: { ...r.match, ...patch } }));
  const setOverrides = (patch: Partial<PromptRuleConfig['overrides']>) => setRule((r) => ({ ...r, overrides: { ...r.overrides, ...patch } }));
  const promptId = typeof rule.prompt === 'number' ? rule.prompt : prompts.find((p) => p.name.toLowerCase() === String(rule.prompt).toLowerCase())?.id;
  const tagNames = meta.tags.map((t) => t.name);
  const typeNames = meta.documentTypes.map((t) => t.name);
  const submit = async () => {
    setSaving(true);
    try {
      await onSave(rule);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!promptId} onClick={() => void submit()}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Shown in the history and the manual review. Empty: “Rule n”.">
            <Input value={rule.name} placeholder="e.g. Teaching material" onChange={(e) => setRule({ ...rule, name: e.target.value })} />
          </Field>
          <Field label="Prompt from the library">
            <Select value={promptId ?? ''} onChange={(e) => setRule({ ...rule, prompt: Number(e.target.value) })}>
              {!promptId && <option value="">Choose a prompt</option>}
              {prompts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.useCase ? ` (${p.useCase})` : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <section className="space-y-4" aria-label="Conditions">
          <div>
            <h3 className="text-sm font-semibold">Documents it applies to</h3>
            <p className="text-xs text-muted">All conditions that are filled in must match. Without any condition the rule applies to every document – put such a rule last.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="One of these tags">
              <TagInput value={m.tagsAny} onChange={(v) => setMatch({ tagsAny: v })} suggestions={tagNames} placeholder="e.g. Unterricht" />
            </Field>
            <Field label="All of these tags">
              <TagInput value={m.tagsAll} onChange={(v) => setMatch({ tagsAll: v })} suggestions={tagNames} />
            </Field>
            <Field label="Document type">
              <TagInput value={m.documentTypes} onChange={(v) => setMatch({ documentTypes: v })} suggestions={typeNames} />
            </Field>
            <Field label="Correspondent">
              <TagInput value={m.correspondents} onChange={(v) => setMatch({ correspondents: v })} suggestions={meta.correspondents.map((c) => c.name)} />
            </Field>
            <Field label="Storage path">
              <TagInput value={m.storagePaths} onChange={(v) => setMatch({ storagePaths: v })} suggestions={info.storagePaths} />
            </Field>
            <Field label="Owner" hint={info.owners.length ? undefined : 'Paperless user names – or user ids, if Paperless-AI may not view the users.'}>
              <TagInput value={m.owners} onChange={(v) => setMatch({ owners: v })} suggestions={info.owners} />
            </Field>
            <Field label="Custom field">
              <Select
                value={m.customField?.name ?? ''}
                onChange={(e) => setMatch({ customField: e.target.value ? { name: e.target.value, value: m.customField?.value ?? '' } : null })}
              >
                <option value="">No condition</option>
                {[...new Set([...meta.customFields.map((f) => f.name), ...(m.customField ? [m.customField.name] : [])])].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            {m.customField && (
              <Field label="… with the value" hint="Empty: the field has any value.">
                <Input value={m.customField.value} onChange={(e) => setMatch({ customField: { name: m.customField!.name, value: e.target.value } })} />
              </Field>
            )}
          </div>
        </section>

        <section className="space-y-4" aria-label="Settings for these documents">
          <div>
            <h3 className="text-sm font-semibold">Settings for these documents</h3>
            <p className="text-xs text-muted">Everything left at “As in the settings” keeps the processing settings.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {RULE_FUNCTIONS.map((f) => (
              <TriState key={f} label={FUNCTION_LABELS[f]} value={o.functions[f]} onChange={(v) => setOverrides({ functions: { ...o.functions, [f]: v } })} />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {RULE_RESTRICTIONS.map((k) => (
              <TriState
                key={k}
                label={`Only existing ${RESTRICTION_LABELS[k].toLowerCase()}`}
                value={o.restrict[k]}
                onChange={(v) => setOverrides({ restrict: { ...o.restrict, [k]: v } })}
              />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Custom fields to fill" hint="Of the custom fields in the settings. Empty: all of them.">
              <TagInput value={o.customFields ?? []} onChange={(v) => setOverrides({ customFields: v.length ? v : null })} suggestions={info.customFields} />
            </Field>
            <Field label="Model" hint={`Of the configured AI provider. Empty: ${info.model || 'the model of the AI settings'}.`}>
              <Input value={o.model} placeholder={info.model} onChange={(e) => setOverrides({ model: e.target.value })} />
            </Field>
            <Field label="Allowed tags" hint="The AI may only use these tags (created when missing). Empty: no list.">
              <TagInput value={o.allowedTags ?? []} onChange={(v) => setOverrides({ allowedTags: v.length ? v : null })} suggestions={tagNames} />
            </Field>
            <Field label="Allowed document types" hint="The AI may only choose one of these types (created when missing). Empty: no list.">
              <TagInput value={o.allowedDocumentTypes ?? []} onChange={(v) => setOverrides({ allowedDocumentTypes: v.length ? v : null })} suggestions={typeNames} />
            </Field>
          </div>
        </section>

        <Switch label="Rule enabled" checked={rule.enabled} onChange={(v) => setRule({ ...rule, enabled: v })} />
      </div>
    </Modal>
  );
}

/** Which prompt rule a document is (or would be) analysed with – manual review and playground. */
export function RuleBadge({ rule, fallback = true }: { rule: MatchedPromptRule | null | undefined; fallback?: boolean }) {
  if (!rule) return fallback ? <Badge title="No prompt rule applies to this document">System prompt</Badge> : null;
  return (
    <Badge tone="info" title={`Prompt rule “${rule.name}”${rule.model ? ` · model ${rule.model}` : ''}`}>
      <Split className="size-3" /> {rule.promptName}
      <span className="opacity-70">· {rule.name}</span>
    </Badge>
  );
}
