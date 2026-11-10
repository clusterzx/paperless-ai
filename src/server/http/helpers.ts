import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChatStreamEvent } from '../../shared/api.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

export class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpProblem';
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpProblem(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpProblem(404, msg);
export const forbidden = (msg = 'Forbidden') => new HttpProblem(403, msg);

/** Standard headers for event streams (hijacked replies bypass Fastify hooks, so CORS is set here too). */
function streamHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  };
}

/**
 * Stream server-sent events from an async generator. The generator receives
 * an AbortSignal that fires when the client disconnects (stops the LLM call).
 */
export async function sendEventStream<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  produce: (signal: AbortSignal) => AsyncIterable<T>,
  format: (event: T) => string = (e) => `data: ${JSON.stringify(e)}\n\n`,
  onError: (message: string) => string = (message) => `data: ${JSON.stringify({ type: 'error', message } satisfies ChatStreamEvent)}\n\n`,
  onEnd?: () => string,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, streamHeaders());
  raw.flushHeaders?.();
  const ac = new AbortController();
  raw.on('close', () => {
    if (!raw.writableFinished) ac.abort(new Error('client disconnected'));
  });
  // Writes after a disconnect must not throw (EPIPE / write after end).
  const write = (chunk: string) => {
    if (raw.writableEnded || raw.destroyed) return;
    try {
      raw.write(chunk);
    } catch {
      /* client gone */
    }
  };
  const streams = openStreams.get(req.server.server) ?? new Set<AbortController>();
  openStreams.set(req.server.server, streams);
  streams.add(ac);
  const keepAlive = setInterval(() => write(': ping\n\n'), 15_000);
  try {
    for await (const event of produce(ac.signal)) {
      if (ac.signal.aborted) break;
      write(format(event));
    }
    if (onEnd && !ac.signal.aborted) write(onEnd());
  } catch (err) {
    if (!ac.signal.aborted) {
      logger.warn({ module: 'http', url: req.url }, `Stream failed: ${describeError(err)}`);
      write(onError(describeError(err)));
    }
  } finally {
    clearInterval(keepAlive);
    streams.delete(ac);
    if (!raw.writableEnded) raw.end();
  }
}

/** Open event streams per HTTP server – ended on shutdown so that closing the server does not hang. */
const openStreams = new WeakMap<object, Set<AbortController>>();

export function endEventStreams(server: object): void {
  for (const ac of openStreams.get(server) ?? []) ac.abort(new Error('server shutting down'));
}

/** Extract a document id from a Paperless URL (".../documents/123/...") or a plain number. */
export function documentIdFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /\/documents\/(\d+)(?:\/|$|\?)/.exec(s);
  return m ? Number(m[1]) : null;
}
