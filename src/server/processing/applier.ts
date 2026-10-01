/**
 * Turns an AI suggestion (or a manual edit) into a Paperless PATCH, applies
 * it and records an undoable history entry.
 */
import type { AnalysisResult, DocumentSnapshot, DocumentSuggestion } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { DocumentPatch } from '../paperless/client.js';
import { normalizeName } from '../paperless/metadata.js';
import type { PaperlessCustomField, PaperlessCustomFieldType, PaperlessDocument } from '../paperless/types.js';
import { logger } from '../logger.js';
import { datePart, normalizeDate } from './dates.js';

const log = logger.child({ module: 'applier' });

export const MAX_TITLE_LENGTH = 128;

export interface PlannedUpdate {
  patch: DocumentPatch;
  display: { title: string | null; correspondent: string | null; documentType: string | null; tags: number[] };
  notes: string[];
}

export function snapshotOf(doc: PaperlessDocument): DocumentSnapshot {
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
export function convertCustomFieldValue(field: PaperlessCustomField, value: string, currency?: string): unknown {
  const v = value.trim();
  switch (field.data_type) {
    case 'string':
      return v.slice(0, 128);
    case 'longtext':
      return v;
    case 'url':
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : /^www\./i.test(v) ? `https://${v}` : undefined;
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
  doc: PaperlessDocument,
  values: { field_name: string; value: string }[],
  onlyConfigured: boolean,
  notes: string[],
): Promise<{ field: number; value: unknown }[] | undefined> {
  if (!values.length) return undefined;
  const meta = ctx.metadata();
  const merged = new Map<number, unknown>((doc.custom_fields ?? []).map((f) => [f.field, f.value]));
  let changed = false;
  for (const { field_name, value } of values) {
    const configured = ctx.cfg.processing.customFields.find((c) => normalizeName(c.name) === normalizeName(field_name));
    if (onlyConfigured && !configured) continue;
    try {
      const type = (configured?.type ?? 'string') as PaperlessCustomFieldType;
      const res = await meta.resolveCustomField(configured?.name ?? field_name, Boolean(configured), type, configured?.currency);
      if (res.id == null) {
        notes.push(`Custom field "${field_name}" does not exist in Paperless`);
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

/** Plan the update for an automatic AI run, honouring all processing settings. */
export async function planAutomaticUpdate(ctx: AppContext, doc: PaperlessDocument, s: DocumentSuggestion): Promise<PlannedUpdate> {
  const p = ctx.cfg.processing;
  const meta = ctx.metadata();
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
    patch.created = s.document_date;
  }

  let documentType = meta.documentTypeName(doc.document_type);
  if (p.functions.documentType && s.document_type) {
    const res = await meta.resolveDocumentType(s.document_type, !p.restrict.documentTypes);
    if (res.id == null) notes.push(`Document type "${s.document_type}" does not exist (restricted to existing types)`);
    else {
      documentType = res.name;
      if (res.id !== doc.document_type) patch.document_type = res.id;
    }
  }

  let correspondent = meta.correspondentName(doc.correspondent);
  if (p.functions.correspondent && s.correspondent) {
    if (doc.correspondent) {
      if (normalizeName(correspondent ?? '') !== normalizeName(s.correspondent)) {
        notes.push(`Kept existing correspondent "${correspondent}" (AI suggested "${s.correspondent}")`);
      }
    } else {
      const res = await meta.resolveCorrespondent(s.correspondent, !p.restrict.correspondents);
      if (res.id == null) notes.push(`Correspondent "${s.correspondent}" does not exist (restricted to existing correspondents)`);
      else {
        correspondent = res.name;
        patch.correspondent = res.id;
      }
    }
  }

  if (p.functions.customFields && p.customFields.length) {
    const cf = await resolveCustomFields(ctx, doc, s.custom_fields, true, notes);
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
export async function planManualUpdate(ctx: AppContext, doc: PaperlessDocument, input: ManualUpdateInput): Promise<PlannedUpdate> {
  const meta = ctx.metadata();
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
  analysis?: AnalysisResult;
}

/** PATCH the document, then record history and processing state (only after success). */
export async function applyPlannedUpdate(ctx: AppContext, doc: PaperlessDocument, plan: PlannedUpdate, info: ApplyMeta): Promise<PaperlessDocument> {
  const hasChanges = Object.keys(plan.patch).length > 0;
  const updated = hasChanges ? await ctx.paperless().updateDocument(doc.id, plan.patch) : doc;
  if (hasChanges) {
    ctx.repos.history.add({
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
    });
  }
  ctx.repos.documents.markProcessed(doc.id, updated.title ?? doc.title, updated.modified ?? null);
  if (plan.notes.length) log.info({ documentId: doc.id, notes: plan.notes }, `Document ${doc.id}: ${plan.notes.join('; ')}`);
  return updated;
}

/**
 * Restore the values a document had before the AI changed it for the first time.
 * The document is marked so that it is not processed again automatically.
 */
export async function revertDocument(ctx: AppContext, documentId: number): Promise<PaperlessDocument> {
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
  const updated = await ctx.paperless().updateDocument(documentId, patch);
  ctx.repos.history.markReverted(documentId);
  ctx.repos.documents.markSkipped(documentId, updated.title, 'reverted', updated.modified ?? null);
  log.info(`Reverted AI changes of document ${documentId}`);
  return updated;
}
