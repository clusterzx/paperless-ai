import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '../../src/server/config/schema.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { startMockLlm, type MockLlm } from '../helpers/mockLlm.js';
import { startMockPaperless, type MockPaperless } from '../helpers/mockPaperless.js';

const STORED = ['sk-test-secret', 'sk-ant-test', 'azure-secret'];

let h: Harness;
let cookie: string;
let otherPaperless: MockPaperless;
let otherLlm: MockLlm;

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  otherPaperless = await startMockPaperless({ token: 'other-token' });
  otherLlm = await startMockLlm();
  h.ctx.config.update({ ai: { azure: { endpoint: h.llm.url, apiKey: 'azure-secret', deployment: 'gpt' } } });
});
afterAll(async () => {
  await h.close();
  await otherPaperless.close();
  await otherLlm.close();
});
beforeEach(() => {
  h.paperless.clearRequests();
  otherPaperless.clearRequests();
  h.llm.clearRequests();
  otherLlm.clearRequests();
});

const post = (url: string, payload: unknown) => h.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });
const put = (payload: unknown) => h.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: payload as object });
const sentTo = (server: { requests: { headers: unknown }[] }) => JSON.stringify(server.requests.map((r) => r.headers));

describe('connection tests of a logged-in user', () => {
  it('use the stored Paperless token for its own server only', async () => {
    for (const token of [SECRET_MASK, '', undefined]) {
      const other = await post('/api/settings/test-paperless', { url: otherPaperless.url, token });
      expect(other.json()).toMatchObject({ ok: false, message: expect.stringContaining('API token') });
    }
    expect(otherPaperless.requests).toHaveLength(0);

    // another path on the same server is still the same server
    const own = await post('/api/settings/test-paperless', { url: `${h.paperless.url}/api/`, token: SECRET_MASK });
    expect(own.json()).toMatchObject({ ok: true });
    // an entered token goes wherever it was entered for
    const entered = await post('/api/settings/test-paperless', { url: otherPaperless.url, token: 'other-token' });
    expect(entered.json()).toMatchObject({ ok: true });
    expect(sentTo(otherPaperless)).not.toContain(h.paperless.token);
  });

  it('use the stored AI keys for their own server only', async () => {
    const elsewhere = [
      { provider: 'custom', custom: { baseUrl: otherLlm.openaiUrl } },
      { provider: 'custom', custom: { baseUrl: otherLlm.openaiUrl, apiKey: SECRET_MASK } },
      { provider: 'anthropic', anthropic: { baseUrl: otherLlm.url } },
      { provider: 'azure', azure: { endpoint: otherLlm.url } },
    ];
    for (const ai of elsewhere) {
      await post('/api/settings/test-ai', { ai });
      await post('/api/settings/models', { ai });
    }
    expect(otherLlm.requests.length).toBeGreaterThan(0);
    for (const secret of STORED) expect(sentTo(otherLlm)).not.toContain(secret);

    const own = await post('/api/settings/test-ai', { ai: { provider: 'custom', custom: { apiKey: SECRET_MASK } } });
    expect(own.json()).toMatchObject({ ok: true });
    expect(h.llm.chatRequests()[0].headers.authorization).toBe('Bearer sk-test-secret');
    otherLlm.clearRequests();
    const entered = await post('/api/settings/models', { ai: { provider: 'custom', custom: { baseUrl: otherLlm.openaiUrl, apiKey: 'sk-other' } } });
    expect(entered.json()).toMatchObject({ models: expect.any(Array) });
    expect(otherLlm.requests[0].headers.authorization).toBe('Bearer sk-other');
  });
});

