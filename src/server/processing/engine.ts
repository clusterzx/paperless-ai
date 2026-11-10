/**
 * Processing engine: scheduled scans, a de-duplicating job queue with
 * configurable concurrency, retry handling and live status for the UI.
 */
import { EventEmitter } from 'node:events';
import { Cron } from 'croner';
import type { ProcessingJob, ProcessingStatus } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { NotConfiguredError } from '../context.js';
import type { AppConfig } from '../config/schema.js';
import type { PaperlessDocument } from '../paperless/types.js';
import { AiError } from '../ai/types.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import { analyzeContent } from './analyzer.js';
import { applyPlannedUpdate, planAutomaticUpdate } from './applier.js';

const log = logger.child({ module: 'processing' });

export interface EnqueueOptions {
  source: 'scan' | 'webhook' | 'api' | 'manual';
  /** Process even if the document was processed before. */
  force?: boolean;
  /** Replace the system prompt for this document (webhook `prompt`). */
  prompt?: string;
}

interface Job extends EnqueueOptions {
  documentId: number;
}

/** `deferred`: the AI provider rate-limited the request – the document goes back into the queue. */
export type JobOutcome = 'processed' | 'unchanged' | 'skipped' | 'failed' | 'deferred';

/** First pause after a rate limit; doubles while the provider keeps refusing. */
const RATE_LIMIT_PAUSE_MS = 30_000;
/** With a tag filter the scan does not see every document; deleted ones are looked for separately this often. */
const PRUNE_INTERVAL_MS = 6 * 3_600_000;
const MAX_RATE_LIMIT_PAUSE_MS = 15 * 60_000;

