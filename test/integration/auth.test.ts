import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, issueSession } from '../../src/server/auth.js';
import { createHarness, TEST_PASSWORD, TEST_USER, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let cookie: string;
beforeAll(async () => {
  h = await createHarness();
  h.paperless.addDocument({ id: 1, title: 'Doc' });
  cookie = await h.login();
});
afterAll(() => h.close());

describe('authentication', () => {
  it('rejects API requests without credentials', async () => {
    for (const url of ['/api/dashboard', '/api/processing/status', '/api/history', '/api/rag/status', '/api/usage']) {
      const res = await h.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ error: 'Authentication required' });
    }
    expect((await h.inject({ method: 'POST', url: '/api/webhook/document', payload: { document_id: 1 } })).statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/chat/init/1' })).statusCode).toBe(401);
  });

  it('accepts the API key in the x-api-key header and as Bearer token', async () => {
    const viaHeader = await h.inject({ method: 'GET', url: '/api/dashboard', headers: h.apiKeyHeaders() });
    expect(viaHeader.statusCode).toBe(200);
    expect(viaHeader.json()).toMatchObject({ version: '4.0.0', paperless: { connected: true, documents: 1 }, ai: { provider: 'custom', model: 'test-model' } });
    const viaBearer = await h.inject({ method: 'GET', url: '/api/dashboard', headers: { authorization: `Bearer ${h.ctx.cfg.security.apiKey}` } });
    expect(viaBearer.statusCode).toBe(200);
    const wrong = await h.inject({ method: 'GET', url: '/api/dashboard', headers: { 'x-api-key': 'wrong' } });
    expect(wrong.statusCode).toBe(401);
  });

  it('accepts the session cookie and a session token as Bearer', async () => {
    expect((await h.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } })).statusCode).toBe(200);
    const token = cookie.split('=')[1];
    expect((await h.inject({ method: 'GET', url: '/api/dashboard', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    const forged = `${SESSION_COOKIE}=${token.slice(0, -4)}abcd`;
    expect((await h.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it('session-only endpoints reject the API key', async () => {
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['GET', '/api/settings/api-key'],
      ['POST', '/api/settings/api-key/regenerate'],
      ['POST', '/api/key-regenerate'],
      ['GET', '/api/account'],
    ] as const) {
      const res = await h.inject({ method, url, headers: h.apiKeyHeaders() });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error).toMatch(/logged-in user/);
    }
    const ok = await h.inject({ method: 'GET', url: '/api/settings/api-key', headers: { cookie } });
    expect(ok.json()).toEqual({ apiKey: h.ctx.cfg.security.apiKey });
  });

  it('reports the session state', async () => {
    const anon = await h.inject({ method: 'GET', url: '/api/session' });
    expect(anon.json()).toMatchObject({ authenticated: false, setupRequired: false });
    const user = await h.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    expect(user.json()).toMatchObject({ authenticated: true, user: { username: TEST_USER }, features: { rag: true } });
    const key = await h.inject({ method: 'GET', url: '/api/session', headers: h.apiKeyHeaders() });
    expect(key.json()).toMatchObject({ authenticated: true });
    expect(key.json().user).toBeUndefined();
  });

  it('rejects wrong credentials', async () => {
    const wrongPw = await h.inject({ method: 'POST', url: '/api/auth/login', payload: { username: TEST_USER, password: 'nope nope nope' } });
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongPw.cookies).toHaveLength(0);
    const unknown = await h.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'whatever123' } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrongPw.json());
    const caseInsensitive = await h.inject({ method: 'POST', url: '/api/auth/login', payload: { username: TEST_USER.toUpperCase(), password: TEST_PASSWORD } });
    expect(caseInsensitive.statusCode).toBe(200);
  });

  it('logout clears the cookie', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE);
    expect(cleared?.value).toBe('');
  });

  it('changing the password invalidates existing sessions', async () => {
    const second = await h.login('other', 'password-one');
    expect((await h.inject({ method: 'GET', url: '/api/account', headers: { cookie: second } })).statusCode).toBe(200);
    const change = await h.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: second },
      payload: { currentPassword: 'password-one', newPassword: 'password-two' },
    });
    expect(change.statusCode).toBe(200);
    const fresh = change.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect((await h.inject({ method: 'GET', url: '/api/account', headers: { cookie: second } })).statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/api/account', headers: { cookie: `${SESSION_COOKIE}=${fresh.value}` } })).statusCode).toBe(200);
    const wrongCurrent = await h.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie: `${SESSION_COOKIE}=${fresh.value}` },
      payload: { currentPassword: 'password-one', newPassword: 'password-three' },
    });
    expect(wrongCurrent.statusCode).toBe(400);
  });

  it('sessions of deleted users are rejected', async () => {
    const id = h.ctx.repos.users.create('temp', 'x');
    const token = await issueSession(h.ctx, h.ctx.repos.users.byId(id)!);
    expect((await h.inject({ method: 'GET', url: '/api/usage', headers: { cookie: `${SESSION_COOKIE}=${token}` } })).statusCode).toBe(200);
    h.ctx.repos.users.delete(id);
    expect((await h.inject({ method: 'GET', url: '/api/usage', headers: { cookie: `${SESSION_COOKIE}=${token}` } })).statusCode).toBe(401);
  });
});

describe('public routes and HTTP basics', () => {
  it('health check', async () => {
    const res = await h.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'healthy', version: '4.0.0' });
  });

  it('sets CORS headers and answers preflight requests', async () => {
    const res = await h.inject({ method: 'OPTIONS', url: '/api/dashboard', headers: { origin: 'chrome-extension://abc' } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(String(res.headers['access-control-allow-headers'])).toContain('x-api-key');
    const get = await h.inject({ method: 'GET', url: '/health' });
    expect(get.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/does-not-exist', headers: h.apiKeyHeaders() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('/api/does-not-exist');
  });

  it('validates request bodies', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/processing/documents', headers: h.apiKeyHeaders(), payload: { ids: [] } });
    expect(res.statusCode).toBe(400);
  });
});
