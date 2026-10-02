import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeError, HttpError, request } from '../../src/server/util/http.js';

describe('describeError', () => {
  const http = (body: unknown) => new HttpError('HTTP 400 Bad Request', 400, body, 'http://x');

  it('uses the message of JSON error responses', () => {
    expect(describeError(http({ error: { message: 'Invalid API key', type: 'auth', key: 'sk-…' } }))).toBe('HTTP 400 Bad Request: Invalid API key');
    expect(describeError(http({ error: 'model "x" not found' }))).toBe('HTTP 400 Bad Request: model "x" not found');
    expect(describeError(http({ detail: 'Invalid token.' }))).toBe('HTTP 400 Bad Request: Invalid token.');
    expect(describeError(http({ title: ['This field is required.'] }))).toBe('HTTP 400 Bad Request: {"title":["This field is required."]}');
  });

  it('strips markup and limits the length of text bodies', () => {
    const html = `<html><head><style>body{}</style><script>var t="secret"</script></head><body><h1>502 Bad Gateway</h1>${'x'.repeat(1000)}</body></html>`;
    const msg = describeError(http(html));
    expect(msg).toMatch(/^HTTP 400 Bad Request: 502 Bad Gateway x+…$/);
    expect(msg).not.toContain('secret');
    expect(msg.length).toBeLessThan(350);
  });

  it('describes other errors with their cause', () => {
    expect(describeError(http(undefined))).toBe('HTTP 400 Bad Request');
    expect(describeError(new Error('fetch failed', { cause: new Error('ECONNREFUSED') }))).toBe('fetch failed (ECONNREFUSED)');
    expect(describeError('plain')).toBe('plain');
  });
});

describe('request', () => {
  let server: http.Server;
  let hits = 0;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => res.end('{}');
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    hits = 0;
  });

  it("lifts Node's 300 second limit for response headers (slow local models)", async () => {
    await request(url());
    const dispatcher = (globalThis as unknown as Record<symbol, Record<symbol, unknown>>)[Symbol.for('undici.globalDispatcher.1')];
    const options = Object.getOwnPropertySymbols(dispatcher).find((s) => s.description === 'options');
    expect(dispatcher[options!]).toMatchObject({ headersTimeout: 0, bodyTimeout: 0 });
  });

  it('does not repeat a request after its own timeout', async () => {
    handler = (_req, res) => setTimeout(() => res.end('{}'), 400);
    const err = (await request(url(), { timeoutMs: 100, retries: 2, retryDelayMs: 10 }).catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toContain('timed out');
    expect(hits).toBe(1);
  });

  it('retries short Retry-After waits itself and leaves long ones to the caller', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      res.writeHead(429, { 'Retry-After': calls === 1 ? '0' : '600', 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"slow down"}}');
    };
    const err = (await request(url(), { retries: 3, retryDelayMs: 10 }).catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(600_000);
    expect(hits).toBe(2);

    hits = 0;
    handler = (_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}');
    };
    const quota = (await request(url(), { retries: 3, retryDelayMs: 10 }).catch((e: unknown) => e)) as HttpError;
    expect(quota.retryable).toBe(false);
    expect(hits).toBe(1);
  });
});
