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

// Runs inside the worker: evaluates the script in a fresh context, awaits async transforms and
// returns the result as JSON (plain values only).
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
(async () => {
  try {
    const context = vm.createContext({ __data: workerData.data }, { codeGeneration: { strings: false, wasm: false } });
    const result = await vm.runInContext(workerData.script, context, { timeout: workerData.timeoutMs });
    parentPort.postMessage({ ok: true, json: result === undefined ? undefined : JSON.stringify(result) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
})();
`;

/**
 * Run the transform configured by an administrator. The code is either a full
 * `function transform(data) {…}` or a function body.
 *
 * This is trusted configuration, not a security sandbox: it runs in a separate worker thread
 * (without the environment variables of the app, with a memory limit) that is terminated after
 * the time limit – so a slow or endless transform (also an async one) cannot block the server.
 */
export function runTransform(code: string, data: unknown, timeoutMs = TRANSFORM_TIMEOUT_MS): Promise<unknown> {
  const src = code.trim();
  if (!src) return Promise.resolve(data);
  const isFunction = /^(async\s+)?function\b|^(async\s*)?\(?[\w\s,]*\)?\s*=>/.test(src);
  const script = isFunction ? `(${src})(__data)` : `(async function (data) { ${src} })(__data)`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      env: {},
      workerData: { script, data, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`The transform did not finish within ${timeoutMs / 1000} s`));
    }, timeoutMs);
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
