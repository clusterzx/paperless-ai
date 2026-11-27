/**
 * Optional external API whose response is added to the analysis prompt as
 * additional context (e.g. a list of customers or projects).
 */
import { Worker } from 'node:worker_threads';
import type { AppConfig } from '../config/schema.js';
import { describeError, request } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'external-api' });
const CACHE_MS = 60_000;
const TRANSFORM_TIMEOUT_MS = 2000;

let cache: { key: string; at: number; data: unknown } | null = null;

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/**
 * Run the transform configured by an administrator. The code is either a full
 * `function transform(data) {…}` or a function body.
 *
 * It runs in QuickJS (transformWorker.ts), a JavaScript engine compiled to WebAssembly, in a worker
 * thread: it sees only the JSON data, not Node.js, files, network or the environment of the app,
 * within a memory limit and the time limit – so a slow or endless transform cannot block the server
 * and no transform can reach beyond its data.
 */
export function runTransform(code: string, data: unknown, timeoutMs = TRANSFORM_TIMEOUT_MS): Promise<unknown> {
  const src = code.trim();
  if (!src) return Promise.resolve(data);
  const isFunction = /^(async\s+)?function\b|^(async\s*)?\(?[\w\s,]*\)?\s*=>/.test(src);
  const fn = isFunction ? `(${src})` : `(async function (data) { ${src}\n})`;
  const json = JSON.stringify(data === undefined ? null : data);
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`./transformWorker.${ext}`, import.meta.url), {
      env: {},
      workerData: { fn, json, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    // QuickJS stops the code at the deadline; this is the backstop (loading the engine included).
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`The transform did not finish within ${timeoutMs / 1000} s`));
    }, timeoutMs + 5000);
    const done = () => {
      clearTimeout(timer);
      void worker.terminate();
    };
    worker.once('message', (msg: { ok: boolean; json?: string; error?: string }) => {
      done();
      if (msg.ok) resolve(msg.json === undefined ? undefined : JSON.parse(msg.json));
      else reject(new Error(`Transform failed: ${msg.error}`));
    });
    worker.once('error', (err) => {
      done();
      reject(new Error(`Transform failed: ${err.message}`));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Transform failed: it did not return a result'));
    });
  });
}

export async function fetchExternalData(cfg: AppConfig['externalApi'], useCache = true): Promise<unknown> {
  if (!cfg.enabled || !cfg.url) return undefined;
  const key = JSON.stringify(cfg);
  if (useCache && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    const headers = parseJsonObject(cfg.headers, 'External API headers') as Record<string, string>;
    const body = cfg.method === 'GET' ? undefined : parseJsonObject(cfg.body, 'External API body');
    const res = await request<Response>(cfg.url, {
      method: cfg.method,
      headers,
      body,
      timeoutMs: cfg.timeoutMs,
      responseType: 'response',
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain text response */
    }
    const transformed = await runTransform(cfg.transform, data);
    cache = { key, at: Date.now(), data: transformed };
    return transformed;
  } catch (err) {
    log.warn(`External API request failed – continuing without additional context: ${describeError(err)}`);
    return undefined;
  }
}

export function clearExternalApiCache(): void {
  cache = null;
}
