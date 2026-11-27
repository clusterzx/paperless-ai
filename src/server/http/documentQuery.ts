/**
 * Query parameters of the document list (GET /api/documents, facets, bulk edits) → structured
 * DocumentFilter of the backend, and backend documents → API rows.
 */
import { z } from 'zod';
import type { DocumentFilterParams, DocumentRow, DocumentSortKey } from '../../shared/api.js';
import type { ArchiveDocument, DocumentFilter } from '../backend/types.js';
import { datePart } from '../processing/dates.js';
import type { DocumentsRepo } from '../db/repos.js';
import { badRequest } from './helpers.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idList = z.string().regex(/^(\d+)(,\d+)*$/);

export const documentFilterParams = z.object({
  q: z.string().max(500).optional(),
  tags: idList.optional(),
  tagsAll: idList.optional(),
  tagsNone: idList.optional(),
  correspondent: z.string().regex(/^(none|\d+(,\d+)*)$/).optional(),
  documentType: z.string().regex(/^(none|\d+(,\d+)*)$/).optional(),
  storagePath: z.string().regex(/^(none|\d+)$/).optional(),
  library: idList.optional(),
  createdFrom: day.optional(),
  createdTo: day.optional(),
  addedFrom: day.optional(),
  addedTo: day.optional(),
  modifiedFrom: z
    .string()
    .max(40)
    .refine((v) => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && Number.isFinite(Date.parse(v)), 'an ISO 8601 date or date and time')
    .optional(),
  cf: z.string().max(4000).optional(),
});

export const documentSort = z.enum(['created', '-created', 'added', '-added', 'title', '-title', 'modified', '-modified', 'relevance']);

const cfCondition = z.object({
  field: z.number().int().positive(),
  op: z.enum(['exists', 'eq', 'gte', 'lte', 'contains']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const ids = (v: string | undefined) => (v ? v.split(',').map(Number) : undefined);

/** One id → exact filter, several → "one of", "none" → without. */
function single(v: string | undefined): { one?: number | null; many?: number[] } {
  if (!v) return {};
  if (v === 'none') return { one: null };
  const list = v.split(',').map(Number);
  return list.length === 1 ? { one: list[0] } : { many: list };
}

export function parseDocumentFilter(p: DocumentFilterParams): DocumentFilter {
  const f: DocumentFilter = {};
  if (p.q?.trim()) f.query = p.q.trim();
  f.tagsAny = ids(p.tags);
  f.tagsAll = ids(p.tagsAll);
  f.tagsNone = ids(p.tagsNone);
  const corr = single(p.correspondent);
  if (corr.one !== undefined) f.correspondent = corr.one;
  if (corr.many) f.correspondents = corr.many;
  const type = single(p.documentType);
  if (type.one !== undefined) f.documentType = type.one;
  if (type.many) f.documentTypes = type.many;
  if (p.storagePath) f.storagePath = p.storagePath === 'none' ? null : Number(p.storagePath);
  f.libraryIds = ids(p.library);
  if (p.createdFrom) f.createdFrom = p.createdFrom;
  if (p.createdTo) f.createdTo = p.createdTo;
  if (p.addedFrom) f.addedFrom = p.addedFrom;
  if (p.addedTo) f.addedTo = p.addedTo;
  // Stored as ISO 8601 in UTC: compared as text in the same form.
  if (p.modifiedFrom) f.modifiedFrom = new Date(/T| /.test(p.modifiedFrom) ? p.modifiedFrom : `${p.modifiedFrom}T00:00:00Z`).toISOString();
  if (p.cf) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.cf);
    } catch {
      throw badRequest('cf must be a JSON array of custom field conditions');
    }
    const res = z.array(cfCondition).max(20).safeParse(parsed);
    if (!res.success) throw badRequest('Invalid custom field conditions', res.error.issues);
    f.customFields = res.data;
  }
  for (const k of Object.keys(f) as (keyof DocumentFilter)[]) if (f[k] === undefined) delete f[k];
  return f;
}

export type FileChecksums = { original: string | null; archive: string | null };

export function toRow(d: ArchiveDocument, states: DocumentsRepo, snippet?: string, sums?: FileChecksums | null): DocumentRow {
  return {
    id: d.id,
    title: d.title,
    created: datePart(d.created_date ?? d.created),
    correspondent: d.correspondent ?? null,
    document_type: d.document_type ?? null,
    tags: d.tags ?? [],
    added: d.added ?? null,
    modified: d.modified ?? null,
    original_file_name: d.original_file_name ?? null,
    mime_type: d.mime_type ?? null,
    page_count: d.page_count ?? null,
    archive_serial_number: d.archive_serial_number ?? null,
    storage_path: d.storage_path ?? null,
    owner: d.owner ?? null,
    library_id: d.library_id ?? null,
    custom_fields: d.custom_fields ?? [],
    status: (states.get(d.id)?.status as DocumentRow['status']) ?? null,
    original_sha256: sums?.original ?? null,
    archive_sha256: sums?.archive ?? null,
    sha256: sums?.archive ?? sums?.original ?? null,
    ...(snippet ? { snippet } : {}),
  };
}

export type { DocumentSortKey };
