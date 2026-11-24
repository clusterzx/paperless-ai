/**
 * Searches documents that were processed before the calendar was switched on for dates. Only the
 * dates are asked for – titles, tags and all other metadata in Paperless stay untouched.
 */
import type { CalendarScanStatus } from '../../shared/api.js';
import { AiError } from '../ai/types.js';
import type { AppContext } from '../context.js';
import { logger } from '../logger.js';
import type { OcrService } from '../ocr/service.js';
import { analyzeContent } from '../processing/analyzer.js';
import { datePart } from '../processing/dates.js';
import { describeError } from '../util/http.js';

const log = logger.child({ module: 'calendar' });

/** Replaces the system prompt for the scan; the output contract (dates only) is added as usual. */
export const DATES_PROMPT = `You read documents of a personal or business archive and find the dates the recipient has to act on or attend.
Look for appointments, payment due dates, deadlines (cancellation, objection, application, submission) and expiry or renewal dates of contracts, insurance policies, warranties and ID documents.
Use only information from the document. Do not invent dates.`;

const MAX_RATE_LIMIT_RETRIES = 5;
/** So many failures in a row without any success: the AI is not usable – stop instead of failing every document. */
const MAX_FAILURES_IN_A_ROW = 5;

export class CalendarScanner {
  private state: CalendarScanStatus = { running: false, done: 0, total: 0, found: 0, failed: 0, error: null };
  private abort: AbortController | null = null;
  private current: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly ocr: OcrService,
  ) {}

  get status(): CalendarScanStatus {
    return { ...this.state };
  }

  /** Start in the background; false when a scan is running already. `months` = 0 searches all documents. */
  start(months: number): boolean {
    if (this.state.running) return false;
    const abort = new AbortController();
    this.abort = abort;
    this.state = { running: true, done: 0, total: 0, found: 0, failed: 0, error: null };
    this.current = this.run(months, abort.signal)
      .catch((err: unknown) => {
        this.state.error = describeError(err);
        log.error(`Calendar scan failed: ${this.state.error}`);
      })
      .finally(() => {
        this.state.running = false;
      });
    return true;
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.current;
  }

  private async run(months: number, signal: AbortSignal): Promise<void> {
    const backend = this.ctx.backend();
    const repo = this.ctx.repos.calendar;
    const since = months > 0 ? monthsAgo(months) : null;
    const docs = await backend.listDocuments({ fields: ['id', 'title', 'created'], ordering: '-created' });
    const scanned = repo.scannedIds();
    const todo = docs.filter((d) => !scanned.has(d.id) && (!since || (datePart(d.created) ?? '') >= since));
    this.state.total = todo.length;
    log.info(`Searching ${todo.length} document(s) for dates${since ? ` (created since ${since})` : ''}`);
    let failuresInARow = 0;

    for (const d of todo) {
      if (signal.aborted) break;
      for (let attempt = 0; ; attempt++) {
        try {
          const doc = await backend.getDocument(d.id);
          const content = this.ocr.storedText(doc) ?? doc.content ?? '';
          if (content.trim().length < 10) {
            repo.replaceForDocument(doc.id, doc.title ?? null, []);
          } else {
            const p = this.ctx.cfg.processing;
            const analysis = await analyzeContent(this.ctx, content, {
              feature: 'calendar',
              documentId: doc.id,
              customPrompt: DATES_PROMPT,
              filename: doc.original_file_name,
              libraryId: doc.library_id ?? null,
              signal,
              processing: {
                ...p,
                usePromptTags: false,
                useExistingData: false,
                functions: { title: false, correspondent: false, tags: false, documentType: false, documentDate: false, customFields: false, events: true },
              },
            });
            this.state.found += repo.replaceForDocument(doc.id, doc.title ?? null, analysis.suggestion.events ?? []);
          }
          failuresInARow = 0;
          break;
        } catch (err) {
          if (signal.aborted) return;
          if (err instanceof AiError && err.rateLimited && attempt < MAX_RATE_LIMIT_RETRIES) {
            const pause = Math.min(err.info.retryAfterMs ?? 15_000 * 2 ** attempt, 300_000);
            log.warn(`The AI provider rate-limited the calendar scan – waiting ${Math.round(pause / 1000)}s`);
            await sleep(pause, signal);
            continue;
          }
          const reason = describeError(err);
          repo.markScanFailed(d.id, reason);
          this.state.failed++;
          failuresInARow++;
          log.warn(`Calendar scan of document ${d.id} failed: ${reason}`);
          // Every document so far failed (AI not reachable, wrong model …): stop instead of trying all of them.
          if (failuresInARow >= MAX_FAILURES_IN_A_ROW && this.state.failed === this.state.done + 1) {
            throw new Error(`Stopped after ${failuresInARow} failed documents – last error: ${reason}`, { cause: err });
          }
          break;
        }
      }
      this.state.done++;
    }
    log.info(`Calendar scan finished: ${this.state.done} document(s), ${this.state.found} date(s) found, ${this.state.failed} failed`);
  }
}

function monthsAgo(months: number, now = new Date()): string {
  // From the local day (TZ), then counted back as a date-only value.
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - months, now.getDate()));
  return d.toISOString().slice(0, 10);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
