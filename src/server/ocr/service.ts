/**
 * OCR service: decides when a document needs OCR, reads it with PaddleOCR,
 * stores the result, optionally writes the text back to Paperless (with
 * undo) and keeps the text quality of all documents up to date for the OCR
 * page.
 */
import path from 'node:path';
import type { OcrStatus } from '../../shared/api.js';
import { effectiveOcrModel, OCR_QUALITY_PRESETS, type OcrModelChoice, type OcrRelease } from '../../shared/ocr.js';
import type { AppConfig } from '../config/schema.js';
import type { AppContext } from '../context.js';
import type { OcrAssessment } from '../db/ocrRepo.js';
import { logger } from '../logger.js';
import type { ArchiveDocument } from '../backend/types.js';
import { describeError } from '../util/http.js';
import { UserError } from '../util/errors.js';
import { assessText } from './quality.js';
import type { PipelineOptions } from './pipeline.js';
import { isPdf } from './render.js';
import { ocrAvailable, OcrWorkerEngine, type OcrEngine, type OcrProgress, type OcrResult } from './runner.js';
import { kindOf } from '../../shared/fileTypes.js';
import { LocalBackend } from '../archive/backend.js';
import { makeSearchablePdf } from './searchablePdf.js';

const log = logger.child({ module: 'ocr' });

/** Text written by the OCR. */
const OCR_ORIGIN = { actor: 'system', ref: 'ocr' } as const;

/** Label of the Paperless-ngx version with the searchable PDF (at most 64 characters). */
export const OCR_VERSION_LABEL = 'OCR text layer (Paperless-AI)';

/** Documents whose content is fetched per request while assessing the archive. */
const ASSESS_BATCH = 100;
/** Re-assess the archive at most this often on its own. */
const ASSESS_INTERVAL_MS = 6 * 3_600_000;

export interface ReadResult {
  text: string;
  /** The OCR text scored better than the text Paperless had – only then it replaces it (and is analysed). */
  better: boolean;
  /** The document after the write-back (new `modified`), or the unchanged one. */
  doc: ArchiveDocument;
  result: OcrResult;
  writtenBack: boolean;
}

/** `release` is read after every document, so changing the setting needs no restart of the OCR. */
export type EngineFactory = (options: PipelineOptions, release: () => OcrRelease) => OcrEngine;

export class OcrService {
  private engine: { key: string; engine: OcrEngine } | null = null;
  private available: boolean | null = null;
  private active: { documentId: number | null; title: string | null; page: number; pages: number } | null = null;
  private assessing: Promise<void> | null = null;
  private assessProgress = { done: 0, total: 0 };
  private assessError: string | null = null;
  /** Called when a document's text changed (the search index has to be updated). */
  onTextChanged: ((documentId: number) => void) | null = null;
  /** How often and how long to wait for Paperless-ngx to consume an uploaded version (tests shorten it). */
  versionWait = { intervalMs: 5_000, timeoutMs: 15 * 60_000 };
  /** Waits for consumed versions – ended by stop(). */
  private readonly watching = new Set<AbortController>();

  constructor(
    private readonly ctx: AppContext,
    private readonly engineFactory: EngineFactory = (o, release) => new OcrWorkerEngine(o, { release }),
  ) {
    ctx.config.on('change', (next, prev) => {
      if (this.engineKey(next) !== this.engineKey(prev)) void this.disposeEngine();
    });
  }

  private get cfg(): AppConfig['ocr'] {
    return this.ctx.cfg.ocr;
  }

  async isAvailable(): Promise<boolean> {
    this.available ??= await ocrAvailable();
    return this.available;
  }

  private engineKey(cfg: AppConfig): string {
    const o = cfg.ocr;
    return JSON.stringify([o.language, o.quality, o.device, o.threads, o.autoRotate, o.modelVersion, o.modelSize]);
  }

