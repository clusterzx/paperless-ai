/**
 * Permission matrix: every route is called with every kind of caller, and the answer must match
 * the route policy (src/server/http/policy.ts). See docs/standalone/access-control.md §11.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { policyFor } from '../../src/server/http/policy.js';
import { hashPassword, issueSession, SESSION_COOKIE } from '../../src/server/auth.js';
import type { ApiScope } from '../../src/server/access/scope.js';

let h: Harness;
let memberCookie: string;
const keys: Partial<Record<ApiScope | 'all', string>> = {};

/** Streams and routes that never answer quickly. */
// Streams stay open; signing out an app revokes the key of the request (test/integration/appToken.test.ts).
const SKIP = new Set(['GET /api/logs/stream', 'GET /api/events', 'DELETE /api/auth/token']);

beforeAll(async () => {
  h = await createHarness();
  h.paperless.addDocument({ id: 1, title: 'Doc', content: 'Some content for the tests' });
  const memberId = h.ctx.repos.users.create('member', await hashPassword('member password 1'), 'member');
  memberCookie = `${SESSION_COOKIE}=${await issueSession(h.ctx, h.ctx.repos.users.byId(memberId)!)}`;
  const adminId = h.ctx.repos.users.create('keyadmin', await hashPassword('admin password 1'), 'admin');
  for (const scope of ['read', 'write', 'chat', 'upload', 'webhook', 'admin'] as const) {
    keys[scope] = h.ctx.repos.apiKeys.create(adminId, { name: scope, scopes: [scope] }).key;
  }
});
afterAll(() => h.close());

function routes() {
  return h.app.registeredRoutes.filter(
    (r) => !['HEAD', 'OPTIONS'].includes(r.method) && r.auth !== 'public' && r.auth !== 'setup' && (r.url.startsWith('/api/') || r.url.startsWith('/chat/')) && !SKIP.has(`${r.method} ${r.url}`),
  );
}

function concrete(url: string): string {
  return url.replace(/:file\b/g, 'x.ics').replace(/:[a-zA-Z]+/g, '1');
}

async function call(method: string, url: string, headers: Record<string, string>) {
  const res = await h.inject({ method: method as 'GET', url: concrete(url), headers, ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }) });
  let code: string | undefined;
  try {
    code = res.json().code;
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, code };
}

const policyDenied = (r: { status: number; code?: string }) => r.status === 403 && (r.code === 'admin_required' || r.code === 'scope_missing');

describe('permission matrix', () => {
  it('registers the routes it checks', () => {
    expect(routes().length).toBeGreaterThan(60);
  });

  it('members get exactly the non-admin routes', async () => {
    const wrong: string[] = [];
    for (const r of routes()) {
      const res = await call(r.method, r.url, { cookie: memberCookie });
      const policy = policyFor(r.method, r.url);
      if (policy.admin !== policyDenied(res)) wrong.push(`${r.method} ${r.url} → ${res.status} ${res.code ?? ''} (admin: ${policy.admin})`);
    }
    expect(wrong).toEqual([]);
  });

  it('API keys get only the routes of their scopes, never session routes', async () => {
    const wrong: string[] = [];
    for (const scope of ['read', 'write', 'chat', 'upload', 'webhook'] as const) {
      for (const r of routes()) {
        const res = await call(r.method, r.url, { 'x-api-key': keys[scope]! });
        const policy = policyFor(r.method, r.url);
        if (r.auth === 'session') {
          if (res.status !== 403) wrong.push(`[${scope}] ${r.method} ${r.url} is a session route but answered ${res.status}`);
          continue;
        }
        const allowed = !policy.admin && (policy.scope === null || policy.scope === scope);
        if (allowed === policyDenied(res)) wrong.push(`[${scope}] ${r.method} ${r.url} → ${res.status} ${res.code ?? ''} (needs ${policy.admin ? 'admin' : policy.scope})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('admin API keys reach the admin routes; the legacy key acts as admin', async () => {
    for (const r of routes().filter((x) => policyFor(x.method, x.url).admin && x.auth !== 'session')) {
      expect(policyDenied(await call(r.method, r.url, { 'x-api-key': keys.admin! })), `${r.method} ${r.url}`).toBe(false);
      expect(policyDenied(await call(r.method, r.url, h.apiKeyHeaders())), `${r.method} ${r.url}`).toBe(false);
    }
  });

  it('keeps the sensitive areas admin-only', () => {
    for (const [method, url] of [
      ['GET', '/api/settings'],
      ['PUT', '/api/settings'],
      ['GET', '/api/users'],
      ['POST', '/api/groups'],
      ['GET', '/api/logs'],
      ['POST', '/api/prompts'],
      ['PUT', '/api/prompt-rules'],
      ['POST', '/api/reset-all-documents'],
      ['POST', '/api/rag/rebuild'],
      ['GET', '/api/usage'],
    ]) {
      expect(policyFor(method, url).admin, `${method} ${url}`).toBe(true);
    }
  });
});
