/**
 * Local embeddings (no external service) using a small multilingual ONNX
 * model in a worker thread. The worker is started lazily and stopped after a
 * period of inactivity to give the memory back.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { embeddingPrefix } from '../ai/factory.js';
import { AiError, type EmbeddingClient, type EmbeddingKind } from '../ai/types.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'embeddings' });

export async function localEmbeddingsAvailable(): Promise<boolean> {
  try {
    await import('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

export class LocalEmbedder implements EmbeddingClient {
  readonly id: string;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly model: string,
    private readonly cacheDir: string,
    private readonly idleMs = 5 * 60_000,
    private readonly batchSize = 16,
  ) {
    this.id = `local:${model}`;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const threads = Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));
    log.info(`Starting local embedding worker (${this.model}, ${threads} threads)`);
    const worker = new Worker(new URL(`./embedWorker.${ext}`, import.meta.url), {
      workerData: { model: this.model, cacheDir: this.cacheDir, threads },
    });
    worker.on('message', (msg: { id: number; vectors?: Float32Array[]; error?: string }) => {
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      if (msg.error) pending.reject(new AiError(`Local embedding failed: ${msg.error}`));
      else pending.resolve(msg.vectors ?? []);
      // An idle worker must not keep the process alive; a busy one must.
      if (!this.waiting.size) worker.unref();
    });
    worker.on('error', (err) => {
      log.error({ err }, 'Embedding worker crashed');
      this.failAll(err);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (code !== 0) this.failAll(new Error(`Embedding worker exited with code ${code}`));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failAll(err: Error): void {
    for (const p of this.waiting.values()) p.reject(err);
    this.waiting.clear();
    this.worker = null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.waiting.size === 0 && this.worker) {
        log.info('Stopping idle embedding worker');
        void this.worker.terminate();
        this.worker = null;
      }
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private run(texts: string[]): Promise<Float32Array[]> {
    const worker = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ id, texts });
    });
  }

  async embed(texts: string[], kind: EmbeddingKind, signal?: AbortSignal): Promise<Float32Array[]> {
    const prefix = embeddingPrefix(this.model, kind);
    const out: Float32Array[] = [];
    try {
      for (let i = 0; i < texts.length; i += this.batchSize) {
        if (signal?.aborted) throw signal.reason;
        const batch = texts.slice(i, i + this.batchSize).map((t) => prefix + t);
        out.push(...(await this.run(batch)));
      }
    } finally {
      this.touch();
    }
    return out;
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}
