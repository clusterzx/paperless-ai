/**
 * Main-thread side of the OCR worker: starts it on demand, restarts it when
 * the OCR settings change and stops it after a while without work so the
 * memory of the models is given back.
 */
import { Worker } from 'node:worker_threads';
import { logger } from '../logger.js';
import type { PipelineOptions } from './pipeline.js';
import type { RenderOptions } from './render.js';
import type { OcrPageSummary, OcrRequest, OcrWorkerMessage } from './worker.js';

const log = logger.child({ module: 'ocr' });

export interface OcrResult {
  text: string;
  pages: OcrPageSummary[];
  /** Pages of the document (may be more than were read, see maxPages). */
  totalPages: number;
  provider: string;
  durationMs: number;
  /** Mean recognition confidence (0…1). */
  meanScore: number;
}

export type OcrProgress = (page: number, pages: number) => void;

/** Anything that can read a document file – the worker in production, a fake in tests. */
export interface OcrEngine {
  run(bytes: Uint8Array, render: RenderOptions, onProgress?: OcrProgress, signal?: AbortSignal): Promise<OcrResult>;
  readonly provider: string | null;
  dispose(): Promise<void>;
}

export async function ocrAvailable(): Promise<boolean> {
  try {
    await Promise.all([import('onnxruntime-node'), import('sharp'), import('@hyzyla/pdfium')]);
    return true;
  } catch {
    return false;
  }
}

interface Pending {
  resolve: (r: OcrResult) => void;
  reject: (e: Error) => void;
  onProgress?: OcrProgress;
  started: number;
}

export class OcrWorkerEngine implements OcrEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;
  private currentProvider: string | null = null;

  constructor(
    private readonly options: PipelineOptions,
    private readonly idleMs = 10 * 60_000,
  ) {}

  get provider(): string | null {
    return this.currentProvider;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    log.info(`Starting OCR worker (${this.options.language}, ${this.options.detector} detector, device ${this.options.device})`);
    const worker = new Worker(new URL(`./worker.${ext}`, import.meta.url), { workerData: this.options });
    worker.on('message', (msg: OcrWorkerMessage) => {
      if (msg.type === 'log') return log.info(msg.message);
      if (msg.type === 'ready') {
        this.currentProvider = msg.provider;
        return log.info(`OCR models loaded (${msg.provider.toUpperCase()})`);
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') return p.onProgress?.(msg.page, msg.pages);
      this.pending.delete(msg.id);
      if (!this.pending.size) worker.unref();
      if (msg.type === 'error') return p.reject(new Error(msg.error));
      const read = msg.pages.filter((pg) => pg.lines > 0);
      p.resolve({
        text: msg.pages.map((pg) => pg.text).join('\n\n').trim(),
        pages: msg.pages,
        totalPages: msg.totalPages,
        provider: msg.provider,
        durationMs: Date.now() - p.started,
        meanScore: read.length ? read.reduce((s, pg) => s + pg.meanScore * pg.lines, 0) / read.reduce((s, pg) => s + pg.lines, 0) : 0,
      });
    });
    worker.on('error', (err) => {
      log.error({ err }, 'OCR worker crashed');
      this.failAll(err);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0) this.failAll(new Error(`OCR worker exited with code ${code}`));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.worker = null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0 && this.worker) {
        log.info('Stopping idle OCR worker');
        void this.worker.terminate();
        this.worker = null;
      }
    }, this.idleMs);
    this.idleTimer.unref();
  }

  run(bytes: Uint8Array, render: RenderOptions, onProgress?: OcrProgress, signal?: AbortSignal): Promise<OcrResult> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const worker = this.start();
    const id = this.nextId++;
    // A private copy that can be transferred (the caller's buffer may be shared).
    const copy = bytes.slice().buffer;
    return new Promise<OcrResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress, started: Date.now() });
      worker.ref();
      worker.postMessage({ id, bytes: copy, render } satisfies OcrRequest, [copy]);
    }).finally(() => this.touch());
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    this.failAll(new Error('OCR stopped'));
    if (w) await w.terminate();
  }
}
