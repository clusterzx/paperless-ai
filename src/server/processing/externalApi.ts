/**
 * Optional external API whose response is added to the analysis prompt as
 * additional context (e.g. a list of customers or projects).
 */
import vm from 'node:vm';
import type { AppConfig } from '../config/schema.js';
import { describeError, request } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'external-api' });
const CACHE_MS = 60_000;

let cache: { key: string; at: number; data: unknown } | null = null;

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${what} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

/**
 * Run the user supplied transform in an isolated context with a time limit.
 * The code is either a full `function transform(data) {…}` or a function body.
 */
export function runTransform(code: string, data: unknown): unknown {
  const src = code.trim();
  if (!src) return data;
  const isFunction = /^(async\s+)?function\b|^\(?[\w\s,]*\)?\s*=>/.test(src);
  const script = isFunction
    ? `(${src})(__data)`
    : `(function (data) { ${src} })(__data)`;
  const sandbox = vm.createContext({ __data: structuredClone(data) }, { codeGeneration: { strings: false, wasm: false } });
  return vm.runInContext(script, sandbox, { timeout: 1000, displayErrors: false });
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
    // Round-trip through JSON so objects from the sandbox realm become plain values.
    const result = await runTransform(cfg.transform, data);
    const transformed = result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as unknown);
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
