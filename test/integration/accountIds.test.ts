/**
 * Ids of deleted accounts are never handed out again: a session (or anything else still bound to
 * the id) of a deleted account must not become one of the next account.
 */
import { afterEach, expect, it } from 'vitest';
import { hashPassword, issueSession, SESSION_COOKIE } from '../../src/server/auth.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

it('does not let the session of a deleted account sign in as the next one', async () => {
  h = await createHarness();
  const admin = await h.login();
  const malloryId = h.ctx.repos.users.create('mallory', await hashPassword('mallory password 1'), 'member');
  const old = `${SESSION_COOKIE}=${await issueSession(h.ctx, h.ctx.repos.users.byId(malloryId)!)}`;
  expect((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: old } })).json().authenticated).toBe(true);

  expect((await h.inject({ method: 'DELETE', url: `/api/users/${malloryId}`, headers: { cookie: admin } })).statusCode).toBe(200);
  const created = await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username: 'bob', password: 'bob password 123', role: 'admin' } });
  expect(created.statusCode, created.body).toBe(200);
  const bob = h.ctx.repos.users.byUsername('bob')!;
  expect(bob.id).toBeGreaterThan(malloryId);
  expect((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: old } })).json().authenticated).toBe(false);

  // Even with the same id (an account restored from a backup …): the session names its own account.
  h.ctx.db.prepare('UPDATE users SET id = ? WHERE id = ?').run(malloryId, bob.id);
  expect(h.ctx.repos.users.byId(malloryId)!.username).toBe('bob');
  expect((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: old } })).json().authenticated).toBe(false);
});
