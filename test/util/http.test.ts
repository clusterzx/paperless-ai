import { describe, expect, it } from 'vitest';
import { describeError, HttpError } from '../../src/server/util/http.js';

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
