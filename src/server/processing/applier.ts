/**
 * Turns an AI suggestion (or a manual edit) into a Paperless PATCH, applies
 * it and records an undoable history entry.
 */
import type { AnalysisResult, DocumentSnapshot, DocumentSuggestion } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { AccessScope } from '../access/scope.js';
import type { AppConfig } from '../config/schema.js';
import { normalizeName } from '../backend/metadata.js';
import { statusOf, type ArchiveDocument, type ChangeOrigin, type CustomField, type CustomFieldType, type DocumentPatch } from '../backend/types.js';
import { logger } from '../logger.js';
import { datePart, normalizeDate } from './dates.js';
import { localDate } from './prompt.js';

const log = logger.child({ module: 'applier' });

export const MAX_TITLE_LENGTH = 128;

export interface PlannedUpdate {
  patch: DocumentPatch;
  display: { title: string | null; correspondent: string | null; documentType: string | null; tags: number[] };
  notes: string[];
}

export function snapshotOf(doc: ArchiveDocument): DocumentSnapshot {
  return {
    title: doc.title,
    tags: [...(doc.tags ?? [])],
    correspondent: doc.correspondent ?? null,
    document_type: doc.document_type ?? null,
    created: datePart(doc.created_date ?? doc.created),
    custom_fields: (doc.custom_fields ?? []).map((f) => ({ field: f.field, value: f.value })),
  };
}

export function truncateTitle(title: string): string {
  const t = title.trim();
  return t.length > MAX_TITLE_LENGTH ? `${t.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : t;
}

/** Parse numbers written in German or English notation ("1.234,56", "1,234.56", "12,50 €"). */
export function parseNumber(input: string): number | null {
  let t = input.replace(/[^\d,.-]/g, '');
  if (!t || !/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma > -1) {
    t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(t)) {
    t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Convert a textual AI value into the representation Paperless expects for the field type. */
export function convertCustomFieldValue(field: CustomField, value: string, currency?: string): unknown {
  const v = value.trim();
  switch (field.data_type) {
    case 'string':
      return v.replace(/\s+/g, ' ').slice(0, 128);
    case 'longtext':
      return v;
    case 'url': {
      const url = /^www\./i.test(v) ? `https://${v}` : v;
      // Paperless validates URLs strictly – an invalid one would make it reject the whole update.
      if (/\s/.test(url) || !/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(url) || !URL.canParse(url)) return undefined;
      return url;
    }
    case 'date':
      return normalizeDate(v) ?? undefined;
    case 'boolean':
      if (/^(true|yes|ja|1|wahr|oui|si)$/i.test(v)) return true;
      if (/^(false|no|nein|0|falsch|non)$/i.test(v)) return false;
      return undefined;
    case 'integer': {
      const n = parseNumber(v);
      return n === null ? undefined : Math.round(n);
    }
    case 'float': {
      const n = parseNumber(v);
      return n === null ? undefined : n;
    }
    case 'monetary': {
      const n = parseNumber(v);
      if (n === null) return undefined;
      const cur = (field.extra_data?.default_currency || currency || /\b([A-Z]{3})\b/.exec(v)?.[1] || '').toUpperCase();
      return `${cur}${n.toFixed(2)}`;
    }
    case 'select': {
      // Paperless < 2.15 stores plain string options and the option index as value; newer
      // versions use {id, label} options and the option id.
      const options = field.extra_data?.select_options ?? [];
      const idx = options.findIndex((o) => normalizeName(typeof o === 'string' ? o : o.label) === normalizeName(v));
      if (idx < 0) return undefined;
      const opt = options[idx];
      return typeof opt === 'string' ? idx : opt.id;
    }
    default:
      return undefined;
  }
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

