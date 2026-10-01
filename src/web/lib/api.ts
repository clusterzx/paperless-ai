/** Minimal typed client for the Paperless-AI REST API. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Called when any request returns 401 (session expired). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
    signal: init.signal,
  });
  const data = await parse(res);
  if (!res.ok) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    if (res.status === 401 && !path.startsWith('/api/auth/')) unauthorizedListeners.forEach((fn) => fn());
    const message = (body?.error as string) ?? (typeof data === 'string' && data ? data : `Request failed (${res.status})`);
    throw new ApiError(message, res.status, body);
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

/**
 * POST a JSON body and consume a server-sent event stream.
 * Events are JSON objects in `data:` lines; incomplete lines are buffered.
 */
export async function streamEvents<E>(path: string, body: unknown, onEvent: (e: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await parse(res);
    const msg = data && typeof data === 'object' ? ((data as { error?: string }).error ?? '') : String(data ?? '');
    if (res.status === 401) unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(msg || `Request failed (${res.status})`, res.status, null);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as E);
      } catch {
        /* ignore malformed event */
      }
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.name === 'AbortError' ? 'Cancelled' : err.message;
  return String(err);
}
