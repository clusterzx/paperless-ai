import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/server/auth.js';
import { SECRET_MASK } from '../../src/server/config/schema.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { startMockLlm } from '../helpers/mockLlm.js';
import { startMockPaperless } from '../helpers/mockPaperless.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ configured: false });
});
afterAll(() => h.close());

function setupConfig(overrides: Record<string, unknown> = {}) {
  return {
    paperless: { url: `${h.paperless.url}/api/`, token: h.paperless.token },
    ai: { provider: 'custom', custom: { baseUrl: h.llm.openaiUrl, model: 'test-model', apiKey: 'sk-setup' } },
    ...overrides,
  };
}

describe('setup wizard', () => {
  let cookie = '';

  it('reports that setup is required', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/session' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: false, setupRequired: true, needsUser: true, version: '4.0.0' });
    const health = await h.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ status: 'not_configured' });
  });

  it('protected routes are not reachable before setup', async () => {
    expect((await h.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
  });

  it('tests the Paperless connection without authentication during setup', async () => {
    const ok = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', payload: { url: `${h.paperless.url}/api`, token: h.paperless.token } });
    expect(ok.json()).toMatchObject({ ok: true, details: { apiVersion: 10, documents: 0, user: { username: 'paperless-ai' } } });
    const bad = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', payload: { url: h.paperless.url, token: 'wrong' } });
    expect(bad.json()).toMatchObject({ ok: false, message: expect.stringContaining('401') });
    const invalid = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', payload: { url: 'not a url', token: 'x' } });
    expect(invalid.json()).toMatchObject({ ok: false, message: expect.stringContaining('valid URL') });
  });

  it('lists models of the AI provider during setup', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/setup/models', payload: { ai: setupConfig().ai } });
    expect(res.json()).toEqual({ models: ['other-model', 'test-model'] });
  });

  it('never sends preset secrets to another server before an account exists', async () => {
    // e.g. token and key preset by environment variables on a fresh installation
    h.ctx.config.update({ paperless: { url: h.paperless.url, token: h.paperless.token }, ai: { provider: 'custom', custom: { baseUrl: h.llm.openaiUrl, model: 'test-model', apiKey: 'sk-preset' } } });
    const otherPaperless = await startMockPaperless({ token: 'other' });
    const otherLlm = await startMockLlm();
    try {
      const same = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', payload: { url: h.paperless.url, token: SECRET_MASK } });
      expect(same.json()).toMatchObject({ ok: true });
      const other = await h.inject({ method: 'POST', url: '/api/setup/test-paperless', payload: { url: otherPaperless.url, token: SECRET_MASK } });
      expect(other.json()).toMatchObject({ ok: false, message: expect.stringContaining('API token') });
      const setup = await h.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'evil', password: 'long enough password', config: { paperless: { url: otherPaperless.url } } },
      });
      expect(setup.json()).toMatchObject({ step: 'paperless' });
      expect(otherPaperless.requests).toHaveLength(0);

      await h.inject({ method: 'POST', url: '/api/setup/models', payload: { ai: { custom: { baseUrl: otherLlm.openaiUrl, apiKey: SECRET_MASK } } } });
      await h.inject({ method: 'POST', url: '/api/setup/test-ai', payload: { ai: { custom: { baseUrl: otherLlm.openaiUrl } } } });
      expect(otherLlm.requests.length).toBeGreaterThan(0);
      for (const r of otherLlm.requests) expect(JSON.stringify(r.headers)).not.toContain('sk-preset');
      // the preset key is used for its own server, an entered key anywhere
      h.llm.clearRequests();
      await h.inject({ method: 'POST', url: '/api/setup/models', payload: { ai: { custom: { apiKey: SECRET_MASK } } } });
      expect(h.llm.requests[0].headers.authorization).toBe('Bearer sk-preset');
      otherLlm.clearRequests();
      await h.inject({ method: 'POST', url: '/api/setup/models', payload: { ai: { custom: { baseUrl: otherLlm.openaiUrl, apiKey: 'sk-other' } } } });
      expect(otherLlm.requests[0].headers.authorization).toBe('Bearer sk-other');
      expect(h.ctx.repos.users.count()).toBe(0);
    } finally {
      await otherPaperless.close();
      await otherLlm.close();
    }
  });

  it('validates the user input', async () => {
    const short = await h.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', password: 'short', config: setupConfig() } });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/at least 8 characters/);
    const noUser = await h.inject({ method: 'POST', url: '/api/setup', payload: { password: 'long enough password', config: setupConfig() } });
    expect(noUser.statusCode).toBe(400);
    const badConfig = await h.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'admin', password: 'long enough password', config: { ai: { provider: 'gemini' } } },
    });
    expect(badConfig.statusCode).toBe(400);
    expect(badConfig.json().error).toBe('Invalid input');
  });

  it('refuses to save when a connection test fails', async () => {
    const pl = await h.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'admin', password: 'long enough password', config: setupConfig({ paperless: { url: h.paperless.url, token: 'wrong' } }) },
    });
    expect(pl.statusCode).toBe(400);
    expect(pl.json()).toMatchObject({ step: 'paperless' });

    h.llm.reply({ status: 401, error: { error: { message: 'Invalid API key' } } });
    const ai = await h.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', password: 'long enough password', config: setupConfig() } });
    expect(ai.statusCode).toBe(400);
    expect(ai.json()).toMatchObject({ step: 'ai', canForce: true });
    expect(ai.json().error).toContain('Invalid API key');
    h.llm.reply('OK');
    expect(h.ctx.repos.users.count()).toBe(0);
    expect(h.ctx.cfg.setupCompleted).toBe(false);
  });

  it('completes the setup, creates the user and logs in', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', password: 'long enough password', config: setupConfig() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
    expect(c).toBeDefined();
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    cookie = `${SESSION_COOKIE}=${c!.value}`;

    expect(h.ctx.repos.users.count()).toBe(1);
    expect(h.ctx.cfg.setupCompleted).toBe(true);
    expect(h.ctx.isConfigured()).toBe(true);
    // the Paperless URL is stored without the /api suffix (used for document links)
    expect(h.ctx.cfg.paperless.url).toBe(h.paperless.url);
    expect(h.ctx.documentLink(7)).toBe(`${h.paperless.url}/documents/7/details`);
    expect(h.ctx.cfg.ai.custom.apiKey).toBe('sk-setup');
    const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'config.json'), 'utf8'));
    expect(saved.setupCompleted).toBe(true);
    expect(saved.ai.provider).toBe('custom');

    const session = await h.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, setupRequired: false, needsUser: false, user: { username: 'admin' } });
    const dash = await h.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    expect(dash.statusCode).toBe(200);
    expect(dash.json().paperless).toMatchObject({ connected: true, apiVersion: 10 });
  });

  it('cannot run the setup a second time', async () => {
    const payload = { username: 'evil', password: 'long enough password', config: setupConfig() };
    const anonymous = await h.inject({ method: 'POST', url: '/api/setup', payload });
    expect(anonymous.statusCode).toBe(401);
    const loggedIn = await h.inject({ method: 'POST', url: '/api/setup', payload, headers: { cookie } });
    expect(loggedIn.statusCode).toBe(409);
    expect(h.ctx.repos.users.count()).toBe(1);
    // setup helper endpoints need authentication now as well – and API keys are not enough
    expect((await h.inject({ method: 'POST', url: '/api/setup/models', payload: { ai: {} } })).statusCode).toBe(401);
    for (const [url, payload] of [
      ['/api/setup/test-paperless', { url: h.paperless.url, token: '' }],
      ['/api/setup/test-ai', { ai: {} }],
      ['/api/setup/models', { ai: {} }],
      ['/api/setup/defaults', undefined],
    ] as const) {
      const res = await h.inject({ method: payload ? 'POST' : 'GET', url, payload, headers: h.apiKeyHeaders() });
      expect(res.statusCode, url).toBe(403);
    }
  });
});
