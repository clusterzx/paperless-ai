/**
 * Small, dependency-free HTTP helper built on the global fetch (undici).
 * Provides timeouts, retries with exponential backoff (honouring Retry-After)
 * and a typed error that carries status code and response body.
 */

/** 429 responses that waiting does not fix. */
export const QUOTA_EXHAUSTED = /insufficient_quota|exceeded your current quota|billing|credit balance|out of credits/i;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly url: string,
    /** Wait time from a Retry-After header. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** Whether repeating the very same request may succeed. */
  get retryable(): boolean {
    if (this.status === 429) return !QUOTA_EXHAUSTED.test(typeof this.body === 'string' ? this.body : JSON.stringify(this.body ?? ''));
    return this.status === 0 || this.status === 408 || this.status === 425 || this.status >= 500;
  }
}

export type ResponseType = 'json' | 'text' | 'buffer' | 'response';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Plain objects/arrays are JSON encoded, strings/buffers are sent as is. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  retries?: number;
  /** Base delay for exponential backoff. */
  retryDelayMs?: number;
  signal?: AbortSignal;
  responseType?: ResponseType;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export function buildUrl(url: string, query?: RequestOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function retryAfterMs(res: Response, max = 60_000): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, max);
  const date = Date.parse(h);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), max));
  return undefined;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  }
}

/**
 * The useful part of an error response: the message field of JSON APIs (OpenAI, Ollama, Django REST
 * framework …) or the start of a text body without markup – never the complete upstream response.
 */
function errorDetail(body: unknown): string {
  let detail = '';
  if (typeof body === 'string') {
    detail = body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  } else if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const nested = b.error && typeof b.error === 'object' ? (b.error as Record<string, unknown>).message : undefined;
    const candidate = nested ?? b.error ?? b.detail ?? b.message;
    detail = typeof candidate === 'string' ? candidate : JSON.stringify(body);
  }
  detail = detail.replace(/\s+/g, ' ').trim();
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
}

export function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    const detail = errorDetail(err.body);
    return `${err.message}${detail ? `: ${detail}` : ''}`;
  }
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !err.message.includes(cause.message)) {
      return `${err.message} (${cause.message})`;
    }
    return err.message;
  }
  return String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
let dispatcherReady: Promise<void> | null = null;

/**
 * Node's fetch gives up after 300 seconds without response headers – before a slow local model
 * has answered, whatever timeout is configured. Recreate its connection pool without those
 * limits; every request has its own timeout (AbortSignal) anyway.
 */
function liftFetchTimeouts(): Promise<void> {
  dispatcherReady ??= (async () => {
    try {
      await fetch('data:,'); // makes Node create its default dispatcher (no network access)
      const g = globalThis as unknown as Record<symbol, unknown>;
      const current = g[GLOBAL_DISPATCHER] as { constructor: new (opts: object) => unknown } | undefined;
      // Only the built-in pools (EnvHttpProxyAgent with NODE_USE_ENV_PROXY) – never a custom dispatcher.
      if (current && ['Agent', 'EnvHttpProxyAgent'].includes(current.constructor.name)) {
        g[GLOBAL_DISPATCHER] = new current.constructor({ headersTimeout: 0, bodyTimeout: 0 });
      }
    } catch {
      /* keep the defaults */
    }
  })();
  return dispatcherReady;
}

/**
 * Perform an HTTP request. Throws HttpError for non-2xx responses and network failures.
 */
export async function request<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  await liftFetchTimeouts();
  const {
    method = 'GET',
    headers = {},
    body,
    query,
    timeoutMs = 30_000,
    retries = 0,
    retryDelayMs = 500,
    signal,
    responseType = 'json',
  } = opts;

  const finalUrl = buildUrl(url, query);
  const finalHeaders: Record<string, string> = { ...headers };
  let payload: RequestInit['body'];
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      payload = body as RequestInit['body'];
    } else if (body instanceof FormData || body instanceof URLSearchParams) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!Object.keys(finalHeaders).some((h) => h.toLowerCase() === 'content-type')) {
        finalHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  let attempt = 0;
  for (;;) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const res = await fetch(finalUrl, { method, headers: finalHeaders, body: payload, signal: combined });
      if (!res.ok) {
        const errBody = await readBody(res);
        const wait = retryAfterMs(res, 3_600_000);
        const err = new HttpError(`${method} ${redactUrl(finalUrl)} failed with HTTP ${res.status}`, res.status, errBody, finalUrl, wait);
        // Retry right here only when the server asks for a short wait – longer ones are the caller's business.
        if (err.retryable && attempt < retries && (wait === undefined || wait <= 60_000)) {
          attempt++;
          await sleep(wait ?? backoff(retryDelayMs, attempt), signal);
          continue;
        }
        throw err;
      }
      switch (responseType) {
        case 'response':
          return res as T;
        case 'text':
          return (await res.text()) as T;
        case 'buffer':
          return Buffer.from(await res.arrayBuffer()) as T;
        default: {
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          if (!text) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new HttpError(`${method} ${redactUrl(finalUrl)} returned invalid JSON`, res.status, text.slice(0, 500), finalUrl);
          }
        }
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (signal?.aborted) throw signal.reason ?? err;
      const timedOut = isAbortError(err) && timeoutSignal.aborted;
      const wrapped = new HttpError(
        timedOut
          ? `${method} ${redactUrl(finalUrl)} timed out after ${Math.round(timeoutMs / 1000)}s`
          : `${method} ${redactUrl(finalUrl)} failed: ${describeError(err)}`,
        0,
        undefined,
        finalUrl,
      );
      // After our own timeout the server is busy (or the model too slow) – trying again only doubles the wait.
      if (attempt < retries && !timedOut) {
        attempt++;
        await sleep(backoff(retryDelayMs, attempt), signal);
        continue;
      }
      throw wrapped;
    }
  }
}

function backoff(base: number, attempt: number): number {
  const exp = base * 2 ** (attempt - 1);
  return Math.min(exp + Math.random() * base, 30_000);
}

/** Remove credentials from URLs before they end up in logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    for (const key of ['key', 'api_key', 'apikey', 'token']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '***');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Ensure a base URL has no trailing slash. */
export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