  private pipelineOptions(): PipelineOptions {
    const o = this.cfg;
    const preset = OCR_QUALITY_PRESETS[o.quality];
    const model = this.model();
    return {
      cacheDir: path.join(this.ctx.dataDir, 'models'),
      language: o.language,
      detector: preset.detector,
      ...(model.version === 'v6' && model.size ? { v6: model.size } : {}),
      device: o.device,
      threads: o.threads,
      detMaxSide: preset.detMaxSide,
      pageOrientation: o.autoRotate,
      textlineOrientation: true,
      minScore: 0.5,
    };
  }

  /** The model that is really used (PP-OCRv6 falls back to v5 for languages it cannot read). */
  model(): OcrModelChoice {
    const o = this.cfg;
    return effectiveOcrModel(o.modelVersion, o.modelSize, o.language);
  }

  private getEngine(): OcrEngine {
    const key = this.engineKey(this.ctx.cfg);
    if (this.engine?.key !== key) {
      void this.engine?.engine.dispose();
      this.engine = { key, engine: this.engineFactory(this.pipelineOptions(), () => this.cfg.release) };
    }
    return this.engine.engine;
  }

  private async disposeEngine(): Promise<void> {
    const e = this.engine;
    this.engine = null;
    await e?.engine.dispose();
  }

  async stop(): Promise<void> {
    for (const w of this.watching) w.abort();
    await this.disposeEngine();
  }

  // ------------------------------------------------------------ decisions

  /** Text quality of a document as Paperless delivers it (also stored for the OCR page). */
  assess(doc: ArchiveDocument): OcrAssessment {
    const quality = assessText(doc.content, doc.page_count, this.cfg.poorBelow);
    const a: OcrAssessment = {
      id: doc.id,
      title: doc.title ?? '',
      modified: doc.modified ?? null,
      created: (doc.created_date ?? doc.created ?? null)?.slice(0, 10) ?? null,
      pages: doc.page_count ?? null,
      quality,
    };
    this.ctx.repos.ocr.saveAssessments([a]);
    return a;
  }

  /** OCR text stored for exactly this version of the document (not written back, not reverted). */
  storedText(doc: ArchiveDocument): string | null {
    const r = this.ctx.repos.ocr.result(doc.id);
    if (!r || r.status !== 'done' || r.reverted_at || r.kept_original || !r.text) return null;
    if (r.written_back) return r.written_modified === (doc.modified ?? null) ? r.text : null;
    return r.source_modified === (doc.modified ?? null) ? r.text : null;
  }

  /** Whether the automatic mode wants this document read before the AI analysis. */
  autoNeeded(doc: ArchiveDocument): boolean {
    const o = this.cfg;
    if (!o.enabled || o.mode === 'manual' || this.available === false) return false;
    // Text files and e-mails come with their text (OCR could only read a PDF made of it).
    if (['text', 'html', 'mail'].includes(kindOf(doc.mime_type) ?? '')) return false;
    // The newest Paperless-ngx version is the searchable PDF made of an OCR result: reading it again
    // would only read the own text (and add another version).
    const newest = doc.versions?.[0];
    if (newest && !newest.is_root && newest.version_label === OCR_VERSION_LABEL) return false;
    // Read here for Paperless-ngx while it consumed the file (remote OCR): the text is the OCR text.
    if (doc.content && this.ctx.repos.ocr.isRemoteRead(doc.content)) return false;
    // Already read this version (e.g. a re-analysis after the write-back).
    const r = this.ctx.repos.ocr.result(doc.id);
    if (r?.status === 'done' && !r.reverted_at && [r.source_modified, r.written_modified].includes(doc.modified ?? null)) return false;
    if (o.mode === 'always') return true;
    const level = this.assess(doc).quality.level;
    return level === 'missing' || (o.mode === 'poor' && level === 'poor');
  }

  // ------------------------------------------------------------ reading

