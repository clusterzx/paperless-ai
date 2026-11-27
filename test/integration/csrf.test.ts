/**
 * Cross-site request forgery: the session cookie also comes along with a form or a request another
 * page sends – SameSite=Lax keeps only other sites out, not another app on the same host (another
 * port) or a subdomain. Changes with the cookie need the header the pages of the app send.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';

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
});
