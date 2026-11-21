/**
 * Pool of read-only SQLite connections in worker threads. better-sqlite3 is synchronous: a query of
 * 50–200 ms on a large archive would stop every other request. Heavy reads (document lists, full
 * text, counts, facets) run here instead; WAL lets them read next to the writer in the main thread
 * (docs/standalone/search-and-scale.md §5). In-memory databases (tests) run on the given connection.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Db } from './database.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'db' });

export class ReadPool {
  private readonly workers: Worker[] = [];
  private next = 0;
  private reqId = 0;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; worker: Worker }>();
  private readonly busy = new Map<Worker, number>();

  private constructor(
    private readonly fallback: Db,
    file: string | null,
    size: number,
  ) {
    if (!file) return;
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    for (let i = 0; i < size; i++) {
      try {
        const w = new Worker(new URL(`./readWorker.${ext}`, import.meta.url), { workerData: { file } });
        w.unref();
        w.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
          const p = this.waiting.get(msg.id);
          if (!p) return;
          this.waiting.delete(msg.id);
          const n = (this.busy.get(w) ?? 1) - 1;
          this.busy.set(w, n);
          if (!n) w.unref();
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        });
        w.on('error', (err) => {
          log.error({ err }, 'Database read worker crashed');
          for (const [id, p] of this.waiting) {
            if (p.worker !== w) continue;
            this.waiting.delete(id);
            p.reject(err);
          }
          const idx = this.workers.indexOf(w);
          if (idx >= 0) this.workers.splice(idx, 1);
        });
        this.workers.push(w);
      } catch (err) {
        log.warn(`Database reads run in the main thread – a read worker could not be started: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }
  }

  /** A pool for the database file of `db` (none for in-memory databases or with PAPERLESS_AI_READERS=0). */
  static for(db: Db): ReadPool {
    const file = db.memory || db.name === ':memory:' ? null : db.name;
    const configured = process.env.PAPERLESS_AI_READERS;
    const inTests = Boolean(process.env.VITEST) && configured === undefined;
    const size = configured !== undefined ? Number(configured) : Math.min(4, Math.max(1, os.availableParallelism() - 1));
    return new ReadPool(db, inTests || !Number.isFinite(size) || size <= 0 ? null : file, inTests ? 0 : size);
  }

  get threads(): number {
    return this.workers.length;
  }

  private run<T>(op: 'all' | 'get', sql: string, params: unknown[]): Promise<T> {
    if (!this.workers.length) {
      const st = this.fallback.prepare(sql);
      return Promise.resolve((op === 'all' ? st.all(...params) : st.get(...params)) as T);
    }
    // The least busy worker (round robin among equals).
    let w = this.workers[this.next++ % this.workers.length];
    for (const c of this.workers) if ((this.busy.get(c) ?? 0) < (this.busy.get(w) ?? 0)) w = c;
    const id = ++this.reqId;
    this.busy.set(w, (this.busy.get(w) ?? 0) + 1);
    w.ref();
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, worker: w });
      w.postMessage({ id, op, sql, params });
    });
  }

  all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.run<T[]>('all', sql, params);
  }

  get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.run<T | undefined>('get', sql, params);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers.length = 0;
  }
}
