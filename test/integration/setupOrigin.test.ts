import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ configured: false });
});
afterAll(() => h.close());

const OTHER = 'https://other.example';

function setupPayload(username = 'admin') {
  return {
    username,
    password: 'long enough password',
    config: {
      paperless: { url: h.paperless.url, token: h.paperless.token },
      ai: { provider: 'custom', custom: { baseUrl: h.llm.openaiUrl, model: 'test-model', apiKey: 'sk-setup' } },
    },
  };
}

describe('setup wizard and other origins', () => {
  it('answers no preflight for the setup endpoints', async () => {
    for (const url of ['/api/setup', '/api/setup/', '/api/%73etup', '/api/setup/test-paperless', '/api/setup/test-ai', '/api/setup/models', '/api/setup/defaults?x=1']) {
      const res = await h.inject({
        method: 'OPTIONS',
        url,
        headers: { origin: OTHER, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true' },
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.headers['access-control-allow-origin'], url).toBeUndefined();
      expect(res.headers['access-control-allow-headers'], url).toBeUndefined();
      expect(res.headers['access-control-allow-private-network'], url).toBeUndefined();
    }
  });

  it('does not let other origins read the setup endpoints', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/setup/defaults', headers: { origin: OTHER } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rejects setup requests sent by a page of another site', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const headers = { origin: OTHER, 'sec-fetch-site': site };
      const post = await h.inject({ method: 'POST', url: '/api/setup', headers, payload: { ...setupPayload('evil'), force: true } });
      expect(post.statusCode, site).toBe(403);
      const test = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', headers, payload: { url: h.paperless.url, token: h.paperless.token } });
      expect(test.statusCode, site).toBe(403);
      const defaults = await h.inject({ method: 'GET', url: '/api/setup/defaults', headers });
      expect(defaults.statusCode, site).toBe(403);
    }
    expect(h.paperless.requests).toHaveLength(0);
    expect(h.ctx.repos.users.count()).toBe(0);
    expect(h.ctx.cfg.setupCompleted).toBe(false);
  });

  it('only accepts a JSON body, which browsers send to other origins only after a preflight', async () => {
    const body = JSON.stringify({ ...setupPayload('evil'), force: true });
    const text = await h.inject({ method: 'POST', url: '/api/setup', headers: { origin: OTHER, 'content-type': 'text/plain' }, payload: body });
    expect(text.statusCode).toBe(400);
    const form = await h.inject({ method: 'POST', url: '/api/setup', headers: { origin: OTHER, 'content-type': 'application/x-www-form-urlencoded' }, payload: body });
    expect(form.statusCode).toBe(415);
    expect(h.ctx.repos.users.count()).toBe(0);
  });

  it('keeps CORS for the endpoints that take an API key', async () => {
    const preflight = await h.inject({
      method: 'OPTIONS',
      url: '/chat/message',
      headers: { origin: OTHER, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-api-key' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-headers']).toContain('x-api-key');
    const health = await h.inject({ method: 'GET', url: '/health', headers: { origin: OTHER } });
    expect(health.headers['access-control-allow-origin']).toBe('*');
  });

  it('still runs the wizard from its own page', async () => {
    const headers = { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' };
    const defaults = await h.inject({ method: 'GET', url: '/api/setup/defaults', headers });
    expect(defaults.statusCode).toBe(200);
    const test = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', headers, payload: { url: h.paperless.url, token: h.paperless.token } });
    expect(test.json()).toMatchObject({ ok: true });
    // a client that sends no fetch metadata (curl, a browser on a plain http:// address)
    const res = await h.inject({ method: 'POST', url: '/api/setup', payload: setupPayload() });
    expect(res.statusCode).toBe(200);
    expect(h.ctx.repos.users.count()).toBe(1);
  });
});
