/**
 * Actions of workflows (docs/standalone/workflows.md §5). Field changes are collected and written
 * with one `updateDocument` call per stretch of field actions (one change log entry, one
 * `modified`); other actions (notifications, OCR, trash …) run in between, in order. A failing
 * action stops the run; what was written stays and is attributed to the run (`ref = run:<id>`).
 */
import type { AppContext } from '../context.js';
import type { AccessScope, LibraryRole } from '../access/scope.js';
import type { ArchiveDocument, ChangeOrigin, DocumentPatch } from '../backend/types.js';
import type { PromptRow } from '../db/promptsRepo.js';
import { convertCustomFieldValue, snapshotOf, truncateTitle } from '../processing/applier.js';
import { rulePrompt } from '../processing/promptRules.js';
import { normalizeName } from '../backend/metadata.js';
import { datePart } from '../processing/dates.js';
import { extractWithAi, type EvalEnv } from './evaluate.js';
import { notifyInApp, notifyWebhook, sendMail, userAddresses, type NotifySubject } from './notify.js';
import type { Action, RunStep, Workflow } from '../../shared/workflows.js';
import type { PromptRuleOverrides } from '../../shared/promptRules.js';

/** What the engine lets actions do outside the archive. */
export interface ActionHooks {
  /** Queue an AI analysis (with a library prompt and overrides) or an OCR run. */
  enqueue?: (documentId: number, opts: { ocr?: boolean; analysis?: { prompt: PromptRow | null; overrides: PromptRuleOverrides; workflow: string } }) => void;
  /** skip_analysis outside `analysis.before`: the pending analysis of a new document is skipped. */
  skipAnalysis?: (documentId: number, reason: string) => void;
}

export interface ActionEnv extends EvalEnv {
  workflow: Pick<Workflow, 'id' | 'name' | 'libraryId' | 'allowedLibraries'>;
  runId: number | null;
  dryRun: boolean;
  hooks: ActionHooks;
  /** Field changes (before → after) – shown by the dry run and the run log. */
  changes: { field: string; before: unknown; after: unknown }[];
}

/** The scope a workflow acts with: its library (and the allowed targets), or everything (global). */
export function workflowScope(ctx: AppContext, wf: Pick<Workflow, 'id' | 'libraryId' | 'allowedLibraries'>): AccessScope {
  const libraries =
    wf.libraryId === null || !ctx.archive().capabilities.libraries
      ? null
      : new Map<number, LibraryRole>(
          // Deleted libraries are no targets any more (moving into one would hide the documents).
          [wf.libraryId, ...wf.allowedLibraries].filter((l) => !ctx.repos.libraries.get(l)?.deleted_at).map((l) => [l, 'editor'] as [number, LibraryRole]),
        );
  return { principal: { kind: 'workflow', workflowId: wf.id, libraryId: wf.libraryId }, libraries, scopes: null };
}

export function originOf(env: Pick<ActionEnv, 'workflow' | 'runId'>): ChangeOrigin {
  return { actor: 'workflow', actorId: env.workflow.id, ref: env.runId ? `run:${env.runId}` : null };
}

const FIELD_ACTIONS = new Set<Action['type']>(['set_title', 'add_tags', 'remove_tags', 'set_correspondent', 'set_document_type', 'set_storage_path', 'set_custom_field', 'assign_asn', 'set_owner', 'move_to_library', 'ai_extract']);