async function resolveCustomFields(
  ctx: AppContext,
  doc: ArchiveDocument,
  values: { field_name: string; value: string }[],
  onlyConfigured: boolean,
  notes: string[],
  configuredFields = ctx.cfg.processing.customFields,
): Promise<{ field: number; value: unknown }[] | undefined> {
  if (!values.length) return undefined;
  const meta = ctx.metadata(doc.library_id ?? null);
  const merged = new Map<number, unknown>((doc.custom_fields ?? []).map((f) => [f.field, f.value]));
  let changed = false;
  for (const { field_name, value } of values) {
    const configured = configuredFields.find((c) => normalizeName(c.name) === normalizeName(field_name));
    if (onlyConfigured && !configured) continue;
    try {
      const type = (configured?.type ?? 'string') as CustomFieldType;
      // Select fields need their options – those are defined in Paperless.
      const create = Boolean(configured) && type !== 'select';
      const res = await meta.resolveCustomField(configured?.name ?? field_name, create, type, configured?.currency);
      if (res.id == null) {
        notes.push(`Custom field "${field_name}" does not exist in Paperless${type === 'select' ? ' (create select fields with their options in Paperless)' : ''}`);
        continue;
      }
      const field = meta.customField(res.id) ?? { id: res.id, name: res.name, data_type: type };
      const converted = convertCustomFieldValue(field, value, configured?.currency);
      if (converted === undefined) {
        notes.push(`Value "${value}" is not valid for custom field "${field.name}" (${field.data_type})`);
        continue;
      }
      if (merged.get(res.id) !== converted) {
        merged.set(res.id, converted);
        changed = true;
      }
    } catch (err) {
      notes.push(`Custom field "${field_name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return changed ? [...merged.entries()].map(([field, value]) => ({ field, value })) : undefined;
}

/**
 * Plan the update for an automatic AI run, honouring all processing settings – those of a prompt
 * rule, if one applies to the document.
 */
export async function planAutomaticUpdate(
  ctx: AppContext,
  doc: ArchiveDocument,
  s: DocumentSuggestion,
  p: AppConfig['processing'] = ctx.cfg.processing,
): Promise<PlannedUpdate> {
  const meta = ctx.metadata(doc.library_id ?? null);
  await meta.snapshot();
  const patch: DocumentPatch = {};
  const notes: string[] = [];
  const current = doc.tags ?? [];
  let tags = [...current];

  if (p.functions.tags || p.usePromptTags) {
    let names = s.tags;
    let create = !p.restrict.tags;
    if (p.usePromptTags) {
      const allowed = new Map(p.promptTags.map((t) => [normalizeName(t), t]));
      names = names.map((n) => allowed.get(normalizeName(n))).filter((n): n is string => Boolean(n));
      create = true; // prompt tags may not exist in Paperless yet
    }
    const res = await meta.resolveTags(names, create);
    if (res.missing.length) notes.push(`Ignored tags not existing in Paperless: ${res.missing.join(', ')}`);
    for (const id of res.ids) if (!tags.includes(id)) tags.push(id);
  }
  if (p.addProcessedTag && p.processedTagName) {
    const res = await meta.resolveTag(p.processedTagName, true);
    if (res.id != null && !tags.includes(res.id)) tags.push(res.id);
  }
  if (p.removeTriggerTags && p.onlyTagged && p.tags.length) {
    const trigger = (await meta.resolveTags(p.tags, false)).ids;
    tags = tags.filter((t) => !trigger.includes(t));
  }
  if (!sameSet(tags, current)) patch.tags = tags;

  let title: string | null = doc.title;
  if (p.functions.title && s.title) {
    title = truncateTitle(s.title);
    if (title !== doc.title) patch.title = title;
  }

  if (p.functions.documentDate && s.document_date && s.document_date !== datePart(doc.created_date ?? doc.created)) {
    // A document cannot be written in the future – that is a due date or a misread year (one day of slack for time zones).
    if (s.document_date > localDate(new Date(Date.now() + 86_400_000))) notes.push(`Ignored document date ${s.document_date} (in the future)`);
    else patch.created = s.document_date;
  }

  let documentType = meta.documentTypeName(doc.document_type);
  if (p.functions.documentType && s.document_type) {
    // A fixed list (prompt rules): only its types, created when missing.
    const suggested = s.document_type;
    const fixed = p.allowedDocumentTypes.length ? p.allowedDocumentTypes.find((t: string) => normalizeName(t) === normalizeName(suggested)) : undefined;
    if (p.allowedDocumentTypes.length && !fixed) notes.push(`Ignored document type "${s.document_type}" (not in the allowed list)`);
    else {
      const res = await meta.resolveDocumentType(fixed ?? s.document_type, fixed ? true : !p.restrict.documentTypes);
      if (res.id == null) notes.push(`Document type "${s.document_type}" does not exist (restricted to existing types)`);
      else {
        documentType = res.name;
        if (res.id !== doc.document_type) patch.document_type = res.id;
      }
    }
  }

  let correspondent = meta.correspondentName(doc.correspondent);
  if (p.functions.correspondent && s.correspondent) {
    if (doc.correspondent && !p.overwriteCorrespondent) {
      if (normalizeName(correspondent ?? '') !== normalizeName(s.correspondent)) {
        notes.push(`Kept existing correspondent "${correspondent}" (AI suggested "${s.correspondent}")`);
      }
    } else {
      const res = await meta.resolveCorrespondent(s.correspondent, !p.restrict.correspondents);
      if (res.id == null) notes.push(`Correspondent "${s.correspondent}" does not exist (restricted to existing correspondents)`);
      else if (res.id !== doc.correspondent) {
        correspondent = res.name;
        patch.correspondent = res.id;
      }
    }
  }

  if (p.functions.customFields && p.customFields.length) {
    const cf = await resolveCustomFields(ctx, doc, s.custom_fields, true, notes, p.customFields);
    if (cf) patch.custom_fields = cf;
  }

  return { patch, display: { title, correspondent, documentType, tags }, notes };
}

export interface ManualUpdateInput {
  title?: string;
  correspondent?: string | null;
  documentType?: string | null;
  /** Final list of tag names (replaces the current tags). */
  tags?: string[];
  created?: string | null;
  customFields?: { field_name: string; value: string }[];
}

/** Plan an update with values explicitly chosen by the user (manual review). */
export async function planManualUpdate(ctx: AppContext, doc: ArchiveDocument, input: ManualUpdateInput): Promise<PlannedUpdate> {
  const meta = ctx.metadata(doc.library_id ?? null);
  await meta.snapshot();
  const patch: DocumentPatch = {};
  const notes: string[] = [];
  let tags = doc.tags ?? [];
  if (input.tags) {
    const res = await meta.resolveTags(input.tags, true);
    tags = res.ids;
    if (!sameSet(tags, doc.tags ?? [])) patch.tags = tags;
  }
  let title: string | null = doc.title;
  if (input.title !== undefined && input.title.trim()) {
    title = truncateTitle(input.title);
    if (title !== doc.title) patch.title = title;
  }
  let correspondent = meta.correspondentName(doc.correspondent);
  if (input.correspondent !== undefined) {
    if (input.correspondent === null || !input.correspondent.trim()) {
      if (doc.correspondent !== null) patch.correspondent = null;
      correspondent = null;
    } else {
      const res = await meta.resolveCorrespondent(input.correspondent, true);
      correspondent = res.name;
      if (res.id !== doc.correspondent) patch.correspondent = res.id;
    }
  }
  let documentType = meta.documentTypeName(doc.document_type);
  if (input.documentType !== undefined) {
    if (input.documentType === null || !input.documentType.trim()) {
      if (doc.document_type !== null) patch.document_type = null;
      documentType = null;
    } else {
      const res = await meta.resolveDocumentType(input.documentType, true);
      documentType = res.name;
      if (res.id !== doc.document_type) patch.document_type = res.id;
    }
  }
  if (input.created) {
    const d = normalizeDate(input.created);
    if (!d) notes.push(`Invalid date "${input.created}" ignored`);
    else if (d !== datePart(doc.created_date ?? doc.created)) patch.created = d;
  }
  if (input.customFields?.length) {
    const cf = await resolveCustomFields(ctx, doc, input.customFields, false, notes);
    if (cf) patch.custom_fields = cf;
  }
  return { patch, display: { title, correspondent, documentType, tags }, notes };
}

export interface ApplyMeta {
  source: string;
  /** Who applies the change (default: the AI for automatic sources, the system otherwise). */
  origin?: ChangeOrigin;
  /** Access scope of the request (manual edits); default: system. */
  scope?: AccessScope;
  analysis?: AnalysisResult;
  /** Library prompt of the prompt rule that applied. */
  prompt?: { id: number; name: string } | null;
}

/** Who made a change, from the processing source. */
export function originFor(source: string, userId?: number | null): ChangeOrigin {
  if (source === 'manual' && userId) return { actor: 'user', actorId: userId };
  return { actor: 'ai', ref: `source:${source}` };
}

/** Save the document, then record history and processing state (only after success). */
export async function applyPlannedUpdate(ctx: AppContext, doc: ArchiveDocument, plan: PlannedUpdate, info: ApplyMeta): Promise<ArchiveDocument> {
  let updated = doc;
  const backend = ctx.backend(info.scope);
  const origin = info.origin ?? originFor(info.source);
  if (Object.keys(plan.patch).length) {
    try {
      updated = await backend.updateDocument(doc.id, plan.patch, origin);
    } catch (err) {
      // One unacceptable custom field value must not cost the title, tags and correspondent.
      if (!withoutRejectedCustomFields(err, plan)) throw err;
      updated = Object.keys(plan.patch).length ? await backend.updateDocument(doc.id, plan.patch, origin) : doc;
    }
  }
  const hasChanges = Object.keys(plan.patch).length > 0;
  let historyId: number | null = null;
  try {
    // Undo snapshot and processing state are stored together (or not at all).
    historyId = ctx.db.transaction(() => recordApplied(ctx, doc, updated, plan, info, hasChanges))();
  } catch (err) {
    // The archive was changed already: never process (and change) the document a second time.
    log.error({ err, documentId: doc.id }, `Document ${doc.id} was updated, but the history could not be saved`);
    try {
      ctx.repos.documents.markProcessed(doc.id, updated.title ?? doc.title, updated.modified ?? null);
    } catch {
      /* database unavailable – logged above */
    }
  }
  if (hasChanges) ctx.events.emit({ type: 'document.updated', id: doc.id, fields: Object.keys(plan.patch), origin, libraryId: doc.library_id ?? null });
  if (info.source !== 'manual') ctx.events.emit({ type: 'document.processed', id: doc.id, historyId, libraryId: doc.library_id ?? null });
  if (plan.notes.length) log.info({ documentId: doc.id, notes: plan.notes }, `Document ${doc.id}: ${plan.notes.join('; ')}`);
  return updated;
}

/**
 * Paperless rejected the custom field values (400 with a `custom_fields` error): remove the
 * rejected ones – or all, if the response does not say which – from the plan. Returns false for
 * other errors.
 */
function withoutRejectedCustomFields(err: unknown, plan: PlannedUpdate): boolean {
  const fields = plan.patch.custom_fields;
  if (!fields || statusOf(err) !== 400) return false;
  const body = ((err as { cause?: unknown }).cause as { body?: unknown } | undefined)?.body as { custom_fields?: unknown } | undefined;
  if (!body || typeof body !== 'object' || !('custom_fields' in body)) return false;
  const errors = Array.isArray(body.custom_fields) ? body.custom_fields : null;
  // Paperless answers with one entry per submitted field – empty for the valid ones.
  const rejected = (i: number) => !errors || errors.length !== fields.length || Boolean(errors[i] && Object.keys(errors[i] as object).length);
  const kept = fields.filter((_, i) => !rejected(i));
  if (kept.length && kept.length < fields.length) plan.patch.custom_fields = kept;
  else delete plan.patch.custom_fields;
  const dropped = fields.filter((f) => !plan.patch.custom_fields?.includes(f)).map((f) => f.field);
  plan.notes.push(`Paperless rejected custom field values (${JSON.stringify(body.custom_fields).slice(0, 300)}) – saved without them`);
  log.warn(`Document custom fields ${dropped.join(', ')} were rejected by Paperless – saving the other changes`);
  return true;
}

function recordApplied(ctx: AppContext, doc: ArchiveDocument, updated: ArchiveDocument, plan: PlannedUpdate, info: ApplyMeta, hasChanges: boolean): number | null {
  let historyId: number | null = null;
  if (hasChanges) {
    historyId = ctx.repos.history.add({
      documentId: doc.id,
      source: info.source,
      provider: info.analysis?.provider,
      model: info.analysis?.model,
      title: plan.display.title,
      correspondent: plan.display.correspondent,
      documentType: plan.display.documentType,
      tags: plan.display.tags,
      before: snapshotOf(doc),
      after: plan.patch as Record<string, unknown>,
      suggestion: info.analysis?.suggestion,
      promptTokens: info.analysis?.usage.promptTokens,
      completionTokens: info.analysis?.usage.completionTokens,
      totalTokens: info.analysis?.usage.totalTokens,
      durationMs: info.analysis?.durationMs,
      prompt: info.prompt ?? null,
    });
  }
  ctx.repos.documents.markProcessed(doc.id, updated.title ?? doc.title, updated.modified ?? null);
  return historyId;
}

/**
 * Restore the values a document had before the AI changed it for the first time.
 * The document is marked so that it is not processed again automatically.
 */
export async function revertDocument(ctx: AppContext, documentId: number, origin: ChangeOrigin = { actor: 'system', ref: 'revert' }, scope?: AccessScope): Promise<ArchiveDocument> {
  const original = ctx.repos.history.originalForDocument(documentId);
  if (!original) throw new Error(`No undo information stored for document ${documentId}`);
  const b = original.before;
  const patch: DocumentPatch = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.tags !== undefined) patch.tags = b.tags;
  if (b.correspondent !== undefined) patch.correspondent = b.correspondent;
  if (b.document_type !== undefined) patch.document_type = b.document_type;
  if (b.created) patch.created = b.created;
  if (b.custom_fields !== undefined) patch.custom_fields = b.custom_fields;
  const updated = await ctx.backend(scope).updateDocument(documentId, patch, origin);
  ctx.repos.history.markReverted(documentId);
  ctx.events.emit({ type: 'document.updated', id: documentId, fields: Object.keys(patch), origin, libraryId: updated.library_id ?? null });
  ctx.repos.documents.markSkipped(documentId, updated.title, 'reverted', updated.modified ?? null);
  log.info(`Reverted AI changes of document ${documentId}`);
  return updated;
}
