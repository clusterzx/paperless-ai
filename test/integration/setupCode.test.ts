/**
 * Credentials configured before the first account (environment variables, data/.env): whoever reaches
 * the setup first must not become the administrator who gets them. The setup asks for the code from
 * the log (data/setup-code) – an installation without such credentials needs none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { announceSetupCode } from '../../src/server/setupCode.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const account = { username: 'owner', password: 'Owner-Password-123', config: {}, force: true };

describe('setup code', () => {
  it('keeps a stranger from claiming an instance whose Paperless-ngx token was configured before', async () => {
    h = await createHarness({ config: { setupCompleted: true } });
    expect(h.ctx.cfg.paperless.token).not.toBe('');
    announceSetupCode(h.ctx);
    const file = path.join(h.ctx.dataDir, 'setup-code');
    const code = fs.readFileSync(file, 'utf8').trim();
    expect(code).toMatch(/^[A-Z2-9]{12}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const session = (await h.inject({ method: 'GET', url: '/api/session' })).json();
    expect(session).toMatchObject({ needsUser: true, setupCode: true });
    // Every setup endpoint, without the code or with a wrong one.
    for (const [method, url, payload] of [
      ['GET', '/api/setup/defaults', undefined],
      ['POST', '/api/setup/test-paperless', { url: h.ctx.cfg.paperless.url, token: '' }],
      ['POST', '/api/setup/test-ai', { ai: {} }],
      ['POST', '/api/setup/models', { ai: {} }],
      ['POST', '/api/setup', account],
    ] as const) {
      for (const headers of [{}, { 'x-setup-code': 'AAAA-BBBB-CCCC' }]) {
        const res = await h.inject({ method, url, headers, payload, remoteAddress: '203.0.113.7' });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().code).toBe('setup_code_required');
      }
    }
    expect(h.ctx.repos.users.count()).toBe(0);

    // The owner reads the code from the log (dashes and case do not matter).
    const pretty = code.toLowerCase().match(/.{4}/g)!.join('-');
    const res = await h.inject({ method: 'POST', url: '/api/setup', headers: { 'x-setup-code': pretty }, payload: account });
    expect(res.statusCode, res.body).toBe(200);
    expect(h.ctx.repos.users.byUsername('owner')?.role).toBe('admin');
    expect(fs.existsSync(file)).toBe(false);
    // Closed for everyone else from now on.
    const again = await h.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-setup-code': code },
      payload: { ...account, username: 'second' },
    });
    expect(again.statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/api/session' })).json().setupCode).toBe(false);
  });

  it('asks for no code when there is nothing to protect yet', async () => {
    h = await createHarness({
      config: {
        paperless: { url: '', token: '' },
        ai: { provider: 'ollama', custom: { apiKey: '' }, anthropic: { apiKey: '' } },
      },
    });
    expect((await h.inject({ method: 'GET', url: '/api/session' })).json().setupCode).toBe(false);
    expect((await h.inject({ method: 'GET', url: '/api/setup/defaults' })).statusCode).toBe(200);
    announceSetupCode(h.ctx);
    expect(fs.existsSync(path.join(h.ctx.dataDir, 'setup-code'))).toBe(false);
  });

  it('asks for the code before the first account comes from single sign-on', async () => {
    h = await createHarness({
      config: { setupCompleted: true, auth: { oidc: { enabled: true, issuer: 'http://127.0.0.1:9/realms/x', clientId: 'pai' } } },
    });
    const res = await h.inject({ method: 'GET', url: '/api/auth/oidc/login?next=/setup' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/setup\?sso_error=.*setup%20code/);
  });
});