describe('saving the settings', () => {
  it('asks for the Paperless token again when the URL points to another server', async () => {
    for (const force of [false, true]) {
      const res = await put({ config: { paperless: { url: otherPaperless.url, token: SECRET_MASK } }, force });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('The Paperless URL points to another server – enter the API token again');
      expect(res.json().canForce).toBeUndefined();
    }
    expect(h.ctx.cfg.paperless.url).toBe(h.paperless.url);
    expect(otherPaperless.requests).toHaveLength(0);

    const samePath = await put({ config: { paperless: { url: `${h.paperless.url}/api/`, token: SECRET_MASK } } });
    expect(samePath.statusCode).toBe(200);

    const entered = await put({ config: { paperless: { url: otherPaperless.url, token: 'other-token' } } });
    expect(entered.statusCode).toBe(200);
    expect(h.ctx.cfg.paperless).toMatchObject({ url: otherPaperless.url, token: 'other-token' });
    expect(sentTo(otherPaperless)).not.toContain(h.paperless.token);
    const back = await put({ config: { paperless: { url: h.paperless.url, token: h.paperless.token } } });
    expect(back.statusCode).toBe(200);
  });

  it('asks for an AI key again when its endpoint points to another server', async () => {
    const changes = [
      [{ custom: { baseUrl: otherLlm.openaiUrl } }, 'The base URL of the custom provider points to another server – enter the API key again'],
      [{ anthropic: { baseUrl: otherLlm.url } }, 'The Anthropic base URL points to another server – enter the API key again'],
      [{ anthropic: { baseUrl: '' } }, 'The Anthropic base URL points to another server – enter the API key again'],
      [{ azure: { endpoint: otherLlm.url } }, 'The Azure endpoint points to another server – enter the API key again'],
    ] as const;
    for (const [ai, message] of changes) {
      const res = await put({ config: { ai }, force: true });
      expect(res.statusCode, message).toBe(400);
      expect(res.json().error).toBe(message);
    }
    expect(h.ctx.cfg.ai.custom.baseUrl).toBe(h.llm.openaiUrl);
    expect(h.ctx.cfg.ai.anthropic.baseUrl).toBe(h.llm.url);
    expect(otherLlm.requests).toHaveLength(0);

    // other settings of the same provider do not need the key again
    const model = await put({ config: { ai: { custom: { model: 'other-model', apiKey: SECRET_MASK } } } });
    expect(model.statusCode).toBe(200);

    const entered = await put({ config: { ai: { custom: { baseUrl: otherLlm.openaiUrl, apiKey: 'sk-other' } } } });
    expect(entered.statusCode).toBe(200);
    expect(h.ctx.cfg.ai.custom).toMatchObject({ baseUrl: otherLlm.openaiUrl, apiKey: 'sk-other' });
    for (const secret of STORED) expect(sentTo(otherLlm)).not.toContain(secret);

    // a provider without a key can move freely
    const cleared = await put({ config: { ai: { custom: { baseUrl: h.llm.openaiUrl, apiKey: '' } } } });
    expect(cleared.statusCode).toBe(200);
    expect(h.ctx.cfg.ai.custom).toMatchObject({ baseUrl: h.llm.openaiUrl, apiKey: '' });
    const moved = await put({ config: { ai: { custom: { baseUrl: otherLlm.openaiUrl } } } });
    expect(moved.statusCode).toBe(200);
  });
});

describe('a token preset by an environment variable', () => {
  it('stays with the server it was set for', async () => {
    const pinned = await createHarness({ env: { PAPERLESS_API_TOKEN: 'env-pinned-token' } });
    try {
      const session = await pinned.login();
      expect(pinned.ctx.config.lockedPaths['paperless.token']).toBe('PAPERLESS_API_TOKEN');
      const test = await pinned.inject({ method: 'POST', url: '/api/settings/test-paperless', headers: { cookie: session }, payload: { url: otherPaperless.url, token: '' } });
      expect(test.json()).toMatchObject({ ok: false });
      for (const token of [SECRET_MASK, 'anything']) {
        const res = await pinned.inject({
          method: 'PUT',
          url: '/api/settings',
          headers: { cookie: session },
          payload: { config: { paperless: { url: otherPaperless.url, token } }, force: true },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toBe('The Paperless URL points to another server, but the API token is set by PAPERLESS_API_TOKEN – set the URL in the environment as well');
      }
      expect(pinned.ctx.cfg.paperless.url).toBe(pinned.paperless.url);
      expect(otherPaperless.requests).toHaveLength(0);
    } finally {
      await pinned.close();
    }
  });
});

describe('the setup wizard', () => {
  it('does not save a preset key for another server', async () => {
    const fresh = await createHarness({ configured: false });
    try {
      fresh.ctx.config.update({ paperless: { url: fresh.paperless.url, token: fresh.paperless.token }, ai: { provider: 'custom', custom: { baseUrl: fresh.llm.openaiUrl, model: 'test-model', apiKey: 'sk-preset' } } });
      const res = await fresh.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'admin', password: 'long enough password', force: true, config: { ai: { custom: { baseUrl: otherLlm.openaiUrl } } } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('The base URL of the custom provider points to another server – enter the API key again');
      expect(fresh.ctx.repos.users.count()).toBe(0);
      expect(fresh.ctx.cfg.ai.custom.baseUrl).toBe(fresh.llm.openaiUrl);
      expect(fresh.ctx.cfg.setupCompleted).toBe(false);
    } finally {
      await fresh.close();
    }
  });
});
