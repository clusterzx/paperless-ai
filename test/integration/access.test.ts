import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import type { ApiKeyInfo, GroupInfo, UserInfo } from '../../src/shared/api.js';

let h: Harness;
let admin: string;

beforeEach(async () => {
  h = await createHarness();
  admin = await h.login();
});
afterEach(() => h.close());

const json = <T>(res: { json: () => unknown }) => res.json() as T;

async function loginAs(username: string, password: string): Promise<string> {
  const res = await h.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  expect(res.statusCode, res.body).toBe(200);
  const c = res.cookies.find((x) => x.name === 'paperless_ai_session')!;
  return `paperless_ai_session=${c.value}`;
}

describe('user management', () => {
  it('creates members who cannot administrate', async () => {
    const created = await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'erika', password: 'erika password 1', displayName: 'Erika' } });
    expect(created.statusCode, created.body).toBe(200);
    expect(json<UserInfo>(created)).toMatchObject({ username: 'erika', role: 'member', displayName: 'Erika', disabled: false, password: true });

    const member = await loginAs('erika', 'erika password 1');
    const session = await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: member } });
    expect(session.json().user).toMatchObject({ username: 'erika', role: 'member' });
    expect((await h.inject({ method: 'GET', url: '/api/settings', headers: { cookie: member } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'GET', url: '/api/users', headers: { cookie: member } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { cookie: member } })).statusCode).toBe(200);
  });

  it('changes roles at once and protects the last administrator', async () => {
    const list = json<UserInfo[]>(await h.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } }));
    const me = list.find((u) => u.username === 'admin')!;
    expect(me.role).toBe('admin');
    const demote = await h.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: { cookie: admin }, payload: { role: 'member' } });
    expect(demote.statusCode).toBe(400);
    expect(demote.json().error).toMatch(/last administrator/);
    expect((await h.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: { cookie: admin }, payload: { disabled: true } })).statusCode).toBe(400);
    expect((await h.inject({ method: 'DELETE', url: `/api/users/${me.id}`, headers: { cookie: admin } })).statusCode).toBe(400);

    const other = json<UserInfo>(await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'max', password: 'max password 12' } }));
    const cookie = await loginAs('max', 'max password 12');
    expect((await h.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).statusCode).toBe(403);
    await h.inject({ method: 'PATCH', url: `/api/users/${other.id}`, headers: { cookie: admin }, payload: { role: 'admin' } });
    // the same session, the new role
    expect((await h.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).statusCode).toBe(200);
    // now two admins: one may step down
    expect((await h.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: { cookie: admin }, payload: { role: 'member' } })).statusCode).toBe(200);
  });

  it('disabled accounts cannot sign in and lose their sessions', async () => {
    const u = json<UserInfo>(await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'temp', password: 'temp password 1' } }));
    const cookie = await loginAs('temp', 'temp password 1');
    await h.inject({ method: 'PATCH', url: `/api/users/${u.id}`, headers: { cookie: admin }, payload: { disabled: true } });
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { cookie } })).statusCode).toBe(401);
    const login = await h.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'temp', password: 'temp password 1' } });
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('account_disabled');
  });

  it('writes the audit log', async () => {
    await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'audited', password: 'audit password 1' } });
    const log = await h.inject({ method: 'GET', url: '/api/audit-log', headers: { cookie: admin } });
    expect(log.json()[0]).toMatchObject({ action: 'user.created', actor: 'admin', target: expect.stringMatching(/^user:\d+$/) });
  });
});

describe('groups', () => {
  it('creates groups with members and keeps SSO groups read-only', async () => {
    const u = json<UserInfo>(await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'kid', password: 'kid password 12' } }));
    const g = json<GroupInfo>(await h.inject({ method: 'POST', url: '/api/groups', headers: { cookie: admin }, payload: { name: 'Family', members: [u.id] } }));
    expect(g).toMatchObject({ name: 'Family', sso: false, members: [u.id] });
    const users = json<UserInfo[]>(await h.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } }));
    expect(users.find((x) => x.id === u.id)!.groups).toEqual([{ id: g.id, name: 'Family' }]);
    expect((await h.inject({ method: 'POST', url: '/api/groups', headers: { cookie: admin }, payload: { name: 'family' } })).statusCode).toBe(400);

    h.ctx.repos.groups.syncOidc(u.id, ['sso-team']);
    const sso = json<GroupInfo[]>(await h.inject({ method: 'GET', url: '/api/groups', headers: { cookie: admin } })).find((x) => x.name === 'sso-team')!;
    expect(sso).toMatchObject({ sso: true, members: [u.id] });
    expect((await h.inject({ method: 'PATCH', url: `/api/groups/${sso.id}`, headers: { cookie: admin }, payload: { name: 'renamed' } })).statusCode).toBe(400);
    // leaving the group at the provider removes the membership; manual groups stay
    h.ctx.repos.groups.syncOidc(u.id, []);
    expect(h.ctx.repos.groups.groupsOf(u.id).map((x) => x.name)).toEqual(['Family']);
  });
});