  /** Download a file PaddleOCR can read: the original if it is a PDF or an image, else the archived PDF. */
  private async documentFile(id: number, signal?: AbortSignal): Promise<Uint8Array> {
    const backend = this.ctx.backend();
    const original = await backend.download(id, { original: true, signal });
    if (isPdf(original.data) || original.contentType.startsWith('image/')) return original.data;
    const archived = await backend.download(id, { original: false, signal });
    if (isPdf(archived.data)) return archived.data;
    throw new UserError(`OCR cannot read this file type (${original.contentType}) and there is no archived PDF of it`);
  }

  /** Read a document with PaddleOCR. Writes the text back to Paperless when enabled. */
  async read(doc: ArchiveDocument, opts: { onProgress?: OcrProgress; signal?: AbortSignal } = {}): Promise<ReadResult> {
    if (!(await this.isAvailable())) throw new UserError('OCR is not available in this installation (onnxruntime-node, sharp or @hyzyla/pdfium missing)');
    const repo = this.ctx.repos.ocr;
    const preset = OCR_QUALITY_PRESETS[this.cfg.quality];
    this.active = { documentId: doc.id, title: doc.title ?? null, page: 0, pages: 0 };
    try {
      const bytes = await this.documentFile(doc.id, opts.signal);
      const result = await this.getEngine().run(
        bytes,
        { dpi: preset.dpi, maxPages: this.cfg.maxPages },
        (page, pages) => {
          if (this.active) Object.assign(this.active, { page, pages });
          opts.onProgress?.(page, pages);
        },
        opts.signal,
      );
      const text = result.text;
      const chars = text.replace(/\s+/g, '').length;
      // Both texts are rated the same way (same page count). Only a better text replaces the one
      // Paperless has: a clean text layer of a digital PDF or well-read print stays untouched when
      // OCR – e.g. on handwriting – does no better. Never replace text with (almost) nothing.
      const pages = doc.page_count ?? result.totalPages;
      const before = assessText(doc.content, pages, this.cfg.poorBelow);
      const after = assessText(text, pages, this.cfg.poorBelow);
      const better = chars >= 20 && (before.level === 'missing' || after.score > before.score);
      repo.saveResult(doc.id, {
        text,
        chars,
        pages: result.pages.length,
        totalPages: result.totalPages,
        meanScore: result.meanScore,
        provider: result.provider,
        durationMs: result.durationMs,
        sourceModified: doc.modified ?? null,
        scoreBefore: before.score,
        scoreAfter: after.score,
        keptOriginal: !better,
      });
      const truncated = result.totalPages > result.pages.length ? ` (first ${result.pages.length} of ${result.totalPages} pages)` : '';
      log.info(
        `OCR of document ${doc.id}: ${result.pages.length} page(s)${truncated}, ${text.length} characters, ` +
          `confidence ${(result.meanScore * 100).toFixed(0)} %, ${(result.durationMs / 1000).toFixed(1)}s on ${result.provider.toUpperCase()}, ` +
          `text quality ${before.score} → ${after.score}${better ? '' : ' – not better, the existing text is kept'}`,
      );

      let current = doc;
      let writtenBack = false;
      // The built-in archive keeps the text itself: OCR text always replaces a worse one (with undo).
      if ((this.cfg.writeBack || this.ctx.archiveMode() === 'builtin') && better) {
        current = await this.ctx.backend().updateDocument(doc.id, { content: text }, OCR_ORIGIN);
        this.ctx.events.emit({ type: 'document.updated', id: doc.id, fields: ['content'], origin: OCR_ORIGIN, libraryId: doc.library_id ?? null });
        repo.markWrittenBack(doc.id, doc.content ?? '', current.modified ?? null);
        writtenBack = true;
        this.assess({ ...current, content: text });
      }
      if (better) this.onTextChanged?.(doc.id);
      // Only a text that is used goes into the PDF (a worse one would not help the search either).
      if (better && this.cfg.searchablePdf) await this.storeSearchablePdf(doc, bytes, result, writtenBack ? text : null);
      return { text, better, doc: current, result, writtenBack };
    } catch (err) {
      repo.saveFailure(doc.id, describeError(err), doc.modified ?? null);
      throw err;
    } finally {
      this.active = null;
    }
  }