export function actionLabel(a: Action): string {
  switch (a.type) {
    case 'set_title':
      return `Set the title to “${a.template}”`;
    case 'add_tags':
      return `Add tags ${a.names.join(', ')}`;
    case 'remove_tags':
      return `Remove tags ${a.names.join(', ')}`;
    case 'set_correspondent':
      return a.name ? `Set the correspondent to ${a.name}` : 'Remove the correspondent';
    case 'set_document_type':
      return a.name ? `Set the document type to ${a.name}` : 'Remove the document type';
    case 'set_storage_path':
      return a.name ? `Set the storage path to ${a.name}` : 'Remove the storage path';
    case 'set_custom_field':
      return `Set “${a.name}” to ${a.value}`;
    case 'assign_asn':
      return 'Assign the next archive serial number';
    case 'set_owner':
      return a.username ? `Set the owner to ${a.username}` : 'Remove the owner';
    case 'move_to_library':
      return `Move to library #${a.libraryId}`;
    case 'analyze':
      return `Analyse with ${a.prompt === null ? 'the system prompt' : `the prompt ${typeof a.prompt === 'number' ? `#${a.prompt}` : `“${a.prompt}”`}`}`;
    case 'skip_analysis':
      return 'Skip the AI analysis';
    case 'run_ocr':
      return 'Read with OCR';
    case 'ai_extract':
      return `AI: ${a.question} → “${a.field}”`;
    case 'add_calendar_event':
      return `Calendar: ${a.title}`;
    case 'notify_email':
      return `E-mail: ${a.subject}`;
    case 'notify_webhook':
      return `Webhook ${safeHost(a.url)}`;
    case 'notify_inapp':
      return `Notification: ${a.title}`;
    case 'move_to_trash':
      return 'Move to the trash';
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- templates

async function templateValues(env: ActionEnv): Promise<Record<string, string>> {
  const { doc, meta, intake } = env.subject;
  await meta.snapshot();
  const created = datePart(doc.created_date ?? doc.created) ?? '';
  const lib = doc.library_id != null ? env.ctx.repos.libraries.get(doc.library_id)?.name : undefined;
  return {
    title: doc.title ?? '',
    correspondent: meta.correspondentName(doc.correspondent) ?? '',
    document_type: meta.documentTypeName(doc.document_type) ?? '',
    created,
    created_year: created.slice(0, 4),
    created_month: created.slice(5, 7),
    added: (doc.added ?? '').slice(0, 10),
    library: lib ?? '',
    asn: doc.archive_serial_number != null ? String(doc.archive_serial_number) : '',
    mail_from: intake.mailFrom ?? '',
    mail_subject: intake.mailSubject ?? '',
    filename: intake.filename ?? doc.original_file_name ?? '',
  };
}

/** `{name}` and `{field:<custom field>}` – values are inserted as text, missing ones are empty. */
export async function renderTemplate(template: string, env: ActionEnv): Promise<string> {
  const values = await templateValues(env);
  const { doc, meta } = env.subject;
  return template
    // No "{" in the name and a bounded length: linear, also on templates full of "{field:".
    .replace(/\{field:([^{}]{1,128})\}/g, (_, name: string) => {
      const def = meta.customFieldByName(name.trim());
      const v = def ? (doc.custom_fields ?? []).find((f) => f.field === def.id)?.value : undefined;
      return v === null || v === undefined ? '' : String(v);
    })
    .replace(/\{([a-z_]+)\}/g, (m, key: string) => (key in values ? values[key] : m))
    .trim();
}

// ---------------------------------------------------------------- the actions

/** Link for e-mails and webhooks: absolute with the public address of Paperless-AI when it is set. */
function absoluteLink(ctx: AppContext, id: number): string {
  const link = ctx.documentLink(id);
  return /^https?:\/\//.test(link) ? link : `${ctx.cfg.auth.publicUrl}${link}`;
}

export function notifySubject(env: EvalEnv): NotifySubject {
  const { doc, meta } = env.subject;
  return {
    documentId: doc.id,
    libraryId: doc.library_id ?? null,
    title: doc.title ?? `Document ${doc.id}`,
    correspondent: meta.correspondentName(doc.correspondent),
    documentType: meta.documentTypeName(doc.document_type),
    created: datePart(doc.created_date ?? doc.created),
    tags: (doc.tags ?? []).map((t) => meta.tagName(t)).filter((t): t is string => Boolean(t)),
    url: absoluteLink(env.ctx, doc.id),
  };
}

interface Pending {
  patch: DocumentPatch;
  steps: RunStep[];
}

/** Run (or, in a dry run, plan) the actions. Throws when one fails – after recording its step. */
export async function runActions(actions: Action[], env: ActionEnv): Promise<void> {
  const pending: Pending = { patch: {}, steps: [] };
  for (const action of actions) {
    const step: RunStep = { idx: env.steps.length, kind: 'action', name: actionLabel(action), status: env.dryRun ? 'planned' : 'done', details: {}, durationMs: null };
    env.steps.push(step);
    const started = Date.now();
    try {
      if (FIELD_ACTIONS.has(action.type)) {
        await planField(action, pending.patch, step, env);
        pending.steps.push(step);
      } else {
        await flush(pending, env);
        await sideEffect(action, step, env);
      }
    } catch (err) {
      step.status = 'failed';
      step.details = { ...step.details, error: err instanceof Error ? err.message : String(err) };
      throw err;
    } finally {
      step.durationMs = Date.now() - started;
    }
  }
  await flush(pending, env);
}

/** Current tags of the document, with the changes planned so far. */
function workingTags(patch: DocumentPatch, doc: ArchiveDocument): number[] {
  return patch.tags ?? [...(doc.tags ?? [])];
}

async function planField(action: Action, patch: DocumentPatch, step: RunStep, env: ActionEnv): Promise<void> {
  const { doc, meta } = env.subject;
  await meta.snapshot();
  const create = !env.dryRun;
  const note = (field: string, before: unknown, after: unknown) => {
    step.details = { ...step.details, [field]: after };
    env.changes.push({ field, before, after });
  };
  switch (action.type) {
    case 'set_title': {
      const title = truncateTitle(await renderTemplate(action.template, env));
      if (!title) throw new Error('The title template gives an empty title');
      patch.title = title;
      note('title', doc.title, title);
      return;
    }
    case 'add_tags':
    case 'remove_tags': {
      const current = workingTags(patch, doc);
      if (action.type === 'add_tags') {
        const res = await meta.resolveTags(action.names, create);
        const next = [...new Set([...current, ...res.ids])];
        if (next.length !== current.length) patch.tags = next;
        note('tags', current.map((t) => meta.tagName(t)), [...current.map((t) => meta.tagName(t)), ...res.missing, ...res.ids.filter((i) => !current.includes(i)).map((t) => meta.tagName(t))].filter(Boolean));
      } else {
        const remove = new Set(action.names.map(normalizeName));
        const next = current.filter((t) => !remove.has(normalizeName(meta.tagName(t) ?? '')));
        if (next.length !== current.length) patch.tags = next;
        note('tags', current.map((t) => meta.tagName(t)), next.map((t) => meta.tagName(t)));
      }
      return;
    }
    case 'set_correspondent': {
      const id = action.name ? (await meta.resolveCorrespondent(action.name, create)).id : null;
      if (action.name && id === null && create) throw new Error(`The correspondent “${action.name}” could not be created`);
      patch.correspondent = id;
      note('correspondent', meta.correspondentName(doc.correspondent), action.name);
      return;
    }
    case 'set_document_type': {
      const id = action.name ? (await meta.resolveDocumentType(action.name, create)).id : null;
      if (action.name && id === null && create) throw new Error(`The document type “${action.name}” could not be created`);
      patch.document_type = id;
      note('document_type', meta.documentTypeName(doc.document_type), action.name);
      return;
    }
    case 'set_storage_path': {
      let id: number | null = null;
      if (action.name) {
        const wanted = normalizeName(action.name);
        id = (await meta.extras()).storagePaths.find((p) => normalizeName(p.name) === wanted)?.id ?? null;
        if (id === null) throw new Error(`The storage path “${action.name}” does not exist`);
      }
      patch.storage_path = id;
      note('storage_path', doc.storage_path ?? null, action.name);
      return;
    }
    case 'set_custom_field':
    case 'ai_extract': {
      const def = meta.customFieldByName(action.type === 'set_custom_field' ? action.name : action.field);
      const name = action.type === 'set_custom_field' ? action.name : action.field;
      if (!def) throw new Error(`The custom field “${name}” does not exist`);
      let text: string | null;
      if (action.type === 'set_custom_field') text = await renderTemplate(action.value, env);
      else {
        const res = await extractWithAi(env, action.question);
        step.details = { ...step.details, answer: res.value, reason: res.reason, cached: res.cached };
        text = res.value;
        if (text === null) return; // nothing found: no change
      }
      const value = text === '' ? null : convertCustomFieldValue(def, text);
      const fields = (patch.custom_fields ?? (doc.custom_fields ?? []).map((f) => ({ field: f.field, value: f.value }))).filter((f) => f.field !== def.id);
      fields.push({ field: def.id, value });
      patch.custom_fields = fields;
      note(`field:${def.name}`, (doc.custom_fields ?? []).find((f) => f.field === def.id)?.value ?? null, value);
      return;
    }
    case 'assign_asn': {
      if (doc.archive_serial_number != null || patch.archive_serial_number != null) {
        step.details = { kept: doc.archive_serial_number };
        return;
      }
      const next = env.ctx.archive().nextAsn ? await env.ctx.archive().nextAsn!(doc.library_id ?? null) : null;
      if (next === null) throw new Error('This archive cannot assign archive serial numbers');
      patch.archive_serial_number = next;
      note('archive_serial_number', null, next);
      return;
    }
    case 'set_owner': {
      let id: number | null = null;
      if (action.username) {
        const wanted = normalizeName(action.username);
        if (env.ctx.archive().capabilities.libraries) id = env.ctx.repos.users.list().find((u) => normalizeName(u.username) === wanted)?.id ?? null;
        else id = (await meta.extras()).users.find((u) => normalizeName(u.username) === wanted)?.id ?? null;
        if (id === null) throw new Error(`The user “${action.username}” does not exist`);
      }
      patch.owner = id;
      note('owner', doc.owner ?? null, action.username);
      return;
    }
    case 'move_to_library': {
      if (!env.ctx.archive().capabilities.libraries) throw new Error('Libraries exist only in the built-in archive');
      if (!env.workflow.allowedLibraries.includes(action.libraryId)) throw new Error('The library is not among the allowed targets of the workflow');
      if (doc.library_id === action.libraryId) {
        step.details = { kept: true };
        return;
      }
      patch.library_id = action.libraryId;
      note('library', env.ctx.repos.libraries.get(doc.library_id ?? -1)?.name ?? doc.library_id, env.ctx.repos.libraries.get(action.libraryId)?.name ?? action.libraryId);
      return;
    }
    default:
      return;
  }
}

/** Write the collected field changes in one update. */
async function flush(pending: Pending, env: ActionEnv): Promise<void> {
  if (!Object.keys(pending.patch).length) {
    pending.steps = [];
    return;
  }
  const patch = pending.patch;
  pending.patch = {};
  const steps = pending.steps;
  pending.steps = [];
  if (env.dryRun) {
    // Later templates see the planned values.
    env.subject.doc = { ...env.subject.doc, ...(patch as Partial<ArchiveDocument>) };
    return;
  }
  const { ctx } = env;
  const before = env.subject.doc;
  const origin = originOf(env);
  try {
    const updated = await ctx.backend(workflowScope(ctx, env.workflow)).updateDocument(before.id, patch, origin);
    // Companion mode: the change appears in the history (with undo) like other changes made here.
    if (!ctx.archive().capabilities.fullChangeLog) {
      ctx.repos.history.add({
        documentId: before.id,
        source: 'workflow',
        model: env.workflow.name,
        title: updated.title ?? null,
        correspondent: env.subject.meta.correspondentName(updated.correspondent),
        documentType: env.subject.meta.documentTypeName(updated.document_type),
        tags: updated.tags ?? [],
        before: snapshotOf(before),
        after: patch as Record<string, unknown>,
      });
    }
    env.subject.doc = updated;
    ctx.events.emit({ type: 'document.updated', id: before.id, fields: Object.keys(patch), origin, libraryId: updated.library_id ?? null });
  } catch (err) {
    for (const s of steps) s.status = 'failed';
    throw err;
  }
}

async function sideEffect(action: Action, step: RunStep, env: ActionEnv): Promise<void> {
  const { ctx } = env;
  const { doc } = env.subject;
  switch (action.type) {
    case 'analyze': {
      const prompt = action.prompt === null ? null : (rulePrompt(ctx, { prompt: action.prompt }) ?? null);
      if (action.prompt !== null && !prompt) throw new Error(`The prompt ${typeof action.prompt === 'number' ? `#${action.prompt}` : `“${action.prompt}”`} is not in the prompt library`);
      step.details = { prompt: prompt?.name ?? 'system prompt' };
      if (!env.dryRun) {
        if (!env.hooks.enqueue) throw new Error('The analysis cannot be queued here');
        env.hooks.enqueue(doc.id, { analysis: { prompt, overrides: action.overrides, workflow: env.workflow.name } });
      }
      return;
    }
    case 'skip_analysis':
      if (!env.dryRun) env.hooks.skipAnalysis?.(doc.id, `Not analysed (workflow “${env.workflow.name}”)`);
      return;
    case 'run_ocr':
      if (!env.dryRun) {
        if (!env.hooks.enqueue) throw new Error('OCR cannot be queued here');
        env.hooks.enqueue(doc.id, { ocr: true });
      }
      return;
    case 'add_calendar_event': {
      let base: string | null;
      if (action.source === 'created') base = datePart(doc.created_date ?? doc.created);
      else {
        const def = env.subject.meta.customFieldByName(action.field ?? '');
        const v = def ? (doc.custom_fields ?? []).find((f) => f.field === def.id)?.value : null;
        base = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
      }
      if (!base) throw new Error('The document has no such date');
      const d = new Date(`${base}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + action.offsetDays);
      const date = d.toISOString().slice(0, 10);
      const title = await renderTemplate(action.title, env);
      step.details = { date, title };
      if (!env.dryRun) ctx.repos.calendar.addEvent(doc.id, doc.title ?? null, { title, date, time: null, kind: action.kind });
      return;
    }
    case 'notify_inapp': {
      const subject = notifySubject(env);
      const title = await renderTemplate(action.title, env);
      const body = await renderTemplate(action.body, env);
      if (env.dryRun) {
        step.details = { title, recipients: action.users.length + action.groups.length };
        return;
      }
      const to = notifyInApp(ctx, subject, action.users, action.groups, title, body);
      step.details = { title, delivered: to.length };
      return;
    }
    case 'notify_email': {
      const subject = notifySubject(env);
      const to = [...action.to, ...userAddresses(ctx, subject, action.users, action.groups)];
      const mailSubject = await renderTemplate(action.subject, env);
      const body = `${await renderTemplate(action.body, env)}\n\n${subject.url}`;
      if (env.dryRun) {
        step.details = { subject: mailSubject, to };
        return;
      }
      const res = await sendMail(ctx, [...new Set(to)], mailSubject, body);
      step.details = { subject: mailSubject, to: to.length, accepted: res.accepted, attempts: res.attempts };
      return;
    }
    case 'notify_webhook': {
      if (env.dryRun) {
        step.details = { url: action.previewHost ?? safeHost(action.url), preset: action.preset };
        return;
      }
      const res = await notifyWebhook(action.url, action.preset, action.secret, {
        event: 'workflow',
        workflow: { id: env.workflow.id, name: env.workflow.name },
        document: notifySubject(env),
        changes: env.changes,
      });
      step.details = { host: safeHost(action.url), status: res.status, attempts: res.attempts };
      return;
    }
    case 'move_to_trash': {
      if (!action.confirm) throw new Error('Moving to the trash was not confirmed in the workflow');
      if (env.dryRun) return;
      const origin = originOf(env);
      await ctx.backend(workflowScope(ctx, env.workflow)).deleteDocument(doc.id, origin);
      ctx.events.emit({ type: 'document.deleted', id: doc.id, origin, libraryId: doc.library_id ?? null });
      return;
    }
    default:
      return;
  }
}
