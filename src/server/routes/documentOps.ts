/**
 * Operations behind the document routes: bulk edits, the activity timeline, uploads and serving
 * files safely.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ActivityItem, BulkEditInput, BulkEditResult, UploadResult } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { ProcessingEngine } from '../processing/engine.js';
import { canEdit, canRead, userIdOf, type AccessScope } from '../access/scope.js';
import { actorName } from '../access/context.js';
import { notSupported, type ArchiveDocument, type ChangeOrigin, type DocumentPatch, type IngestChannel, type IngestHints } from '../backend/types.js';
import { convertCustomFieldValue } from '../processing/applier.js';
import { parseDocumentFilter } from '../http/documentQuery.js';
import { applySearchSyntax } from '../http/searchSyntax.js';
import { badRequest, HttpProblem } from '../http/helpers.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'documents' });

/** At most this many documents per bulk request. */
const BULK_LIMIT = 10_000;

// ---------------------------------------------------------------- bulk edits

async function idsOf(ctx: AppContext, scope: AccessScope, input: BulkEditInput): Promise<number[]> {
  if (input.ids?.length) return [...new Set(input.ids)].slice(0, BULK_LIMIT);
  if (!input.filter) throw badRequest('Give the documents by id or by filter');
  // The same documents as the list shows for this search (tag:, title: … included).
  const { filter } = await applySearchSyntax(ctx, scope, parseDocumentFilter(input.filter));
  const ids: number[] = [];
  let cursor: string | null = null;
  do {
    const page = await ctx.backend(scope).queryDocuments({ filter, sort: 'added', limit: 250, cursor });
    ids.push(...page.results.map((d) => d.id));
    cursor = page.nextCursor;
  } while (cursor && ids.length < BULK_LIMIT);
  return ids.slice(0, BULK_LIMIT);
}

async function editPatch(ctx: AppContext, doc: ArchiveDocument, edit: NonNullable<BulkEditInput['edit']>): Promise<DocumentPatch> {
  const meta = ctx.metadata(doc.library_id ?? null);
  await meta.snapshot();
  const patch: DocumentPatch = {};
  if (edit.addTags?.length || edit.removeTags?.length) {
    const add = edit.addTags?.length ? (await meta.resolveTags(edit.addTags, true)).ids : [];
    const remove = edit.removeTags?.length ? (await meta.resolveTags(edit.removeTags, false)).ids : [];
    const tags = [...new Set([...(doc.tags ?? []), ...add])].filter((t) => !remove.includes(t));
    if (tags.length !== (doc.tags ?? []).length || tags.some((t) => !(doc.tags ?? []).includes(t))) patch.tags = tags;
  }
  if (edit.correspondent !== undefined) {
    const id = edit.correspondent === null || !edit.correspondent.trim() ? null : (await meta.resolveCorrespondent(edit.correspondent, true)).id;
    if (id !== (doc.correspondent ?? null)) patch.correspondent = id;
  }
  if (edit.documentType !== undefined) {
    const id = edit.documentType === null || !edit.documentType.trim() ? null : (await meta.resolveDocumentType(edit.documentType, true)).id;
    if (id !== (doc.document_type ?? null)) patch.document_type = id;
  }
  if (edit.customField) {
    const field = meta.customFieldByName(edit.customField.name);
    if (!field) throw badRequest(`The custom field "${edit.customField.name}" does not exist`);
    const value = edit.customField.value === '' ? null : convertCustomFieldValue(field, edit.customField.value);
    if (value === undefined) throw badRequest(`"${edit.customField.value}" is not a valid value for ${field.name}`);
    const fields = (doc.custom_fields ?? []).filter((f) => f.field !== field.id);
    if (value !== null) fields.push({ field: field.id, value });
    patch.custom_fields = fields;
  }
  if (edit.libraryId !== undefined && edit.libraryId !== doc.library_id) patch.library_id = edit.libraryId;
  return patch;
}

export async function bulkEdit(ctx: AppContext, engine: ProcessingEngine, scope: AccessScope, input: BulkEditInput): Promise<BulkEditResult> {
  const backend = ctx.backend(scope);
  const ids = await idsOf(ctx, scope, input);
  const ref = `bulk:${randomUUID()}`;
  const origin: ChangeOrigin = { actor: 'user', actorId: userIdOf(scope), ref };
  const result: BulkEditResult = { ok: 0, failed: [], ref };
  if (input.action === 'edit' && !input.edit) throw badRequest('Nothing to change');
  if (input.action === 'restore' && !backend.backend.restoreDocument) throw notSupported('Restoring documents');
  for (const id of ids) {
    try {
      if (input.action === 'restore') {
        await backend.backend.restoreDocument!(scope, id, origin);
        ctx.events.emit({ type: 'document.restored', id });
        result.ok++;
        continue;
      }
      const doc = await backend.getDocument(id);
      switch (input.action) {
        case 'edit': {
          const patch = await editPatch(ctx, doc, input.edit!);
          if (Object.keys(patch).length) {
            await backend.updateDocument(id, patch, origin);
            ctx.events.emit({ type: 'document.updated', id, fields: Object.keys(patch), origin, libraryId: doc.library_id ?? null });
          }
          break;
        }
        case 'delete':
          await backend.deleteDocument(id, origin);
          ctx.events.emit({ type: 'document.deleted', id, origin, libraryId: doc.library_id ?? null });
          break;
        case 'analyze':
        case 'ocr':
          // The analysis writes with the system scope – the caller must be allowed to change the document.
          if (!canEdit(scope, doc.library_id)) throw new HttpProblem(403, 'Not allowed to change this document');
          engine.enqueue(id, input.action === 'ocr' ? { source: 'ocr', ocr: true, force: true } : { source: 'manual', force: true });
          break;
      }
      result.ok++;
    } catch (err) {
      result.failed.push({ id, error: describeError(err) });
    }
  }
  log.info(`Bulk ${input.action} by ${actorName(scope)}: ${result.ok} document(s), ${result.failed.length} failed`);
  return result;
}

