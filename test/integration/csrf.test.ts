/**
 * Cross-site request forgery: the session cookie also comes along with a form or a request another
 * page sends – SameSite=Lax keeps only other sites out, not another app on the same host (another
 * port) or a subdomain. Changes with the cookie need the header the pages of the app send.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, makeTempDir, TEST_PASSWORD, TEST_USER, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let cookie: string;
beforeAll(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
});
afterAll(() => h.close());

/** A request as the browser sends it for another page: without the header of the app. */
const forged = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, extra: { headers?: Record<string, string>; payload?: string } = {}) =>
  h.app.inject({ method, url, headers: { cookie, ...extra.headers }, payload: extra.payload });

describe('cross-site request forgery', () => {
  it('refuses changes with the session cookie that another page sends', async () => {
    const key = h.ctx.cfg.security.apiKey;
    // A plain HTML form (no script) of an app on another port of the same host …
    const purge = await forged('POST', '/ngx/api/trash/', { headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://192.168.1.10:8080' }, payload: 'action=empty' });
    expect(purge.statusCode).toBe(403);
    // … a text/plain request to a route without a body …
    const regenerate = await forged('POST', '/api/settings/api-key/regenerate', { headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(regenerate.statusCode).toBe(403);
    expect(regenerate.json().code).toBe('cross_site');
    expect(h.ctx.cfg.security.apiKey).toBe(key);
    // … and a browser that says so itself.
    const sameSite = await forged('POST', '/api/processing/pause', { headers: { 'sec-fetch-site': 'same-site', 'x-requested-with': 'Paperless-AI' } });
    expect(sameSite.statusCode).toBe(403);
  });

  it('lets the pages of the app, keys and reading through', async () => {
    expect((await h.inject({ method: 'POST', url: '/api/processing/pause', headers: { cookie, 'sec-fetch-site': 'same-origin' } })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/api/processing/resume', headers: h.apiKeyHeaders() })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).statusCode).toBe(200);
  });

  it('keeps signing in to the own page: no CORS, no requests from other sites', async () => {
    const login = { username: TEST_USER, password: TEST_PASSWORD };
    const preflight = await h.app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const foreign = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, payload: login });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.cookies).toHaveLength(0);
    const own = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'sec-fetch-site': 'same-origin' }, payload: login });
    expect(own.statusCode).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBeUndefined();
    // The API itself stays open to other origins with an API key.
    expect((await h.app.inject({ method: 'GET', url: '/api/documents', headers: h.apiKeyHeaders() })).headers['access-control-allow-origin']).toBe('*');
  });
});

describe('pages of the web UI', () => {
  it('carry the content security policy, also /index.html itself', async () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Paperless-AI</title>');
    const ui = await createHarness({ staticDir: dir });
    try {
      for (const url of ['/', '/documents', '/index.html']) {
        const res = await ui.app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(String(res.headers['content-security-policy']), url).toContain("frame-ancestors 'self'");
      }
    } finally {
      await ui.close();
    }
  });
});
