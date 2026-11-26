/**
 * Remote OCR for Paperless-ngx. Paperless-ngx can hand the scans it consumes to a remote OCR engine
 * (PAPERLESS_REMOTE_OCR_ENGINE=azureai). Pointed at Paperless-AI, they are read here with PaddleOCR
 * and Paperless-ngx gets the text and a searchable PDF back, in the protocol of Azure AI Document
 * Intelligence (model prebuilt-read) that its SDK speaks – see routes/remoteOcr.ts.
 *
 * Files are read one after the other (the OCR uses all its threads for one); results are kept until
 * Paperless-ngx has fetched them, at most an hour.
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

export type RemoteJobStatus = 'notStarted' | 'running' | 'succeeded' | 'failed';

/** A page of the result as Azure describes it (Paperless-ngx only reads the text). */
export interface RemotePage {
  pageNumber: number;
  angle: number;
  width: number;
  height: number;
  unit: 'pixel';
  spans: { offset: number; length: number }[];
}

export interface RemoteJob {
  id: string;
  /** Who sent it (only they can fetch the result). */
  owner: string;
  model: string;
  status: RemoteJobStatus;
  created: number;
  updated: number;
  wantsPdf: boolean;
  text?: string;
  pages?: RemotePage[];
  pdf?: Uint8Array;
  error?: { code: string; message: string };
  fetchedAt?: number;
}

export class RemoteOcrBusy extends Error {}

/** Results are kept this long after they are done (Paperless-ngx fetches them at once). */
const KEEP_MS = 60 * 60_000;
/** … and this long after the PDF was fetched. */
const KEEP_FETCHED_MS = 5 * 60_000;
/** More files than this waiting: new ones are refused (Paperless-ngx tries again later). */
const MAX_WAITING = 50;

export class RemoteOcr {
  private readonly jobs = new Map<string, RemoteJob>();
  private chain: Promise<void> = Promise.resolve();
  private waiting = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly ocr: OcrService,
  ) {}

  submit(bytes: Uint8Array, opts: { owner: string; model: string; wantsPdf: boolean }): RemoteJob {
    this.sweep();
    if (this.waiting >= MAX_WAITING)
      throw new RemoteOcrBusy(`${this.waiting} files are waiting for the OCR already – try again later`);
    const now = Date.now();
    const job: RemoteJob = { id: randomUUID(), ...opts, status: 'notStarted', created: now, updated: now };
    this.jobs.set(job.id, job);
    this.waiting++;
    this.chain = this.chain.then(() => this.process(job, bytes));
    return job;
  }

  get(id: string, owner: string): RemoteJob | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    return job?.owner === owner ? job : undefined;
  }

  /** Paperless-ngx has the PDF: the job can go soon. */
  fetched(job: RemoteJob): void {
    job.fetchedAt ??= Date.now();
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

  private async process(job: RemoteJob, bytes: Uint8Array): Promise<void> {
    this.waiting--;
    job.status = 'running';
    job.updated = Date.now();
    const started = Date.now();
    const kind = isPdf(bytes) ? 'PDF' : 'image';
    try {
      const pageTexts: string[] = [];
      const pages: RemotePage[] = [];
      let layouts: PageLayout[] = [];
      try {
        const result = await this.ocr.readFile(bytes, { label: `Scan from Paperless-ngx (${kind})` });
        layouts = result.pages.map((p) => p.layout);
        let offset = 0;
        result.pages.forEach((p, i) => {
          if (i) offset += 2; // "\n\n" between the pages
          const turned = p.rotation % 180 !== 0;
          pages.push({
            pageNumber: i + 1,
            angle: 0,
            width: turned ? p.height : p.width,
            height: turned ? p.width : p.height,
            unit: 'pixel',
            spans: [{ offset, length: p.text.length }],
          });
          pageTexts.push(p.text);
          offset += p.text.length;
        });
      } catch (err) {
        // Not read (the OCR cannot run, or not this file): Paperless-ngx still gets its document –
        // without text, which Paperless-AI's own OCR can read later.
        log.warn(
          `Remote OCR: could not read a ${kind} for Paperless-ngx – it gets the file without OCR text: ${describeError(err)}`,
        );
      }
      const text = pageTexts.join('\n\n');
      if (job.wantsPdf) {
        try {
          job.pdf = (await makeSearchablePdf(bytes, layouts, { always: true }))!.data;
        } catch (err) {
          // An image that cannot be made into a PDF has nothing to give back.
          if (kind !== 'PDF') throw err;
          log.warn(
            `Remote OCR: the text could not be laid into the PDF (${describeError(err)}) – Paperless-ngx gets it as it was`,
          );
          job.pdf = bytes;
        }
      }
      const ms = Date.now() - started;
      if (text.trim()) this.ctx.repos.ocr.recordRemoteRead(text, { pages: pages.length, durationMs: ms });
      Object.assign(job, { text, pages, status: 'succeeded' });
      log.info(
        `Remote OCR: read a ${kind} for Paperless-ngx (${pages.length} page(s), ${text.length} characters, ${(ms / 1000).toFixed(1)}s)`,
      );
    } catch (err) {
      job.status = 'failed';
      job.error = { code: 'InternalServerError', message: `Paperless-AI could not read the file: ${describeError(err)}` };
      log.warn(`Remote OCR: ${job.error.message}`);
    } finally {
      job.updated = Date.now();
    }
  }
}