// ---------------------------------------------------------------- activity

const FIELD_LABEL: Record<string, string> = {
  title: 'Title',
  tags: 'Tags',
  correspondent: 'Correspondent',
  document_type: 'Document type',
  created: 'Date',
  custom_fields: 'Custom fields',
  content: 'Text',
  archive_serial_number: 'ASN',
  library_id: 'Library',
  storage_path: 'Storage path',
  owner: 'Owner',
};

export function fieldLabel(f: string): string {
  return FIELD_LABEL[f] ?? f;
}

export async function documentActivity(ctx: AppContext, documentId: number, libraryId: number | null): Promise<ActivityItem[]> {
  const items: ActivityItem[] = [];
  const history = ctx.repos.history.list({ documentId, includeReverted: true, pageSize: 200 }).items;
  for (const h of history) {
    const before = h.before as unknown as Record<string, unknown>;
    const ai = !['edit', 'manual'].includes(h.source);
    items.push({
      at: h.createdAt,
      kind: ai ? 'ai' : 'change',
      title: ai ? `Analysed by ${h.model ?? 'the AI'}${h.prompt ? ` (prompt “${h.prompt.name}”)` : ''}` : h.source === 'manual' ? 'Suggestion reviewed and saved' : 'Changed',
      actor: ai ? (h.model ?? 'AI') : null,
      details: Object.keys(h.after).map((field) => ({ field: fieldLabel(field), before: before?.[field] ?? null, after: h.after[field] })),
      undo: h.canRevert && !h.revertedAt ? { kind: 'history', id: h.id } : null,
      reverted: Boolean(h.revertedAt),
    });
  }
  const ocr = ctx.repos.ocr.result(documentId);
  if (ocr) {
    items.push({
      at: ocr.created_at,
      kind: 'ocr',
      title:
        ocr.status === 'failed'
          ? `OCR failed: ${ocr.error ?? ''}`
          : `Read with OCR (${ocr.pages ?? '?'} page${ocr.pages === 1 ? '' : 's'}, quality ${ocr.score_before ?? '?'} → ${ocr.score_after ?? '?'})${ocr.written_back ? '' : ocr.kept_original ? ' – the existing text was kept' : ''}`,
      actor: ocr.provider ? `PaddleOCR (${ocr.provider.toUpperCase()})` : 'PaddleOCR',
      reverted: Boolean(ocr.reverted_at),
    });
  }
  const changeLog = ctx.archive().changeLog;
  if (changeLog) items.push(...(await changeLog(documentId, libraryId)));
  // Workflow runs that did something (or failed); runs whose conditions did not match stay in the run log.
  for (const run of ctx.repos.workflows.runs({ documentId, limit: 100 })) {
    if (run.status === 'not_matched' || run.status === 'queued' || run.status === 'running') continue;
    const status = run.status === 'succeeded' ? 'ran' : run.status === 'failed' ? `failed: ${run.error ?? ''}` : `skipped: ${run.error ?? ''}`;
    items.push({
      at: run.finishedAt ?? run.queuedAt,
      kind: 'workflow',
      title: `Workflow “${run.workflowName}” ${status}`.trim(),
      actor: `Workflow #${run.workflowId}`,
      details: (ctx.repos.workflows.steps(run.id) ?? [])
        .filter((st) => st.kind === 'action')
        .map((st) => ({ field: st.name, before: null, after: st.status })),
    });
  }
  return items.sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------- uploads

const MB = 1024 * 1024;

interface ReceivedFile {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Read a multipart upload (files + hint fields) and hand every file to the archive. */
export async function receiveUploads(
  ctx: AppContext,
  req: FastifyRequest,
  channel: IngestChannel,
  extraHints: IngestHints = {},
  /** Hints from the form fields in another format (e.g. Paperless-ngx's post_document). */
  hintsFrom?: (fields: Record<string, string[]>) => Promise<IngestHints>,
  _fileField?: string,
): Promise<UploadResult[]> {
  if (!req.isMultipart()) throw badRequest('Send the files as multipart/form-data');
  const limit = ctx.cfg.archive.builtin.maxUploadMb * MB;
  const dir = path.join(ctx.dataDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const files: ReceivedFile[] = [];
  const fields: Record<string, string[]> = {};
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (!part.filename) {
          part.file.resume();
          continue;
        }
        const target = path.join(dir, `upload-${randomUUID()}`);
        let size = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            if (size > limit) cb(new HttpProblem(413, `The file "${part.filename}" is larger than ${ctx.cfg.archive.builtin.maxUploadMb} MB`));
            else cb(null, chunk);
          },
        });
        files.push({ path: target, filename: path.basename(part.filename), mimeType: part.mimetype, size: 0 });
        await pipeline(part.file, counter, fs.createWriteStream(target));
        files[files.length - 1].size = size;
      } else {
        (fields[part.fieldname] ??= []).push(String(part.value ?? ''));
      }
    }
    const one = (k: string) => fields[k]?.[0]?.trim() || undefined;
    const tags = (fields.tags ?? []).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
    // The library by id (libraryId) or by name (library=Family).
    const libraryId = one('libraryId') ? Number(one('libraryId')) : one('library') ? libraryByName(ctx, req.access!, one('library')!) : undefined;
    // The client's Idempotency-Key counts per user: two users (or apps) may send the same one.
    const idempotencyHeader = req.headers['idempotency-key'];
    const caller = userIdOf(req.access!);
    const idempotency = typeof idempotencyHeader === 'string' && idempotencyHeader ? `${caller !== null ? `user:${caller}` : req.access!.principal.kind}:${idempotencyHeader}` : undefined;
    const custom = hintsFrom ? await hintsFrom(fields) : null;
    const hints: IngestHints = custom ? { ...extraHints, ...stripUndefined(custom) } : {
      ...extraHints,
      ...(libraryId ? { libraryId } : {}),
      ...(one('title') ? { title: one('title') } : {}),
      ...(one('created') ? { created: one('created')!.slice(0, 10) } : {}),
      ...(tags.length ? { tags } : {}),
      ...(one('correspondent') ? { correspondent: one('correspondent') } : {}),
      ...(one('documentType') ? { documentType: one('documentType') } : {}),
      ...(/^(1|true|yes)$/i.test(one('skipAnalysis') ?? '') ? { skipAnalysis: true } : {}),
      ...(one('prompt') ? { prompt: /^\d+$/.test(one('prompt')!) ? Number(one('prompt')) : one('prompt') } : {}),
      ...(one('replaces') ? { replaces: Number(one('replaces')) } : {}),
      ...(one('comment') ? { context: { comment: one('comment')! } } : {}),
    };
    if (!files.length) throw badRequest('No file received (form field "file")');
    const backend = ctx.backend(req.access!);
    const results: UploadResult[] = [];
    for (const [i, f] of files.entries()) {
      try {
        const res = await backend.ingest(
          { path: f.path, filename: f.filename, mimeType: f.mimeType },
          channel,
          { ...hints, ...(idempotency ? { channelRef: files.length > 1 ? `${idempotency}#${i}` : idempotency } : {}) },
        );
        results.push({ filename: f.filename, ...res });
      } catch (err) {
        if (err instanceof HttpProblem && err.statusCode === 403) throw err;
        results.push({ filename: f.filename, status: 'rejected', reason: describeError(err) });
      }
    }
    log.info(`Upload by ${actorName(req.access)}: ${results.map((r) => `${r.filename} (${r.status})`).join(', ')}`);
    return results;
  } finally {
    for (const f of files) fs.rmSync(f.path, { force: true });
  }
}

