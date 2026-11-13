import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext } from '../../src/server/context.js';
import { SESSION_COOKIE } from '../../src/server/auth.js';
import { createHarness, makeTempDir, type Harness } from '../helpers/appHarness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ configured: false });
});
afterAll(() => h.close());

function setupPayload() {
  return {
    username: 'admin',
    password: 'long enough password',
    config: {
      paperless: { url: h.paperless.url, token: h.paperless.token },
      ai: { provider: 'custom', custom: { baseUrl: h.llm.openaiUrl, model: 'test-model', apiKey: 'sk-setup' } },
    },
  };
}

// h.inject() adds the setup token like the wizard does, so these tests talk to the app directly.
const requests = () =>
  [
    { method: 'GET', url: '/api/setup/defaults' },
    { method: 'POST', url: '/api/setup/test-paperless', payload: { url: h.paperless.url, token: h.paperless.token } },
    { method: 'POST', url: '/api/setup/test-ai', payload: { ai: setupPayload().config.ai } },
    { method: 'POST', url: '/api/setup/models', payload: { ai: setupPayload().config.ai } },
    { method: 'POST', url: '/api/setup', payload: { ...setupPayload(), force: true } },
  ] as const;

describe('setup token', () => {
  it('is random and not part of any public response', async () => {
    expect(h.ctx.setupToken).toMatch(/^[0-9a-f]{32}$/);
    const other = new AppContext({ dataDir: makeTempDir(), env: {}, memoryDb: true });
    expect(other.setupToken).not.toBe(h.ctx.setupToken);
    other.close();
    for (const url of ['/api/session', '/health']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(h.ctx.setupToken);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ setupRequired: true, needsUser: true });
  });

  it('is required by every setup endpoint while no account exists', async () => {
    for (const headers of [undefined, { 'x-setup-token': '' }, { 'x-setup-token': 'f'.repeat(32) }, { 'x-setup-token': h.ctx.setupToken.slice(0, 31) }, h.apiKeyHeaders()]) {
      for (const req of requests()) {
        const res = await h.app.inject({ ...req, headers });
        expect(res.statusCode, `${req.url} ${JSON.stringify(headers)}`).toBe(403);
        expect(res.json()).toEqual({ error: 'Enter the setup token from the Paperless-AI log', code: 'setup_token' });
      }
    }
    expect(h.paperless.requests).toHaveLength(0);
    expect(h.llm.requests).toHaveLength(0);
    expect(h.ctx.repos.users.count()).toBe(0);
    expect(h.ctx.cfg.setupCompleted).toBe(false);
  });

  it('opens the setup endpoints', async () => {
    const headers = { 'x-setup-token': h.ctx.setupToken };
    const defaults = await h.app.inject({ method: 'GET', url: '/api/setup/defaults', headers });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({ needsUser: true });
    const test = await h.app.inject({ method: 'POST', url: '/api/setup/test-paperless', headers, payload: { url: h.paperless.url, token: h.paperless.token } });
    expect(test.json()).toMatchObject({ ok: true });
    const res = await h.app.inject({ method: 'POST', url: '/api/setup', headers, payload: setupPayload() });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeDefined();
    expect(h.ctx.repos.users.count()).toBe(1);
  });

  it('is worth nothing once the account exists', async () => {
    const headers = { 'x-setup-token': h.ctx.setupToken };
    for (const req of requests()) {
      const res = await h.app.inject({ ...req, headers });
      expect(res.statusCode, req.url).toBe(401);
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/settings', headers })).statusCode).toBe(401);
    expect(h.ctx.repos.users.count()).toBe(1);
  });

  it('is not needed by a logged-in user who finishes an interrupted setup', async () => {
    const legacy = await createHarness({ configured: false });
    try {
      // e.g. an account imported from 3.x without a usable configuration
      const cookie = await legacy.login();
      expect(legacy.ctx.needsSetup()).toBe(true);
      const anonymous = await legacy.app.inject({ method: 'GET', url: '/api/setup/defaults', headers: { 'x-setup-token': legacy.ctx.setupToken } });
      expect(anonymous.statusCode).toBe(401);
      const loggedIn = await legacy.app.inject({ method: 'GET', url: '/api/setup/defaults', headers: { cookie } });
      expect(loggedIn.statusCode).toBe(200);
      expect(loggedIn.json()).toMatchObject({ needsUser: false });
    } finally {
      await legacy.close();
    }
  });
});
