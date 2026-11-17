/**
 * Server side of the OCR worker. The OCR runs in a child process: ending it gives back all of its
 * memory – on the GPU including the CUDA context, which a thread could only free together with the
 * whole server – and a crash of a native library cannot take the web server down. The process is
 * started on demand and ends after each document or after a while without work (OCR_RELEASE).
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { OcrRelease } from '../../shared/ocr.js';
import { logger } from '../logger.js';
import type { PipelineOptions } from './pipeline.js';
import type { RenderOptions } from './render.js';
import type { OcrPageSummary, OcrRequest, OcrWorkerMessage } from './worker.js';

const log = logger.child({ module: 'ocr' });

/** A process that does not end on SIGTERM within this time is killed. */
const STOP_TIMEOUT_MS = 5_000;

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

export interface WorkerEngineOptions {
  /** When the process ends (read after every document, so a settings change applies at once). Default: idle. */
  release?: () => OcrRelease;
  /** Without work for this long the process ends (release "idle", or "auto" on the CPU). */
  idleMs?: number;
  /** Tests: another worker script and other Node options for it. */
  entry?: string;
  execArgv?: string[];
}

export class OcrWorkerEngine implements OcrEngine {
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: NodeJS.Timeout | null = null;
  private currentProvider: string | null = null;
  /** The previous process ended after its document – starting the next one is routine, not news. */
  private quiet = false;

  constructor(
    private readonly options: PipelineOptions,
    private readonly opts: WorkerEngineOptions = {},
  ) {}

  get provider(): string | null {
    return this.currentProvider;
  }

  /** Process id of the running OCR worker, null while none runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private note(message: string): void {
    if (this.quiet) log.debug(message);
    else log.info(message);
  }

  private start(): ChildProcess {
    if (this.child) return this.child;
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const entry = this.opts.entry ?? fileURLToPath(new URL(`./worker.${ext}`, import.meta.url));
    this.note(`Starting OCR worker (${this.options.language}, ${this.options.detector} detector, device ${this.options.device})`);
    const child = fork(entry, [JSON.stringify(this.options)], {
      serialization: 'advanced',
      execArgv: this.opts.execArgv ?? process.execArgv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.exited = new Promise((resolve) => child.once('exit', () => resolve()));
    child.on('message', (msg: OcrWorkerMessage) => {
      if (msg.type === 'log') return log.info(msg.message);
      if (msg.type === 'ready') {
        this.currentProvider = msg.provider;
        return this.note(`OCR models loaded (${msg.provider.toUpperCase()})`);
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') return p.onProgress?.(msg.page, msg.pages);
      this.pending.delete(msg.id);
      if (!this.pending.size) hold(child, false);
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
    child.on('error', (err) => {
      log.error({ err }, 'OCR worker failed');
      if (this.child === child) this.child = null;
      this.failAll(err);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      // Only a process that ended unexpectedly still has work.
      if (this.pending.size) this.failAll(new Error(`OCR worker exited unexpectedly (${signal ?? `exit code ${code}`})`));
    });
    hold(child, false);
    this.child = child;
    return child;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** End the process and wait until it is gone (and its memory with it). */
  private async stop(message: string, quiet: boolean): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) return;
    const exited = this.exited;
    this.child = null;
    if (quiet) log.debug(message);
    else log.info(message);
    this.quiet = quiet;
    // Wait for the end even when nothing else keeps the event loop running.
    hold(child, true);
    child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    force.unref();
    await exited;
    clearTimeout(force);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0 && this.child) void this.stop('Stopping idle OCR worker', false);
    }, this.opts.idleMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }

  /** Unload right after this document? On the GPU in "auto" mode – the provider is known once the models are loaded. */
  private releaseAfterDocument(): boolean {
    const mode = this.opts.release?.() ?? 'idle';
    if (mode === 'document') return true;
    return mode === 'auto' && this.currentProvider !== null && this.currentProvider !== 'cpu';
  }

  async run(bytes: Uint8Array, render: RenderOptions, onProgress?: OcrProgress, signal?: AbortSignal): Promise<OcrResult> {
    if (signal?.aborted) throw signal.reason;
    const child = this.start();
    const id = this.nextId++;
    // Only the bytes of this view are sent (a view may share a larger buffer).
    const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    try {
      return await new Promise<OcrResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress, started: Date.now() });
        hold(child, true);
        child.send({ id, bytes: data, render } satisfies OcrRequest, (err) => {
          if (!err || !this.pending.delete(id)) return;
          reject(err);
        });
      });
    } finally {
      // Before the result is returned: the AI analysis that follows gets the freed memory.
      if (!this.pending.size) {
        if (this.releaseAfterDocument()) await this.stop('Unloading the OCR models to free their memory', true);
        else this.touch();
      }
    }
  }

  async dispose(): Promise<void> {
    this.failAll(new Error('OCR stopped'));
    await this.stop('Stopping the OCR worker', true);
  }
}

/** A busy worker keeps the server process alive, an idle one must not (tests, shutdown). */
function hold(child: ChildProcess, busy: boolean): void {
  if (busy) {
    child.ref();
    child.channel?.ref();
  } else {
    child.unref();
    child.channel?.unref();
  }
}
