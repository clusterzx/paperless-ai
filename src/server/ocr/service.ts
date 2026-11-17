/**
 * OCR service: decides when a document needs OCR, reads it with PaddleOCR,
 * stores the result, optionally writes the text back to Paperless (with
 * undo) and keeps the text quality of all documents up to date for the OCR
 * page.
 */
import path from 'node:path';
import type { OcrStatus } from '../../shared/api.js';
import { OCR_QUALITY_PRESETS } from '../../shared/ocr.js';
import type { AppConfig } from '../config/schema.js';
import type { AppContext } from '../context.js';
import type { OcrAssessment } from '../db/ocrRepo.js';
import { logger } from '../logger.js';
import type { PaperlessDocument } from '../paperless/types.js';
import { describeError } from '../util/http.js';
import { UserError } from '../util/errors.js';
import { assessText } from './quality.js';
import type { PipelineOptions } from './pipeline.js';
import { isPdf } from './render.js';
import { ocrAvailable, OcrWorkerEngine, type OcrEngine, type OcrProgress, type OcrResult } from './runner.js';

const log = logger.child({ module: 'ocr' });

/** Documents whose content is fetched per request while assessing the archive. */
const ASSESS_BATCH = 100;
/** Re-assess the archive at most this often on its own. */
const ASSESS_INTERVAL_MS = 6 * 3_600_000;

export interface ReadResult {
  text: string;
  /** The OCR text scored better than the text Paperless had – only then it replaces it (and is analysed). */
  better: boolean;
  /** The document after the write-back (new `modified`), or the unchanged one. */
  doc: PaperlessDocument;
  result: OcrResult;
  writtenBack: boolean;
}

export type EngineFactory = (options: PipelineOptions) => OcrEngine;

export class OcrService {
  private engine: { key: string; engine: OcrEngine } | null = null;
  private available: boolean | null = null;
  private active: { documentId: number; title: string | null; page: number; pages: number } | null = null;
  private assessing: Promise<void> | null = null;
  private assessProgress = { done: 0, total: 0 };
  private assessError: string | null = null;
  /** Called when a document's text changed (the search index has to be updated). */
  onTextChanged: ((documentId: number) => void) | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly engineFactory: EngineFactory = (o) => new OcrWorkerEngine(o),
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
    return JSON.stringify([o.language, o.quality, o.device, o.threads, o.autoRotate]);
  }

  private pipelineOptions(): PipelineOptions {
    const o = this.cfg;
    const preset = OCR_QUALITY_PRESETS[o.quality];
    return {
      cacheDir: path.join(this.ctx.dataDir, 'models'),
      language: o.language,
      detector: preset.detector,
      device: o.device,
      threads: o.threads,
      detMaxSide: preset.detMaxSide,
      pageOrientation: o.autoRotate,
      textlineOrientation: true,
      minScore: 0.5,
    };
  }

  private getEngine(): OcrEngine {
    const key = this.engineKey(this.ctx.cfg);
    if (this.engine?.key !== key) {
      void this.engine?.engine.dispose();
      this.engine = { key, engine: this.engineFactory(this.pipelineOptions()) };
    }
    return this.engine.engine;
  }

  private async disposeEngine(): Promise<void> {
    const e = this.engine;
    this.engine = null;
    await e?.engine.dispose();
  }

  async stop(): Promise<void> {
    await this.disposeEngine();
  }

  // ------------------------------------------------------------ decisions

  /** Text quality of a document as Paperless delivers it (also stored for the OCR page). */
  assess(doc: PaperlessDocument): OcrAssessment {
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
  storedText(doc: PaperlessDocument): string | null {
    const r = this.ctx.repos.ocr.result(doc.id);
    if (!r || r.status !== 'done' || r.reverted_at || r.kept_original || !r.text) return null;
    if (r.written_back) return r.written_modified === (doc.modified ?? null) ? r.text : null;
    return r.source_modified === (doc.modified ?? null) ? r.text : null;
  }

  /** Whether the automatic mode wants this document read before the AI analysis. */
  autoNeeded(doc: PaperlessDocument): boolean {
    const o = this.cfg;
    if (!o.enabled || o.mode === 'manual' || this.available === false) return false;
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
    const client = this.ctx.paperless();
    const original = await client.download(id, true, signal);
    if (isPdf(original.data) || original.contentType.startsWith('image/')) return original.data;
    const archived = await client.download(id, false, signal);
    if (isPdf(archived.data)) return archived.data;
    throw new UserError(`OCR cannot read this file type (${original.contentType}) and Paperless has no archived PDF of it`);
  }

  /** Read a document with PaddleOCR. Writes the text back to Paperless when enabled. */
  async read(doc: PaperlessDocument, opts: { onProgress?: OcrProgress; signal?: AbortSignal } = {}): Promise<ReadResult> {
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
      if (this.cfg.writeBack && better) {
        current = await this.ctx.paperless().updateDocument(doc.id, { content: text });
        repo.markWrittenBack(doc.id, doc.content ?? '', current.modified ?? null);
        writtenBack = true;
        this.assess({ ...current, content: text });
      }
      if (better) this.onTextChanged?.(doc.id);
      return { text, better, doc: current, result, writtenBack };
    } catch (err) {
      repo.saveFailure(doc.id, describeError(err), doc.modified ?? null);
      throw err;
    } finally {
      this.active = null;
    }
  }

  /** Save an OCR text in Paperless that was kept back (not better by the score) or reverted before. */
  async apply(documentId: number): Promise<void> {
    const repo = this.ctx.repos.ocr;
    const r = repo.result(documentId);
    if (!r || r.status !== 'done' || !r.text) throw new UserError('There is no OCR result for this document');
    if (r.written_back && !r.reverted_at) throw new UserError('The OCR text is already saved in Paperless');
    const client = this.ctx.paperless();
    const doc = await client.getDocument(documentId);
    const updated = await client.updateDocument(documentId, { content: r.text });
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
    if (r.written_back) {
      const updated = await this.ctx.paperless().updateDocument(documentId, { content: r.previous_text ?? '' });
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
    const client = this.ctx.paperless();
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
      provider: this.engine?.engine.provider ?? null,
      analysis: {
        running: this.assessing !== null,
        done: this.assessProgress.done,
        total: this.assessProgress.total,
        lastAt: this.ctx.repos.kv.get<number>('ocr_assessed_at') ?? null,
        error: this.assessError,
      },
      queue,
      active: this.active ? { ...this.active } : null,
    };
  }
}
