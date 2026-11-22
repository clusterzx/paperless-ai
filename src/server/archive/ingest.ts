/**
 * Intake of the built-in archive: every channel (upload, API, watch folder, e-mail, WebDAV)
 * hands a file to ingest(). See docs/standalone/ingest.md.
 *
 *   intake row (pending) → type check (magic bytes) → blob store (hash, size limit) → duplicate?
 *   → text layer + page count → one transaction (document, file, text, tags, change log, full text)
 *   → events (document.added → processing queue) → thumbnail
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AccessScope } from '../access/scope.js';
import { canRead, isAdmin, userIdOf } from '../access/scope.js';
import { ArchiveError, statusOf, type ChangeOrigin, type IngestChannel, type IngestFile, type IngestHints, type IngestResult } from '../backend/types.js';
import { assessText } from '../ocr/quality.js';
import { normalizeDate } from '../processing/dates.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import type { LocalBackend } from './backend.js';
import { nextModified } from './backend.js';
import { ACCEPTED_TYPES, inspectFile, renderThumbnail, sniffType } from './files.js';

const log = logger.child({ module: 'intake' });

interface IntakeRow {
  id: number;
  status: 'pending' | 'stored' | 'duplicate' | 'failed' | 'rejected';
  document_id: number | null;
  error: string | null;
}

export class IngestService {
  private stopped = false;
  /** Intake attempts in progress (stop() waits for them). */
  private readonly running = new Set<Promise<unknown>>();

  constructor(private readonly backend: LocalBackend) {}

  private get ctx() {
    return this.backend.ctx;
  }

  private get db() {
    return this.backend.ctx.db;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.running]);
  }

  ingest(scope: AccessScope, file: IngestFile, channel: IngestChannel, hints: IngestHints): Promise<IngestResult> {
    if (this.stopped) return Promise.reject(new ArchiveError('The archive is shutting down', 503, 'shutting_down'));
    const p = this.run(scope, file, channel, hints);
    this.running.add(p);
    void p.finally(() => this.running.delete(p)).catch(() => undefined);
    return p;
  }

  private setIntake(id: number, patch: { status: IntakeRow['status']; documentId?: number | null; error?: string | null; sha256?: string; libraryId?: number }): void {
    this.db
      .prepare('UPDATE lib_intake SET status = ?, document_id = COALESCE(?, document_id), error = ?, sha256 = COALESCE(?, sha256), library_id = COALESCE(?, library_id), finished_at = ? WHERE id = ?')
      .run(patch.status, patch.documentId ?? null, patch.error ?? null, patch.sha256 ?? null, patch.libraryId ?? null, patch.status === 'pending' ? null : Date.now(), id);
  }

  private async run(scope: AccessScope, file: IngestFile, channel: IngestChannel, hints: IngestHints): Promise<IngestResult> {
    // The same channel reference (mail id, Idempotency-Key, file path + mtime) is stored once.
    if (hints.channelRef) {
      const prev = this.db.prepare('SELECT * FROM lib_intake WHERE channel = ? AND channel_ref = ?').get(channel, hints.channelRef) as IntakeRow | undefined;
      if (prev?.status === 'stored' || prev?.status === 'duplicate') {
        return { status: prev.status, documentId: prev.document_id ?? undefined, intakeId: prev.id, reason: prev.error ?? undefined };
      }
      // The same reference in progress right now (a request sent twice): the second one can come again.
      if (prev?.status === 'pending') return { status: 'failed', intakeId: prev.id, reason: 'This file is being stored right now – send it again in a moment' };
      // Failed or refused before: try again (the rights or the file may have changed).
      if (prev) this.db.prepare('DELETE FROM lib_intake WHERE id = ?').run(prev.id);
    }
    const userId = userIdOf(scope);
    // The attempt is recorded first, so a refused target (no rights, a deleted library) shows in the inbox too.
    const intakeId = Number(
      this.db
        .prepare('INSERT INTO lib_intake (channel, channel_ref, filename, status, library_id, created_by, created_at, hints) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(channel, hints.channelRef ?? null, file.filename, 'pending', null, userId, Date.now(), JSON.stringify(hints)).lastInsertRowid,
    );
    let replaced: { id: number; library_id: number } | null;
    let libraryId: number;
    try {
      replaced = hints.replaces ? this.backend.editableRow(scope, hints.replaces) : null;
      libraryId = replaced ? replaced.library_id : this.backend.targetLibrary(scope, hints.libraryId);
    } catch (err) {
      this.setIntake(intakeId, { status: 'rejected', error: describeError(err) });
      this.ctx.events.emitIntake({ intakeId, status: 'rejected', filename: file.filename, libraryId: null, createdBy: userId });
      log.warn(`Intake of "${file.filename}" (${channel}) refused: ${describeError(err)}`);
      throw err;
    }
    this.db.prepare('UPDATE lib_intake SET library_id = ? WHERE id = ?').run(libraryId, intakeId);
    this.ctx.events.emitIntake({ intakeId, status: 'pending', filename: file.filename, libraryId, createdBy: userId });
    try {
      const result = await this.store(scope, file, channel, hints, libraryId, intakeId, replaced?.id ?? null);
      this.ctx.events.emitIntake({ intakeId, status: result.status === 'stored' ? 'stored' : result.status === 'duplicate' ? 'duplicate' : 'rejected', documentId: result.documentId ?? null, filename: file.filename, libraryId, createdBy: userId });
      return result;
    } catch (err) {
      const status = statusOf(err);
      // A refusal (type, size, rights) stays one; anything else is a passing failure that can be retried.
      const rejected = status !== undefined && status < 500;
      this.setIntake(intakeId, { status: rejected ? 'rejected' : 'failed', error: describeError(err) });
      this.ctx.events.emitIntake({ intakeId, status: rejected ? 'rejected' : 'failed', filename: file.filename, libraryId, createdBy: userId });
      log.warn(`Intake of "${file.filename}" (${channel}) failed: ${describeError(err)}`);
      if (status === 403 || status === 404) throw err;
      return { status: rejected ? 'rejected' : 'failed', intakeId, reason: describeError(err) };
    }
  }

  private async head(file: IngestFile): Promise<Uint8Array> {
    if (file.data) return file.data.subarray(0, 1024);
    const fh = await fsp.open(file.path!, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buf, 0, 1024, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  private async store(scope: AccessScope, file: IngestFile, channel: IngestChannel, hints: IngestHints, libraryId: number, intakeId: number, replaces: number | null): Promise<IngestResult> {
    if (!file.data && !file.path) throw new ArchiveError('No file content', 400, 'empty');
    const mime = sniffType(await this.head(file));
    if (!mime || !(ACCEPTED_TYPES as readonly string[]).includes(mime)) {
      throw new ArchiveError(`This file type is not supported (${file.mimeType || path.extname(file.filename) || 'unknown'}) – PDF and images (JPEG, PNG, TIFF, WebP) are`, 415, 'unsupported_type');
    }
    const maxBytes = this.ctx.cfg.archive.builtin.maxUploadMb * 1024 * 1024;
    const blob = file.data ? await this.backend.blobs.putBytes(file.data) : await this.backend.blobs.putFile(file.path!, maxBytes);
    if (blob.size > maxBytes) throw new ArchiveError(`The file is larger than ${this.ctx.cfg.archive.builtin.maxUploadMb} MB`, 413, 'too_large');
    if (blob.size === 0) throw new ArchiveError('The file is empty', 400, 'empty');
    this.setIntake(intakeId, { status: 'pending', sha256: blob.sha256 });

    // Duplicate: the same original in the same library (unless the library allows it).
    const settings = this.ctx.repos.libraries.get(libraryId)?.settings ?? {};
    if (!replaces && !settings.allowDuplicates) {
      const dup = this.db
        .prepare(
          `SELECT d.id FROM lib_document_files f JOIN lib_documents d ON d.id = f.document_id
           WHERE f.blob_sha256 = ? AND f.kind = 'original' AND d.library_id = ? AND d.deleted_at IS NULL LIMIT 1`,
        )
        .get(blob.sha256, libraryId) as { id: number } | undefined;
      if (dup) {
        this.setIntake(intakeId, { status: 'duplicate', documentId: dup.id, error: `Identical to document ${dup.id}` });
        log.info(`"${file.filename}" is identical to document ${dup.id} – not stored again`);
        return { status: 'duplicate', documentId: dup.id, intakeId, reason: `Identical to document ${dup.id}` };
      }
    }

    const bytes = await this.backend.blobs.read(blob.sha256);
    const info = await inspectFile(bytes, mime);
    const quality = info.text ? assessText(info.text, info.pages ?? undefined, this.ctx.cfg.ocr.poorBelow).score : 0;

    // Names from the hints → ids of the library (created when missing).
    const meta = this.ctx.metadata(libraryId);
    await meta.snapshot();
    const tagIds = hints.tags?.length ? (await meta.resolveTags(hints.tags, true)).ids : [];
    const correspondent = hints.correspondent ? (await meta.resolveCorrespondent(hints.correspondent, true)).id : null;
    const documentType = hints.documentType ? (await meta.resolveDocumentType(hints.documentType, true)).id : null;
    const fields: { field: number; value: unknown }[] = [];
    for (const [name, value] of Object.entries(hints.customFields ?? {})) {
      const res = await meta.resolveCustomField(name, false);
      if (res.id != null) fields.push({ field: res.id, value });
    }
    const userId = userIdOf(scope);
    const origin: ChangeOrigin =
      channel === 'upload' || channel === 'api' || channel === 'share' || channel === 'webdav'
        ? { actor: 'user', actorId: userId, ref: `intake:${intakeId}` }
        : channel === 'import'
          ? { actor: 'import', ref: hints.channelRef ?? null }
          : { actor: 'system', ref: `${channel}:${intakeId}` };
    const now = new Date().toISOString();
    const title = (hints.title?.trim() || path.basename(file.filename).replace(/\.[^.]+$/, '') || 'Document').slice(0, 512);
    const created = hints.created ? normalizeDate(hints.created) : null;

    const id = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)').run(blob.sha256, blob.size, mime, Date.now());
      if (replaces) {
        const row = this.backend.row(replaces)!;
        const version = (this.db.prepare('SELECT MAX(version) AS v FROM lib_document_files WHERE document_id = ?').get(replaces) as { v: number }).v + 1;
        this.db
          .prepare('INSERT INTO lib_document_files (document_id, version, kind, blob_sha256, original_filename, mime_type, size, page_count, comment, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(replaces, version, 'original', blob.sha256, file.filename, mime, blob.size, info.pages, hints.context?.comment ?? '', userId, Date.now());
        this.backend.setText(replaces, version, info.text, 'text_layer', info.text ? quality : null);
        this.db
          .prepare('UPDATE lib_documents SET current_version = ?, mime_type = ?, page_count = ?, original_filename = ?, modified = ? WHERE id = ?')
          .run(version, mime, info.pages, file.filename, nextModified(row.modified), replaces);
        this.backend.logEvent(row, 'version_added', origin, { version: [row.current_version, version], file: [row.original_filename, file.filename] });
        this.backend.refreshFts(replaces);
        this.setIntake(intakeId, { status: 'stored', documentId: replaces });
        return replaces;
      }
      const docId = Number(
        this.db
          .prepare(
            `INSERT INTO lib_documents (library_id, title, created, added, modified, correspondent_id, document_type_id, archive_serial_number, owner_id,
               current_version, original_filename, mime_type, page_count, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          )
          .run(libraryId, title, created, now, now, correspondent, documentType, hints.archiveSerialNumber ?? null, userId, file.filename, mime, info.pages, channel).lastInsertRowid,
      );
      this.db
        .prepare('INSERT INTO lib_document_files (document_id, version, kind, blob_sha256, original_filename, mime_type, size, page_count, created_by, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(docId, 'original', blob.sha256, file.filename, mime, blob.size, info.pages, userId, Date.now());
      this.backend.setText(docId, 1, info.text, 'text_layer', info.text ? quality : null);
      if (tagIds.length) this.backend.setTags(docId, libraryId, created, tagIds);
      if (fields.length) this.backend.setFields(docId, libraryId, fields);
      this.backend.logEvent({ id: docId, library_id: libraryId }, 'created', origin, { file: [null, file.filename], channel: [null, channel] });
      this.backend.refreshFts(docId);
      this.setIntake(intakeId, { status: 'stored', documentId: docId });
      return docId;
    })();

    log.info(`Stored "${file.filename}" as document ${id} (${mime}, ${info.pages ?? '?'} page(s), ${info.text ? `${info.text.length} characters of text` : 'no text layer'})`);
    if (replaces) this.ctx.events.emit({ type: 'document.version_added', id, version: this.backend.row(id)!.current_version, libraryId });
    else this.ctx.events.emit({ type: 'document.added', id, source: channel, libraryId, skipAnalysis: hints.skipAnalysis, prompt: hints.prompt, context: { ...hints.context, filename: file.filename } });
    // The thumbnail is made right away (the list shows it), but never delays or fails the intake.
    void renderThumbnail(bytes, mime)
      .then((thumb) => {
        const version = this.backend.row(id, true)?.current_version ?? 1;
        if (thumb) fs.writeFileSync(this.backend.blobs.thumbPath(id, version), thumb);
      })
      .catch(() => undefined);
    return { status: 'stored', documentId: id, intakeId };
  }

  /**
   * Try a failed intake again (the file must still exist in the blob store), with the hints of the
   * first attempt (tags, title, mail sender …). Only attempts the caller can see: their own, those of
   * their libraries, and – for administrators – those without a library.
   */
  async retry(scope: AccessScope, intakeId: number): Promise<IngestResult> {
    const row = this.db.prepare('SELECT * FROM lib_intake WHERE id = ?').get(intakeId) as
      | (IntakeRow & { channel: IngestChannel; filename: string; sha256: string | null; library_id: number | null; created_by: number | null; hints: string | null })
      | undefined;
    const visible = row && (row.created_by === userIdOf(scope) || (row.library_id != null ? canRead(scope, row.library_id) : isAdmin(scope)));
    if (!row || !visible) throw new ArchiveError('Intake attempt not found', 404, 'not_found');
    if (row.status !== 'failed') throw new ArchiveError('Only failed intake attempts can be retried', 409, 'not_failed');
    if (!row.sha256 || !this.backend.blobs.has(row.sha256)) throw new ArchiveError('The file of this attempt was not kept – send it again', 410, 'gone');
    let hints: IngestHints;
    try {
      hints = row.hints ? (JSON.parse(row.hints) as IngestHints) : {};
    } catch {
      hints = {};
    }
    if (row.library_id != null && !hints.replaces) hints.libraryId = row.library_id;
    // Checked before the attempt is replaced: a refused retry leaves it as it was.
    if (hints.replaces) this.backend.editableRow(scope, hints.replaces);
    else this.backend.targetLibrary(scope, hints.libraryId);
    this.db.prepare('DELETE FROM lib_intake WHERE id = ?').run(intakeId);
    return this.ingest(scope, { path: this.backend.blobs.pathOf(row.sha256), filename: row.filename }, row.channel, hints);
  }

  /** Attempts that were running when the process stopped never finish: they count as failed (retryable). */
  recoverInterrupted(): void {
    this.db.prepare("UPDATE lib_intake SET status = 'failed', error = 'Interrupted by a restart', finished_at = ? WHERE status = 'pending'").run(Date.now());
  }
}