describe('personal API keys', () => {
  it('creates, uses and revokes keys with scopes', async () => {
    const created = await h.inject({ method: 'POST', url: '/api/me/api-keys', headers: { cookie: admin }, payload: { name: 'scanner', scopes: ['read', 'upload'] } });
    expect(created.statusCode, created.body).toBe(200);
    const { key, info } = created.json() as { key: string; info: ApiKeyInfo };
    expect(key).toMatch(/^pai_[a-z0-9]{8}_/);
    expect(info).toMatchObject({ name: 'scanner', scopes: ['read', 'upload'], revoked: false });

    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': key } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { authorization: `Token ${key}` } })).statusCode).toBe(200);
    // no write scope
    const write = await h.inject({ method: 'POST', url: '/api/history/revert', headers: { 'x-api-key': key }, payload: { documentIds: [1] } });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe('scope_missing');
    // keys never reach session routes, even of their own user
    expect((await h.inject({ method: 'GET', url: '/api/me/api-keys', headers: { 'x-api-key': key } })).statusCode).toBe(403);

    const listed = json<ApiKeyInfo[]>(await h.inject({ method: 'GET', url: '/api/me/api-keys', headers: { cookie: admin } }));
    expect(listed[0].lastUsedAt).toBeGreaterThan(0);
    expect((await h.inject({ method: 'DELETE', url: `/api/me/api-keys/${info.id}`, headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': key } })).statusCode).toBe(401);
    // a tampered key is rejected
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': `${key.slice(0, -2)}xx` } })).statusCode).toBe(401);
  });

  it('members cannot create admin keys, and keys of disabled users stop working', async () => {
    const u = json<UserInfo>(await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'm', password: 'member password 1' } }));
    const cookie = await loginAs('m', 'member password 1');
    expect((await h.inject({ method: 'POST', url: '/api/me/api-keys', headers: { cookie }, payload: { name: 'x', scopes: ['admin'] } })).statusCode).toBe(400);
    const { key } = (await h.inject({ method: 'POST', url: '/api/me/api-keys', headers: { cookie }, payload: { name: 'x', scopes: ['read'] } })).json() as { key: string };
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': key } })).statusCode).toBe(200);
    // a member key never reaches admin routes, whatever scopes it has
    expect((await h.inject({ method: 'GET', url: '/api/users', headers: { 'x-api-key': key } })).statusCode).toBe(403);
    await h.inject({ method: 'PATCH', url: `/api/users/${u.id}`, headers: { cookie: admin }, payload: { disabled: true } });
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': key } })).statusCode).toBe(401);
  });

  it('admins see and revoke all keys; expired keys stop working', async () => {
    const id = h.ctx.repos.users.create('other', 'x', 'member');
    const { id: keyId, key } = h.ctx.repos.apiKeys.create(id, { name: 'k', scopes: ['read'], expiresAt: Date.now() + 60_000 });
    const all = json<ApiKeyInfo[]>(await h.inject({ method: 'GET', url: '/api/api-keys', headers: { cookie: admin } }));
    expect(all.find((k) => k.id === keyId)?.user).toEqual({ id, username: 'other' });
    expect((await h.inject({ method: 'DELETE', url: `/api/api-keys/${keyId}`, headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': key } })).statusCode).toBe(401);
    const expired = h.ctx.repos.apiKeys.create(id, { name: 'old', scopes: ['read'], expiresAt: Date.now() - 1 });
    expect((await h.inject({ method: 'GET', url: '/api/documents', headers: { 'x-api-key': expired.key } })).statusCode).toBe(401);
  });

  it('keeps the legacy global key working as an admin key', async () => {
    expect((await h.inject({ method: 'GET', url: '/api/users', headers: h.apiKeyHeaders() })).statusCode).toBe(200);
  });
});

describe('calendar feed per user', () => {
  it('gives every user an own link', async () => {
    await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'cal', password: 'calendar pass 1' } });
    const member = await loginAs('cal', 'calendar pass 1');
    const a = (await h.inject({ method: 'GET', url: '/api/calendar/feed', headers: { cookie: admin } })).json().path;
    const b = (await h.inject({ method: 'GET', url: '/api/calendar/feed', headers: { cookie: member } })).json().path;
    expect(a).not.toBe(b);
    expect((await h.inject({ method: 'GET', url: a })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: b })).statusCode).toBe(200);
  });

  it('keeps the global link of earlier versions for the first admin', async () => {
    h.ctx.repos.kv.set('calendar.feedToken', 'legacy-token-123456');
    expect((await h.inject({ method: 'GET', url: '/api/calendar/feed/legacy-token-123456.ics' })).statusCode).toBe(200);
    const path = (await h.inject({ method: 'GET', url: '/api/calendar/feed', headers: { cookie: admin } })).json().path;
    expect(path).toBe('/api/calendar/feed/legacy-token-123456.ics');
  });
});