  /**
   * Lay the OCR text into the PDF and keep it: as the archive PDF of the version (built-in archive)
   * or as a new version of the document in Paperless-ngx, which then shows that PDF and takes its
   * text. A failure is logged and shown on the OCR page – the OCR text itself is not lost.
   * `savedText`: the OCR text saved in Paperless-ngx, to be put into the new version as well.
   */
  private async storeSearchablePdf(doc: ArchiveDocument, file: Uint8Array, result: OcrResult, savedText: string | null): Promise<void> {
    const repo = this.ctx.repos.ocr;
    try {
      const started = Date.now();
      const pdf = await makeSearchablePdf(file, result.pages.map((p) => p.layout));
      if (!pdf) {
        log.info(`Searchable PDF of document ${doc.id}: no page needs the OCR text (all pages have text of their own)`);
        return;
      }
      const name = `${(doc.original_file_name || doc.title || `document-${doc.id}`).replace(/\.[^.]+$/, '')}.pdf`;
      const kept = pdf.kept ? `, ${pdf.kept} page(s) kept their own text` : '';
      const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      const archive = this.ctx.archive();
      if (archive instanceof LocalBackend) {
        const sha = await archive.setArchivePdf(doc.id, pdf.data, name, doc.page_count ?? null, { ...OCR_ORIGIN, ref: 'ocr:pdf' });
        repo.markPdf(doc.id, 'archive', sha);
        log.info(`Searchable PDF of document ${doc.id} stored as its archive PDF (${pdf.pages} page(s) with the OCR text${kept}, ${took})`);
      } else {
        const task = await this.ctx.paperless().uploadVersion(doc.id, pdf.data, name, OCR_VERSION_LABEL);
        repo.markPdf(doc.id, 'version', task);
        log.info(`Searchable PDF of document ${doc.id} uploaded to Paperless-ngx as a new version (${pdf.pages} page(s) with the OCR text${kept}, ${took})`);
        if (savedText) void this.textIntoVersion(doc.id, savedText);
      }
    } catch (err) {
      const message = describeError(err);
      repo.markPdf(doc.id, 'failed', message);
      log.warn(`Searchable PDF of document ${doc.id} failed – the OCR text is kept all the same: ${message}`);
    }
  }

