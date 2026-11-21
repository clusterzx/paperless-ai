/**
 * The vector index of "Ask your archive" – in-process (tests, small installations) or in a worker
 * thread (default for the server), behind one interface.
 */
import { Worker } from 'node:worker_threads';
import { VectorIndex, type VectorHit } from './vectorIndex.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'rag' });

export interface VectorSearch {
  readonly count: number;
  readonly memoryBytes: number;
  add(id: number, documentId: number, vector: Float32Array): void;
  addMany(items: { id: number; documentId: number; vector: Float32Array }[]): void;
  remove(id: number): void;
  removeDocument(documentId: number): void;
  clear(): void;
  search(query: Float32Array, k: number, allowDocs?: Set<number> | null): Promise<VectorHit[]>;
  /** Resolves when all earlier changes are applied. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class LocalVectors implements VectorSearch {
  private readonly index = new VectorIndex();

  get count() {
    return this.index.count;
  }

  get memoryBytes() {
    return this.index.memoryBytes;
  }

  add(id: number, documentId: number, vector: Float32Array): void {
    this.index.add(id, documentId, vector);
  }

  addMany(items: { id: number; documentId: number; vector: Float32Array }[]): void {
    this.index.addMany(items);
  }

  remove(id: number): void {
    this.index.remove(id);
  }

  removeDocument(documentId: number): void {
    this.index.removeDocument(documentId);
  }

  clear(): void {
    this.index.clear();
  }

  async search(query: Float32Array, k: number, allowDocs?: Set<number> | null): Promise<VectorHit[]> {
    return this.index.search(query, k, allowDocs);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export class WorkerVectors implements VectorSearch {
  private worker: Worker;
  private reqId = 0;
  private readonly waiting = new Map<number, { resolve: (hits: VectorHit[]) => void; reject: (err: Error) => void }>();
  private known = { count: 0, memoryBytes: 0 };
  /** Changes not yet confirmed by the worker (the count includes them optimistically). */
  private pendingAdds = 0;
  /** Dimensions of the index – checked here, so a mismatch fails at once like in-process. */
  private dims = 0;

  constructor() {
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    this.worker = new Worker(new URL(`./vectorWorker.${ext}`, import.meta.url));
    this.worker.unref();
    this.worker.on('message', (msg: { type: string; reqId?: number; hits?: VectorHit[]; error?: string; count?: number; memoryBytes?: number }) => {
      if (msg.count !== undefined) this.known = { count: msg.count, memoryBytes: msg.memoryBytes ?? 0 };
      if (msg.type === 'state') this.pendingAdds = 0;
      if (msg.type === 'error') log.error(`Vector index worker: ${msg.error}`);
      if (msg.type !== 'result' || msg.reqId === undefined) return;
      const p = this.waiting.get(msg.reqId);
      if (!p) return;
      this.waiting.delete(msg.reqId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.hits ?? []);
    });
    this.worker.on('error', (err) => {
      log.error({ err }, 'Vector index worker crashed');
      for (const p of this.waiting.values()) p.reject(err);
      this.waiting.clear();
    });
  }

  get count() {
    return this.known.count + this.pendingAdds;
  }

  get memoryBytes() {
    return this.known.memoryBytes;
  }

  add(id: number, documentId: number, vector: Float32Array): void {
    this.addMany([{ id, documentId, vector }]);
  }

  addMany(items: { id: number; documentId: number; vector: Float32Array }[]): void {
    if (!items.length) return;
    for (const i of items) {
      if (!this.dims) this.dims = i.vector.length;
      if (i.vector.length !== this.dims) throw new Error(`Vector has ${i.vector.length} dimensions, index expects ${this.dims}`);
    }
    this.pendingAdds += items.length;
    this.worker.postMessage({ type: 'add', items: items.map((i) => ({ id: i.id, documentId: i.documentId, vector: Float32Array.from(i.vector) })) });
  }

  remove(id: number): void {
    this.worker.postMessage({ type: 'remove', ids: [id] });
  }

  removeDocument(documentId: number): void {
    this.worker.postMessage({ type: 'removeDocument', documentId });
  }

  clear(): void {
    this.pendingAdds = 0;
    this.dims = 0;
    this.known = { count: 0, memoryBytes: 0 };
    this.worker.postMessage({ type: 'clear' });
  }

  private request(msg: object): Promise<VectorHit[]> {
    const reqId = ++this.reqId;
    this.worker.ref();
    return new Promise<VectorHit[]>((resolve, reject) => {
      this.waiting.set(reqId, { resolve, reject });
      this.worker.postMessage({ ...msg, reqId });
    }).finally(() => {
      if (!this.waiting.size) this.worker.unref();
    });
  }

  search(query: Float32Array, k: number, allowDocs?: Set<number> | null): Promise<VectorHit[]> {
    return this.request({ type: 'search', query: Float32Array.from(query), k, allowDocs: allowDocs ? [...allowDocs] : null });
  }

  async flush(): Promise<void> {
    await this.request({ type: 'flush' });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
  }
}

/** The worker by default; in-process in tests and with PAPERLESS_AI_VECTOR_WORKER=0. */
export function createVectorSearch(): VectorSearch {
  const off = process.env.PAPERLESS_AI_VECTOR_WORKER === '0' || (process.env.VITEST && process.env.PAPERLESS_AI_VECTOR_WORKER !== '1');
  if (off) return new LocalVectors();
  try {
    return new WorkerVectors();
  } catch (err) {
    log.warn(`Vector search runs in the main thread – the worker could not be started: ${err instanceof Error ? err.message : String(err)}`);
    return new LocalVectors();
  }
}
