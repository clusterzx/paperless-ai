import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/server/auth.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ configured: false });
});
afterEach(() => h.close());

function setup(username: string, model = 'test-model') {
  return h.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      username,
      password: 'long enough password',
      config: {
        paperless: { url: h.paperless.url, token: h.paperless.token },
        ai: { provider: 'custom', custom: { baseUrl: h.llm.openaiUrl, model, apiKey: 'sk-setup' } },
      },
    },
  });
}

describe('setup requests at the same time', () => {
  it('creates one account and keeps the configuration that belongs to it', async () => {
    const [first, second] = await Promise.all([setup('first', 'test-model'), setup('second', 'other-model')]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const [won, lost] = first.statusCode === 200 ? [first, second] : [second, first];
    expect(lost.json()).toEqual({ error: 'Setup has already been completed' });
    expect(lost.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(won.cookies.find((c) => c.name === SESSION_COOKIE)).toBeDefined();

    const users = h.ctx.repos.users.list().map((u) => u.username);
    expect(users).toEqual([won === first ? 'first' : 'second']);
    expect(h.ctx.cfg.ai.custom.model).toBe(won === first ? 'test-model' : 'other-model');
    expect(h.ctx.cfg.setupCompleted).toBe(true);
  });

  it('answers the second request for the same username with 409', async () => {
    const results = await Promise.all([setup('admin'), setup('admin')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(h.ctx.repos.users.count()).toBe(1);
  });
});