  /**
   * Paperless-ngx takes the text of a new version from its PDF (pdftotext): the order of the lines
   * can differ from the OCR text, and a long line of a skewed scan can come out broken in two. Once
   * the version is consumed, the OCR text that was saved goes into it as well.
   */
  private async textIntoVersion(documentId: number, text: string): Promise<void> {
    const watch = new AbortController();
    this.watching.add(watch);
    const deadline = Date.now() + this.versionWait.timeoutMs;
    try {
      while (Date.now() < deadline && !watch.signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.versionWait.intervalMs);
          timer.unref();
          watch.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
        if (watch.signal.aborted) return;
        const doc = await this.ctx.backend().getDocument(documentId);
        const newest = doc.versions?.[0];
        if (!newest || newest.is_root || newest.version_label !== OCR_VERSION_LABEL) continue;
        const r = this.ctx.repos.ocr.result(documentId);
        // Reverted (or read again) meanwhile: nothing to do.
        if (!r || r.pdf !== 'version' || r.reverted_at || r.text !== text) return;
        if (doc.content === text) return;
        const updated = await this.ctx.backend().updateDocument(documentId, { content: text }, OCR_ORIGIN);
        this.ctx.repos.ocr.markWrittenBack(documentId, r.previous_text ?? '', updated.modified ?? null);
        log.info(`OCR text of document ${documentId} saved in the new Paperless-ngx version as well`);
        return;
      }
      if (!watch.signal.aborted) log.warn(`Document ${documentId}: Paperless-ngx did not consume the searchable PDF within ${Math.round(this.versionWait.timeoutMs / 60_000)} minutes`);
    } catch (err) {
      log.warn(`Could not save the OCR text in the new Paperless-ngx version of document ${documentId}: ${describeError(err)}`);
    } finally {
      this.watching.delete(watch);
    }
  }

  /** Take the searchable PDF away again (revert): the archive PDF, or the version in Paperless-ngx. */
  private async removeSearchablePdf(documentId: number): Promise<void> {
    const repo = this.ctx.repos.ocr;
    const r = repo.result(documentId);
    if (!r?.pdf || r.pdf === 'failed') return;
    try {
      const archive = this.ctx.archive();
      if (r.pdf === 'archive' && archive instanceof LocalBackend && r.pdf_ref) {
        archive.removeArchivePdf(documentId, r.pdf_ref, { ...OCR_ORIGIN, ref: 'ocr:revert' });
      } else if (r.pdf === 'version' && !(archive instanceof LocalBackend)) {
        const doc = await this.ctx.backend().getDocument(documentId);
        const ours = doc.versions?.find((v) => !v.is_root && v.version_label === OCR_VERSION_LABEL);
        if (ours) await this.ctx.paperless().deleteVersion(documentId, ours.id);
        else log.warn(`Document ${documentId}: the Paperless-ngx version with the searchable PDF was not found (not consumed yet, or deleted)`);
      }
      repo.markPdf(documentId, null, null);
    } catch (err) {
      log.warn(`Could not remove the searchable PDF of document ${documentId}: ${describeError(err)}`);
    }
  }

  /**
   * Read a file for Paperless-ngx while it consumes it (remote OCR). Nothing is stored with a
   * document; the caller records the text, so the document is not read again once it arrives.
   */
  async readFile(bytes: Uint8Array, opts: { label: string; signal?: AbortSignal }): Promise<OcrResult> {
    if (!(await this.isAvailable())) throw new UserError('OCR is not available in this installation (onnxruntime-node, sharp or @hyzyla/pdfium missing)');
    const preset = OCR_QUALITY_PRESETS[this.cfg.quality];
    const active = { documentId: null, title: opts.label, page: 0, pages: 0 };
    this.active = active;
    try {
      return await this.getEngine().run(
        bytes,
        { dpi: preset.dpi, maxPages: this.cfg.maxPages },
        (page, pages) => Object.assign(active, { page, pages }),
        opts.signal,
      );
    } finally {
      if (this.active === active) this.active = null;
    }
  }

  /** Save an OCR text in Paperless that was kept back (not better by the score) or reverted before. */
  async apply(documentId: number): Promise<void> {
    const repo = this.ctx.repos.ocr;
    const r = repo.result(documentId);
    if (!r || r.status !== 'done' || !r.text) throw new UserError('There is no OCR result for this document');
    if (r.written_back && !r.reverted_at) throw new UserError('The OCR text is already saved in Paperless');
    const backend = this.ctx.backend();
    const doc = await backend.getDocument(documentId);
    const updated = await backend.updateDocument(documentId, { content: r.text }, OCR_ORIGIN);
    this.ctx.events.emit({ type: 'document.updated', id: documentId, fields: ['content'], origin: OCR_ORIGIN, libraryId: doc.library_id ?? null });
    repo.markApplied(documentId, doc.content ?? '', updated.modified ?? null);
    this.assess({ ...updated, content: r.text });
    this.onTextChanged?.(documentId);
    log.info(`OCR text of document ${documentId} saved in Paperless on request`);
  }

  /** Put the previous Paperless text back. */
  async revert(documentId: number): Promise<void> {
    const repo = this.ctx.repos.ocr;
    const r = repo.result(documentId);
    if (!r || r.status !== 'done') throw new UserError('There is no OCR result for this document');
    if (r.reverted_at) throw new UserError('The OCR text was already reverted');
    // First the PDF: in Paperless-ngx the newest version also holds the text, deleting it brings back the one before.
    await this.removeSearchablePdf(documentId);
    if (r.written_back) {
      const updated = await this.ctx.backend().updateDocument(documentId, { content: r.previous_text ?? '' }, { ...OCR_ORIGIN, ref: 'ocr:revert' });
      this.ctx.events.emit({ type: 'document.updated', id: documentId, fields: ['content'], origin: OCR_ORIGIN, libraryId: updated.library_id ?? null });
      repo.markReverted(documentId, updated.modified ?? null);
      this.assess({ ...updated, content: r.previous_text ?? '' });
    } else repo.markReverted(documentId, r.source_modified);
    this.onTextChanged?.(documentId);
    log.info(`OCR text of document ${documentId} reverted`);
  }

  // ------------------------------------------------------------ archive assessment

  /** Assess the text quality of all documents (only new/changed ones unless `full`). */
  assessArchive(opts: { full?: boolean } = {}): Promise<void> {
    this.assessing ??= this.doAssess(opts.full ?? false)
      .catch((err: unknown) => {
        this.assessError = describeError(err);
        log.warn(`Assessing the text quality failed: ${this.assessError}`);
      })
      .finally(() => {
        this.assessing = null;
      });
    return this.assessing;
  }

  /** Re-assess when the last run is old (called when the OCR page is opened). */
  assessIfStale(): void {
    const last = this.ctx.repos.kv.get<number>('ocr_assessed_at') ?? 0;
    if (!this.assessing && this.ctx.isConfigured() && Date.now() - last > ASSESS_INTERVAL_MS) void this.assessArchive();
  }

  private async doAssess(full: boolean): Promise<void> {
    this.assessError = null;
    const client = this.ctx.backend();
    const repo = this.ctx.repos.ocr;
    const docs = await client.listDocuments({ fields: ['id', 'title', 'modified', 'created', 'page_count'], ordering: '-added', pageSize: 1000 });
    const known = repo.assessedVersions();
    const todo = docs.filter((d) => full || !known.has(d.id) || known.get(d.id) !== (d.modified ?? null));
    this.assessProgress = { done: 0, total: todo.length };
    for (let i = 0; i < todo.length; i += ASSESS_BATCH) {
      const batch = todo.slice(i, i + ASSESS_BATCH);
      const contents = await client.listDocuments({ ids: batch.map((d) => d.id), fields: ['id', 'content'], pageSize: ASSESS_BATCH });
      const byId = new Map(contents.map((c) => [c.id, c.content ?? '']));
      repo.saveAssessments(
        batch.map((d) => ({
          id: d.id,
          title: d.title ?? '',
          modified: d.modified ?? null,
          created: (d.created_date ?? d.created ?? null)?.slice(0, 10) ?? null,
          pages: d.page_count ?? null,
          quality: assessText(byId.get(d.id), d.page_count, this.cfg.poorBelow),
        })),
      );
      this.assessProgress.done = Math.min(todo.length, i + batch.length);
    }
    // An empty listing is more likely a permission problem than an empty archive.
    if (docs.length) repo.removeMissing(new Set(docs.map((d) => d.id)));
    this.ctx.repos.kv.set('ocr_assessed_at', Date.now());
    if (todo.length) log.info(`Text quality assessed for ${todo.length} document(s)`);
  }

  // ------------------------------------------------------------ status

  status(queue: number): OcrStatus {
    return {
      enabled: this.cfg.enabled,
      available: this.available ?? true,
      mode: this.cfg.mode,
      writeBack: this.cfg.writeBack,
      searchablePdf: this.cfg.searchablePdf,
      provider: this.engine?.engine.provider ?? null,
      model: this.model(),
      analysis: {
        running: this.assessing !== null,
        done: this.assessProgress.done,
        total: this.assessProgress.total,
        lastAt: this.ctx.repos.kv.get<number>('ocr_assessed_at') ?? null,
        error: this.assessError,
      },
      queue,
      active: this.active ? { ...this.active } : null,
      remote: {
        enabled: this.cfg.enabled && this.cfg.remoteEndpoint,
        readToday: this.ctx.repos.ocr.remoteReads(Date.now() - 86_400_000).count,
        lastAt: this.ctx.repos.ocr.remoteReads(0).lastAt,
      },
    };
  }
}