export function validateCron(expr: string): string | null {
  try {
    new Cron(expr, { paused: true }).stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export class ProcessingEngine extends EventEmitter<{ job: [documentId: number, outcome: JobOutcome]; idle: [] }> {
  private readonly queue: Job[] = [];
  private readonly queued = new Set<number>();
  private readonly active = new Map<number, ProcessingJob>();
  private cron: Cron | null = null;
  private scanning: Promise<number> | null = null;
  private paused = false;
  private stopped = false;
  private lastScanAt: number | null = null;
  private lastError: string | null = null;
  /** The AI model was used since the queue was last empty. */
  private modelUsed = false;
  /** Rate limited by the AI provider: no new analyses before this time. */
  private cooldownUntil = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private rateLimitStreak = 0;
  private lastPruneAt = 0;

  constructor(private readonly ctx: AppContext) {
    super();
    ctx.config.on('change', (next, prev) => this.onConfigChange(next, prev));
  }

  /** Start scheduling (and run an initial scan) when automatic processing is enabled. */
  start(initialScan = true): void {
    this.stopped = false;
    this.reschedule();
    if (initialScan && this.ctx.cfg.processing.automatic && this.ctx.isConfigured()) {
      // Give the server a moment to come up before the first scan.
      setTimeout(() => void this.scan().catch(() => undefined), 3000).unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cron?.stop();
    this.cron = null;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.queue.length = 0;
    this.queued.clear();
    const deadline = Date.now() + 15_000;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }

  private onConfigChange(next: AppConfig, prev: AppConfig): void {
    const relevant = (c: AppConfig) => JSON.stringify([c.processing.automatic, c.processing.scanInterval, c.setupCompleted]);
    if (relevant(next) !== relevant(prev)) this.reschedule();
  }

  private reschedule(): void {
    this.cron?.stop();
    this.cron = null;
    const p = this.ctx.cfg.processing;
    if (this.stopped || !p.automatic || !this.ctx.cfg.setupCompleted) return;
    const problem = validateCron(p.scanInterval);
    if (problem) {
      this.lastError = `Invalid scan interval "${p.scanInterval}": ${problem}`;
      log.error(this.lastError);
      return;
    }
    this.cron = new Cron(p.scanInterval, { protect: true }, () => {
      if (!this.paused) void this.scan().catch(() => undefined);
    });
    log.info(`Automatic processing scheduled (${p.scanInterval}), next run ${this.cron.nextRun()?.toISOString()}`);
  }

  pause(): void {
    this.paused = true;
    log.info('Processing paused');
  }

  resume(): void {
    this.paused = false;
    log.info('Processing resumed');
    this.pump();
  }

  status(): ProcessingStatus {
    const last = this.ctx.repos.documents.lastProcessed();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return {
      running: this.active.size > 0,
      paused: this.paused,
      automatic: this.ctx.cfg.processing.automatic,
      scanning: this.scanning !== null,
      current: [...this.active.values()],
      queued: this.queue.length,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.cron?.nextRun()?.getTime() ?? null,
      lastError: this.lastError,
      rateLimitedUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null,
      lastProcessed: last ? { documentId: last.id, title: last.title, processedAt: last.processed_at ?? last.updated_at } : null,
      processedToday: this.ctx.repos.documents.processedSince(startOfDay.getTime()),
      counts: this.ctx.repos.documents.counts(),
    };
  }

  /** Look for documents that need processing and queue them. Returns the number of queued documents. */
  scan(): Promise<number> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<number> {
    if (!this.ctx.isConfigured()) throw new NotConfiguredError('Setup is not complete – skipping scan');
    const p = this.ctx.cfg.processing;
    const client = this.ctx.paperless();
    const meta = this.ctx.metadata();
    try {
      await meta.snapshot(true);
      let tagFilter: number[] | undefined;
      if (p.onlyTagged) {
        const res = await meta.resolveTags(p.tags, false);
        if (!res.ids.length) {
          log.warn(`"Only process tagged documents" is enabled, but none of the tags exist in Paperless: ${p.tags.join(', ') || '(none set)'}`);
          this.lastScanAt = Date.now();
          return 0;
        }
        tagFilter = res.ids;
      }
      const docs = await client.listDocuments({ tagsAny: tagFilter, fields: ['id', 'title', 'modified'], ordering: 'added', pageSize: 1000 });
      const states = this.ctx.repos.documents.all();
      let count = 0;
      for (const doc of docs) {
        const state = states.get(doc.id);
        // Re-triggered documents (trigger tag added again) are already marked processed: force them.
        if (this.needsProcessing(doc, state, p) && this.enqueue(doc.id, { source: 'scan', force: state?.status === 'processed' })) count++;
      }
      this.lastScanAt = Date.now();
      this.lastError = null;
      log.info(`Scan finished: ${docs.length} documents checked, ${count} queued for processing`);
      await this.pruneDeleted(tagFilter ? undefined : docs.map((d) => d.id));
      return count;
    } catch (err) {
      this.lastError = describeError(err);
      log.error(`Scan failed: ${this.lastError}`);
      throw err;
    }
  }

  /**
   * Forget the states of documents that were deleted in Paperless (or came with an imported 3.x
   * database) – they inflate the statistics. Never fails the scan.
   */
  private async pruneDeleted(listed?: number[]): Promise<void> {
    try {
      if (!listed && Date.now() - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
      const ids = listed ?? (await this.ctx.paperless().listDocuments({ fields: ['id'], ordering: 'id', pageSize: 1000 })).map((d) => d.id);
      this.lastPruneAt = Date.now();
      if (!ids.length) return; // an empty archive is more likely missing permissions
      const repo = this.ctx.repos.documents;
      const missing = repo.missing(new Set(ids));
      if (!missing.length) return;
      const known = repo.all().size;
      if (missing.length > 20 && missing.length > known / 2) {
        log.warn(`${missing.length} of ${known} known documents are missing in Paperless – not forgetting them (permissions changed?)`);
        return;
      }
      repo.reset(missing);
      log.info(`Forgot the processing state of ${missing.length} document(s) deleted in Paperless`);
    } catch (err) {
      log.warn(`Could not check for deleted documents: ${describeError(err)}`);
    }
  }

  private needsProcessing(
    doc: Pick<PaperlessDocument, 'id' | 'modified'>,
    state: { status: string; attempts: number; modified: string | null; reason?: string | null } | undefined,
    p: AppConfig['processing'],
  ): boolean {
    if (!state) return true;
    const changed = Boolean(doc.modified && state.modified && doc.modified !== state.modified);
    switch (state.status) {
      case 'processed':
        // Trigger-tag workflow: the tag is removed after processing, so re-adding it re-triggers the AI.
        return p.onlyTagged && p.removeTriggerTags && changed;
      case 'failed':
        return state.attempts < p.maxAttempts || changed;
      case 'skipped':
        return state.reason !== 'reverted' && changed;
      default:
        return true;
    }
  }

  /** Queue a document. Returns false if it is already queued or being processed. */
  enqueue(documentId: number, opts: EnqueueOptions): boolean {
    if (this.queued.has(documentId) || this.active.has(documentId)) return false;
    this.queue.push({ documentId, ...opts });
    this.queued.add(documentId);
    queueMicrotask(() => this.pump());
    return true;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  private pump(): void {
    if (this.paused || this.stopped) return;
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      this.cooldownTimer ??= setTimeout(() => {
        this.cooldownTimer = null;
        this.pump();
      }, wait);
      this.cooldownTimer.unref?.();
      return;
    }
    const limit = this.ctx.cfg.processing.concurrency;
    while (this.active.size < limit && this.queue.length) {
      const job = this.queue.shift()!;
      this.queued.delete(job.documentId);
      const info: ProcessingJob = { documentId: job.documentId, title: null, source: job.source, startedAt: Date.now(), stage: 'loading' };
      this.active.set(job.documentId, info);
      void this.run(job, info)
        .then((outcome) => {
          if (outcome === 'deferred') {
            // Back to the front of the queue – it is retried after the pause, without counting an attempt.
            if (!this.queued.has(job.documentId)) {
              this.queue.unshift(job);
              this.queued.add(job.documentId);
            }
            return;
          }
          if (outcome !== 'failed') this.rateLimitStreak = 0;
          this.emit('job', job.documentId, outcome);
        })
        .finally(() => {
          this.active.delete(job.documentId);
          if (!this.active.size && !this.queue.length) this.onIdle();
          this.pump();
        });
    }
  }

  private onIdle(): void {
    this.emit('idle');
    if (!this.modelUsed) return;
    this.modelUsed = false;
    const ai = this.ctx.cfg.ai;
    if (ai.provider !== 'ollama' || !ai.ollama.unloadWhenIdle) return;
    // Free the GPU memory for other applications until the next document arrives.
    void this.unloadModel();
  }

  private async unloadModel(): Promise<void> {
    try {
      const llm = this.ctx.llm();
      await llm.unload?.();
      log.info(`Queue is empty – unloaded ${llm.model} from Ollama`);
    } catch (err) {
      log.warn(`Could not unload the Ollama model: ${describeError(err)}`);
    }
  }

  /** Process a single document. Never throws. */
  async run(job: Job, info?: ProcessingJob): Promise<JobOutcome> {
    const { documentId } = job;
    const repo = this.ctx.repos.documents;
    let doc: PaperlessDocument | undefined;
    try {
      if (!job.force) {
        const state = repo.get(documentId);
        if (state?.status === 'processed') return 'unchanged';
      }
      doc = await this.ctx.paperless().getDocument(documentId);
      if (info) info.title = doc.title;
      if (doc.user_can_change === false) {
        repo.markSkipped(documentId, doc.title, 'The Paperless user of Paperless-AI has no permission to change this document', doc.modified ?? null);
        log.info(`Skipping document ${documentId}: no change permission`);
        return 'skipped';
      }
      if (!doc.content || doc.content.trim().length < 10) {
        repo.markSkipped(documentId, doc.title, 'No text content (OCR not finished or failed)', doc.modified ?? null);
        log.info(`Skipping document ${documentId}: no text content`);
        return 'skipped';
      }
      if (info) info.stage = 'analyzing';
      this.modelUsed = true;
      log.info(`Analyzing document ${documentId} "${doc.title}"`);
      const analysis = await analyzeContent(this.ctx, doc.content, {
        feature: 'process',
        documentId,
        customPrompt: job.prompt,
        filename: doc.original_file_name,
      });
      if (info) info.stage = 'saving';
      const plan = await planAutomaticUpdate(this.ctx, doc, analysis.suggestion);
      const updated = await applyPlannedUpdate(this.ctx, doc, plan, { source: job.source, analysis });
      log.info(
        `Processed document ${documentId} → "${updated.title}" (${analysis.usage.totalTokens} tokens, ${(analysis.durationMs / 1000).toFixed(1)}s${analysis.truncated ? ', content truncated' : ''})`,
      );
      return 'processed';
    } catch (err) {
      if (err instanceof AiError && err.rateLimited) {
        const pause = this.startCooldown(err);
        log.warn(`The AI provider rate-limited the request for document ${documentId} – pausing processing for ${Math.round(pause / 1000)}s`);
        return 'deferred';
      }
      const reason = describeError(err);
      const attempts = repo.markFailed(documentId, doc?.title ?? null, reason, doc?.modified ?? null);
      log.error(`Processing document ${documentId} failed (attempt ${attempts}/${this.ctx.cfg.processing.maxAttempts}): ${reason}`);
      this.lastError = `Document ${documentId}: ${reason}`;
      return 'failed';
    }
  }

  private startCooldown(err: AiError): number {
    this.rateLimitStreak++;
    const backoff = RATE_LIMIT_PAUSE_MS * 2 ** (this.rateLimitStreak - 1);
    // A Retry-After of the provider wins (the HTTP layer already waited for short ones a few times).
    const retryAfter = err.info.retryAfterMs;
    const pause = Math.min(retryAfter !== undefined ? Math.max(retryAfter, 1000 * 2 ** (this.rateLimitStreak - 1)) : backoff, MAX_RATE_LIMIT_PAUSE_MS);
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + pause);
    return pause;
  }

  /** Wait until the queue is empty (used by tests and the synchronous scan endpoint). */
  async drain(timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length || this.active.size) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
