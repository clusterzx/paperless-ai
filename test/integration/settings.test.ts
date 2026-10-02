import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SECRET_MASK } from '../../src/server/config/schema.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
});
afterAll(() => h.close());

const get = async () => (await h.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json();
const put = (payload: Record<string, unknown>) => h.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload });
const savedConfig = () => JSON.parse(fs.readFileSync(path.join(h.dataDir, 'config.json'), 'utf8'));

describe('settings', () => {
  it('returns the configuration with masked secrets', async () => {
    const body = await get();
    expect(body.config.paperless).toEqual({ url: h.paperless.url, token: SECRET_MASK, username: '', publicUrl: '' });
    expect(body.config.ai.custom).toEqual({ baseUrl: h.llm.openaiUrl, apiKey: SECRET_MASK, model: 'test-model', extraBody: '' });
    expect(body.config.ai.openai.apiKey).toBe('');
    expect(body.config.security).toMatchObject({ apiKey: SECRET_MASK, jwtSecret: SECRET_MASK });
    expect(body.locked).toEqual({});
    expect(body.defaults.systemPrompt).toContain('document analyzer');
    expect(typeof body.localEmbeddings).toBe('boolean');
    expect(JSON.stringify(body)).not.toContain(h.paperless.token);
    expect(JSON.stringify(body)).not.toContain(h.ctx.cfg.security.apiKey);
  });

  it('saves a round-tripped configuration without overwriting masked secrets', async () => {
    const { config } = await get();
    h.paperless.clearRequests();
    h.llm.clearRequests();
    config.processing.concurrency = 2;
    config.processing.scanInterval = '0 */2 * * *';
    config.rag.topK = 12;
    const res = await put({ config });
    expect(res.statusCode).toBe(200);
    expect(res.json().config.processing.concurrency).toBe(2);
    expect(res.json().config.paperless.token).toBe(SECRET_MASK);
    expect(res.json().warnings).toEqual([]);

    expect(h.ctx.cfg.processing).toMatchObject({ concurrency: 2, scanInterval: '0 */2 * * *' });
    expect(h.ctx.cfg.paperless.token).toBe(h.paperless.token);
    expect(h.ctx.cfg.ai.custom.apiKey).toBe('sk-test-secret');
    const saved = savedConfig();
    expect(saved.processing.concurrency).toBe(2);
    expect(saved.rag.topK).toBe(12);
    expect(saved.paperless.token).toBe(h.paperless.token);
    expect(saved.ai.custom.apiKey).toBe('sk-test-secret');
    expect(saved.security.apiKey).toBe(h.ctx.cfg.security.apiKey);
    // unchanged connections are not re-tested
    expect(h.paperless.requests).toHaveLength(0);
    expect(h.llm.requests).toHaveLength(0);
  });

  it('rejects an invalid scan interval', async () => {
    const res = await put({ config: { processing: { scanInterval: 'every five minutes' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid scan interval/);
    expect(h.ctx.cfg.processing.scanInterval).toBe('0 */2 * * *');
  });

  it('rejects invalid values with details', async () => {
    const res = await put({ config: { processing: { concurrency: 99 }, ai: { temperature: 'hot' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid input');
    expect(res.json().details.map((d: { path: string }) => d.path).sort()).toEqual(['ai.temperature', 'processing.concurrency']);
    expect(savedConfig().processing.concurrency).toBe(2);
  });

  it('never changes secrets or setup state through this endpoint', async () => {
    const before = { ...h.ctx.cfg.security };
    const res = await put({ config: { security: { apiKey: 'hacked', jwtSecret: 'hacked' }, setupCompleted: false } });
    expect(res.statusCode).toBe(200);
    expect(h.ctx.cfg.security).toEqual(before);
    expect(h.ctx.cfg.setupCompleted).toBe(true);
  });

  it('tests a changed Paperless connection before saving', async () => {
    const res = await put({ config: { paperless: { token: 'wrong-token' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ step: 'paperless', canForce: true });
    expect(h.ctx.cfg.paperless.token).toBe(h.paperless.token);
    // the URL is normalised (trailing /api removed): unchanged → no test needed
    h.paperless.clearRequests();
    const same = await put({ config: { paperless: { url: `${h.paperless.url}/api/` } } });
    expect(same.statusCode).toBe(200);
    expect(h.ctx.cfg.paperless.url).toBe(h.paperless.url);
    expect(h.paperless.requests).toHaveLength(0);
  });

  it('tests a changed AI configuration before saving', async () => {
    h.llm.reply({ status: 401, error: { error: { message: 'bad key' } } });
    const bad = await put({ config: { ai: { custom: { model: 'other-model' } } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ step: 'ai', canForce: true });
    expect(h.ctx.cfg.ai.custom.model).toBe('test-model');

    const forced = await put({ config: { ai: { custom: { model: 'forced-model' } } }, force: true });
    expect(forced.statusCode).toBe(200);
    expect(h.ctx.llm().model).toBe('forced-model');

    h.llm.reply('OK');
    h.llm.clearRequests();
    const ok = await put({ config: { ai: { custom: { model: 'other-model', apiKey: SECRET_MASK } } } });
    expect(ok.statusCode).toBe(200);
    // the stored key was used for the test and kept
    expect(h.llm.chatRequests()[0].headers.authorization).toBe('Bearer sk-test-secret');
    expect(h.ctx.cfg.ai.custom.apiKey).toBe('sk-test-secret');
    // the LLM client is rebuilt with the new model without a restart
    expect(h.ctx.llm().model).toBe('other-model');
  });

  it('creates configured custom fields in Paperless right away', async () => {
    const res = await put({ config: { processing: { customFields: [{ name: 'Total', type: 'monetary', currency: 'usd', description: 'Invoice total' }] } } });
    expect(res.statusCode).toBe(200);
    expect(h.paperless.customFieldByName('Total')).toMatchObject({ data_type: 'monetary', extra_data: { default_currency: 'USD' } });
    expect(h.ctx.cfg.processing.customFields).toEqual([{ name: 'Total', type: 'monetary', currency: 'USD', description: 'Invoice total' }]);
  });

  it('validates the external API JSON', async () => {
    const res = await put({ config: { externalApi: { enabled: true, url: 'http://x', headers: '{not json' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('External API headers must be valid JSON');
  });

  it('tests connections with stored secrets', async () => {
    const pl = await h.inject({
      method: 'POST',
      url: '/api/settings/test-paperless',
      headers: { cookie },
      payload: { url: h.paperless.url, token: SECRET_MASK },
    });
    expect(pl.json()).toMatchObject({ ok: true });
    const ai = await h.inject({ method: 'POST', url: '/api/settings/test-ai', headers: { cookie }, payload: { ai: { custom: { apiKey: SECRET_MASK } } } });
    expect(ai.json()).toMatchObject({ ok: true, details: { provider: 'custom', model: 'other-model' } });
    const models = await h.inject({ method: 'POST', url: '/api/settings/models', headers: { cookie }, payload: { ai: { provider: 'ollama' } } });
    expect(models.json()).toEqual({ models: ['llama3.2:latest', 'nomic-embed-text:latest'] });
  });

  it('tests the external API with a sandboxed transform', async () => {
    const res = await h.inject({
      method: 'POST',
      url: '/api/settings/test-external-api',
      headers: { cookie },
      payload: { externalApi: { url: `${h.llm.openaiUrl}/models`, method: 'GET', transform: 'return data.data.map((m) => m.id).join(", ")' } },
    });
    expect(res.json()).toEqual({ ok: true, message: 'External API responded successfully', details: { preview: 'test-model, other-model' } });
    const failing = await h.inject({
      method: 'POST',
      url: '/api/settings/test-external-api',
      headers: { cookie },
      payload: { externalApi: { url: `${h.llm.openaiUrl}/models`, transform: 'while (true) {}' } },
    });
    expect(failing.json().ok).toBe(false);
  });

  it('regenerates the API key', async () => {
    const old = h.ctx.cfg.security.apiKey;
    const res = await h.inject({ method: 'POST', url: '/api/settings/api-key/regenerate', headers: { cookie } });
    const { apiKey } = res.json();
    expect(apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(apiKey).not.toBe(old);
    expect((await h.inject({ method: 'GET', url: '/api/processing/status', headers: { 'x-api-key': old } })).statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/api/processing/status', headers: { 'x-api-key': apiKey } })).statusCode).toBe(200);
    expect(savedConfig().security.apiKey).toBe(apiKey);
  });
});

describe('settings locked by environment variables', () => {
  let env: Harness;
  let envCookie: string;
  beforeAll(async () => {
    env = await createHarness({ env: { API_KEY: 'env-api-key', SCAN_INTERVAL: '*/5 * * * *' } });
    envCookie = await env.login();
  });
  afterAll(() => env.close());

  it('reports locked paths and keeps the environment values', async () => {
    const body = (await env.inject({ method: 'GET', url: '/api/settings', headers: { cookie: envCookie } })).json();
    expect(body.locked).toEqual({ 'security.apiKey': 'API_KEY', 'processing.scanInterval': 'SCAN_INTERVAL' });
    expect(env.ctx.cfg.security.apiKey).toBe('env-api-key');
    await env.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: envCookie }, payload: { config: { processing: { scanInterval: '0 0 * * *' } } } });
    expect(env.ctx.cfg.processing.scanInterval).toBe('*/5 * * * *');
  });

  it('does not regenerate an API key set by the environment', async () => {
    const res = await env.inject({ method: 'POST', url: '/api/settings/api-key/regenerate', headers: { cookie: envCookie } });
    expect(res.statusCode).toBe(400);
    const legacy = await env.inject({ method: 'POST', url: '/api/key-regenerate', headers: { cookie: envCookie } });
    expect(legacy.statusCode).toBe(400);
    expect(env.ctx.cfg.security.apiKey).toBe('env-api-key');
    expect((await env.inject({ method: 'GET', url: '/api/processing/status', headers: { 'x-api-key': 'env-api-key' } })).statusCode).toBe(200);
  });
});
