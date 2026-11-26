/**
 * OCR API server: other applications send files here to be read with PaddleOCR and get the text
 * and a searchable PDF back – Paperless-ngx as its remote OCR engine (the Azure AI Document
 * Intelligence API), other apps through POST /api/ocr/read (routes/ocrApi.ts). It works whatever
 * the archive mode and whether the own documents are read: the models load with the first file and
 * are unloaded as the OCR settings say.
 *
 * Files are read one after the other (the OCR uses all its threads for one); results are kept until
 * they are fetched, at most an hour.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { logger } from '../logger.js';
import { describeError } from '../util/http.js';
import { isPdf } from './render.js';
import { makeSearchablePdf } from './searchablePdf.js';
import type { OcrService } from './service.js';
import type { PageLayout } from './textLayer.js';

const log = logger.child({ module: 'ocr' });

export type OcrJobStatus = 'notStarted' | 'running' | 'succeeded' | 'failed';

export interface OcrApiPage {
  /** Size of the page as it was read (pixels of the rendered page, before straightening). */
  width: number;
  height: number;
  /** Clockwise turn the OCR applied to read the page. */
  rotation: number;
  text: string;
  /** Offset of the page's text in the whole text. */
  offset: number;
  layout: PageLayout;
}

export interface OcrJob {
  id: string;
  /** Who sent it (only they can fetch the result). */
  owner: string;
  /** The Azure model asked for (prebuilt-read …), `api` for the own API. */
  model: string;
  status: OcrJobStatus;
  created: number;
  updated: number;
  wantsPdf: boolean;
  /** Settles when the job is done (succeeded or failed). */
  done: Promise<void>;
  text?: string;
  pages?: OcrApiPage[];
  pdf?: Uint8Array;
  /** The OCR could not read the file: the result is the file without text. */
  ocrError?: string;
  error?: { code: string; message: string };
  fetchedAt?: number;
}

export class OcrApiBusy extends Error {}

/** Results are kept this long after they are done (Paperless-ngx fetches them at once). */
const KEEP_MS = 60 * 60_000;
/** … and this long after the PDF was fetched. */
const KEEP_FETCHED_MS = 5 * 60_000;
/** More files than this waiting: new ones are refused (Paperless-ngx tries again later). */
const MAX_WAITING = 50;

export class OcrApiServer {
  private readonly jobs = new Map<string, OcrJob>();
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly ocr: OcrService,
  ) {}

  submit(bytes: Uint8Array, opts: { owner: string; model: string; wantsPdf: boolean }): OcrJob {
    this.sweep();
    if (this.waiting >= MAX_WAITING)
      throw new OcrApiBusy(`${this.waiting} files are waiting for the OCR already – try again later`);
    const now = Date.now();
    const job = { id: randomUUID(), ...opts, status: 'notStarted', created: now, updated: now } as OcrJob;
    this.jobs.set(job.id, job);
    this.waiting++;
    const run = this.chain.then(() => this.process(job, bytes));
    job.done = run;
    this.chain = run;
    return job;
  }

  get(id: string, owner: string): OcrJob | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    return job?.owner === owner ? job : undefined;
  }

  /** The PDF was fetched: the job can go soon. */
  fetched(job: OcrJob): void {
    job.fetchedAt ??= Date.now();
  }

  /** The result was handed over (own API): nothing to keep. */
  discard(job: OcrJob): void {
    this.jobs.delete(job.id);
  }

  /** Wait until every file sent so far is done (tests, shutdown). */
  async idle(): Promise<void> {
    await this.chain;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const done = job.status === 'succeeded' || job.status === 'failed';
      if ((done && now - job.updated > KEEP_MS) || (job.fetchedAt && now - job.fetchedAt > KEEP_FETCHED_MS)) this.jobs.delete(id);
    }
  }

  private async process(job: OcrJob, bytes: Uint8Array): Promise<void> {
    this.waiting--;
    job.status = 'running';
    job.updated = Date.now();
    const started = Date.now();
    const kind = isPdf(bytes) ? 'PDF' : 'image';
    try {
      const pages: OcrApiPage[] = [];
      try {
        const result = await this.ocr.readFile(bytes, { label: `File sent to the OCR API (${kind})` });
        let offset = 0;
        result.pages.forEach((p, i) => {
          if (i) offset += 2; // "\n\n" between the pages
          const turned = p.rotation % 180 !== 0;
          pages.push({
            width: turned ? p.height : p.width,
            height: turned ? p.width : p.height,
            rotation: p.rotation,
            text: p.text,
            offset,
            layout: p.layout,
          });
          offset += p.text.length;
        });
      } catch (err) {
        // Not read (the OCR cannot run, or not this file): Paperless-ngx still gets its document –
        // without text, which Paperless-AI's own OCR can read later. The own API reports it.
        job.ocrError = describeError(err);
        log.warn(`OCR API: could not read a ${kind} – the file is given back without OCR text: ${job.ocrError}`);
      }
      const text = pages.map((p) => p.text).join('\n\n');
      if (job.wantsPdf) {
        try {
          job.pdf = (await makeSearchablePdf(
            bytes,
            pages.map((p) => p.layout),
            { always: true },
          ))!.data;
        } catch (err) {
          // An image that cannot be made into a PDF has nothing to give back.
          if (kind !== 'PDF') throw err;
          log.warn(`OCR API: the text could not be laid into the PDF (${describeError(err)}) – it is given back as it was`);
          job.pdf = bytes;
        }
      }
      const ms = Date.now() - started;
      if (text.trim()) this.ctx.repos.ocr.recordRemoteRead(text, { pages: pages.length, durationMs: ms });
      Object.assign(job, { text, pages, status: 'succeeded' });
      log.info(`OCR API: read a ${kind} (${pages.length} page(s), ${text.length} characters, ${(ms / 1000).toFixed(1)}s)`);
    } catch (err) {
      job.status = 'failed';
      job.error = { code: 'InternalServerError', message: `Paperless-AI could not read the file: ${describeError(err)}` };
      log.warn(`OCR API: ${job.error.message}`);
    } finally {
      job.updated = Date.now();
    }
  }
}