/** The id of a library the scope can see, by its name (case ignored); 400 when there is none. */
export function libraryByName(ctx: AppContext, scope: AccessScope, name: string): number {
  if (!ctx.archive().capabilities.libraries) throw badRequest('Libraries exist in the built-in archive only');
  const lib = ctx.repos.libraries.list().find((l) => l.name.toLowerCase() === name.trim().toLowerCase() && canRead(scope, l.id));
  if (!lib) throw badRequest(`No library “${name}”`);
  return lib.id;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as T;
}

// ---------------------------------------------------------------- serving files

/** Types the browser may show inline. Everything else is a download (an HTML or SVG file must never run on our origin). */
const INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|tiff)|text\/plain)(;|$)/i;

function disposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function sendFile(req: FastifyRequest, reply: FastifyReply, data: Uint8Array, contentType: string, filename: string, inline: boolean): FastifyReply {
  const safeInline = inline && INLINE.test(contentType);
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', disposition(safeInline ? 'inline' : 'attachment', filename))
    .header('Cache-Control', 'private, max-age=300')
    .header('Accept-Ranges', 'bytes')
    .header('X-Content-Type-Options', 'nosniff');
  // PDFs are shown by the browser's viewer (which a sandbox would block); anything else shown inline
  // runs without scripts.
  if (!/^application\/pdf/i.test(contentType)) reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const size = buf.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).send(buf.subarray(start, end + 1));
  }
  return reply.send(buf);
}

