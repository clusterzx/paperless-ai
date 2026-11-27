/**
 * Sign-in for native apps (#1046): password (and second factor) → a personal API key for the
 * device; signing out revokes it. Requests are sent as a native app sends them: no browser headers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PASSWORD, TEST_USER, type Harness } from '../helpers/appHarness.js';
import { hashPassword } from '../../src/server/auth.js';
import { hashRecoveryCode, newTotpSecret, timeStep, totpCode } from '../../src/server/totp.js';
import type { ApiKeyInfo } from '../../src/shared/api.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** As a native app: no X-Requested-With, Origin or Sec-Fetch-* headers. */
const app = (method: 'GET' | 'POST' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: object) =>
  h.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

describe('app sign-in', () => {
  it('gives a device key that works on the API and signs out by revoking it', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    h.ctx.repos.users.setProfile(h.ctx.repos.users.byUsername(TEST_USER)!.id, { displayName: 'Jane Doe' });

    const res = await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD, deviceName: 'Pixel 9' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { token: string; keyId: number; scopes: string[]; user: Record<string, unknown> };
    expect(body.token).toMatch(/^pai_/);
    expect(body.scopes).toEqual(['read', 'write', 'delete', 'metadata', 'upload', 'chat']);
    expect(body.user).toMatchObject({ username: TEST_USER, displayName: 'Jane Doe', role: 'admin' });
    const bearer = { authorization: `Bearer ${body.token}` };

    // The key works – also for changes, without browser headers – and shows the account.
    expect((await app('GET', '/api/documents', bearer)).statusCode).toBe(200);
    expect((await app('GET', '/api/session', bearer)).json().user).toMatchObject({ username: TEST_USER, displayName: 'Jane Doe' });
    expect((await app('POST', '/api/saved-views', bearer, { name: 'Vom Handy', filter: {} })).statusCode).toBe(200);
    // An app key never administers, even of an administrator.
    expect((await app('GET', '/api/logs', bearer)).statusCode).toBe(403);
    // The user sees it under Settings → API keys.
    const keys = (await h.inject({ method: 'GET', url: '/api/me/api-keys', headers: { cookie } })).json() as ApiKeyInfo[];
    expect(keys.find((k) => k.id === body.keyId)).toMatchObject({ name: 'App: Pixel 9' });

    // Signing out revokes it.
    expect((await app('DELETE', '/api/auth/token', bearer)).statusCode).toBe(200);
    expect((await app('GET', '/api/documents', bearer)).statusCode).toBe(401);
    // The browser signs out elsewhere.
    expect((await h.inject({ method: 'DELETE', url: '/api/auth/token', headers: { cookie } })).statusCode).toBe(400);
  });

  it('asks for fewer permissions when the app wants that, and any key can sign out', async () => {
    h = await createHarness({ archive: 'builtin' });
    await h.login();
    const res = await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD, deviceName: 'Scanner', scopes: ['upload'] });
    expect(res.json().scopes).toEqual(['upload']);
    const bearer = { authorization: `Bearer ${res.json().token}` };
    expect((await app('GET', '/api/documents', bearer)).statusCode).toBe(403);
    expect((await app('DELETE', '/api/auth/token', bearer)).statusCode).toBe(200);
    // Administration, MCP, webhooks: not for apps.
    expect((await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD, scopes: ['admin'] })).statusCode).toBe(400);
    expect((await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD, scopes: ['mcp'] })).statusCode).toBe(400);
  });

  it('refuses wrong passwords, disabled accounts and a switched-off password sign-in', async () => {
    h = await createHarness({ archive: 'builtin' });
    await h.login();
    expect((await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: 'wrong wrong wrong' })).statusCode).toBe(401);
    expect((await app('POST', '/api/auth/token', {}, { username: 'ghost', password: 'whatever123' })).statusCode).toBe(401);
    const id = h.ctx.repos.users.create('olga', await hashPassword('olga password 1'), 'member');
    h.ctx.repos.users.setDisabled(id, true);
    expect((await app('POST', '/api/auth/token', {}, { username: 'olga', password: 'olga password 1' })).json()).toMatchObject({ code: 'account_disabled' });
    expect(h.ctx.repos.apiKeys.list(id)).toHaveLength(0);

    h.ctx.config.update({ auth: { passwordLogin: false, oidc: { enabled: true, issuer: 'https://idp.example', clientId: 'paperless-ai' } } });
    const off = await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD });
    expect(off.statusCode).toBe(403);
    expect(off.json().code).toBe('password_login_disabled');
  });

  it('asks for the second factor – in one request or with the ticket', async () => {
    h = await createHarness({ archive: 'builtin' });
    await h.login();
    const user = h.ctx.repos.users.byUsername(TEST_USER)!;
    const secret = newTotpSecret();
    h.ctx.repos.users.setPendingTotp(user.id, secret);
    h.ctx.repos.users.enableTotp(user.id, timeStep() - 2, [await hashRecoveryCode('abcde-fghjk')]);
    const before = h.ctx.repos.apiKeys.list(user.id).length;

    // Without a code: a ticket, no key.
    const first = await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD, deviceName: 'iPhone' });
    expect(first.statusCode).toBe(200);
    const { twoFactor, ticket } = first.json() as { twoFactor: boolean; ticket: string };
    expect(twoFactor).toBe(true);
    expect(h.ctx.repos.apiKeys.list(user.id)).toHaveLength(before);
    // A wrong code: refused.
    expect((await app('POST', '/api/auth/token', {}, { ticket, code: '000000' })).statusCode).toBe(401);
    // The ticket and the code: the key.
    const second = await app('POST', '/api/auth/token', {}, { ticket, code: totpCode(secret, timeStep()), deviceName: 'iPhone' });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().token).toMatch(/^pai_/);
    // Or everything in one request (a recovery code works as well).
    const once = await app('POST', '/api/auth/token', {}, { username: TEST_USER, password: TEST_PASSWORD, code: 'abcde-fghjk', deviceName: 'iPad' });
    expect(once.statusCode, once.body).toBe(200);
    expect(h.ctx.repos.apiKeys.list(user.id).map((k) => k.name)).toEqual(expect.arrayContaining(['App: iPhone', 'App: iPad']));
    // An expired or forged ticket.
    expect((await app('POST', '/api/auth/token', {}, { ticket: 'nonsense', code: '123456' })).json().code).toBe('ticket_expired');
  });
});
