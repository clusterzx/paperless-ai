import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import type { AccountInfo, SessionInfo, UserInfo } from '../../src/shared/api.js';
import { sniffAvatar } from '../../src/server/access/avatar.js';

let h: Harness;
let admin: string;
let adminId: number;

beforeEach(async () => {
  h = await createHarness();
  admin = await h.login();
  adminId = h.ctx.repos.users.byUsername('admin')!.id;
});
afterEach(() => h.close());

function multipart(data: Buffer, type = 'image/png', filename = 'me.png') {
  const boundary = `----b${Math.random().toString(36).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const png = (width = 600, height = 400) => sharp({ create: { width, height, channels: 3, background: '#3366cc' } }).png().toBuffer();

async function upload(url: string, cookie: string, data: Buffer, type?: string, filename?: string) {
  const m = multipart(data, type, filename);
  return h.inject({ method: 'PUT', url, payload: m.payload, headers: { cookie, ...m.headers } });
}

async function createMember(username = 'erika') {
  const res = await h.inject({ method: 'POST', url: '/api/users', headers: { cookie: admin }, payload: { username, password: `${username} password 1` } });
  const login = await h.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: `${username} password 1` } });
  const c = login.cookies.find((x) => x.name === 'paperless_ai_session')!;
  return { user: res.json() as UserInfo, cookie: `paperless_ai_session=${c.value}` };
}

describe('profile pictures', () => {
  it('stores the own picture as a 256×256 WebP and serves it with caching headers', async () => {
    const put = await upload('/api/account/avatar', admin, await png());
    expect(put.statusCode, put.body).toBe(200);
    const { avatarUrl } = put.json() as { avatarUrl: string };
    expect(avatarUrl).toMatch(new RegExp(`^/api/users/${adminId}/avatar\\?v=\\d+$`));

    const res = await h.inject({ method: 'GET', url: avatarUrl, headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('immutable');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });

    // Without the current version: revalidate with the ETag.
    const own = await h.inject({ method: 'GET', url: '/api/account/avatar', headers: { cookie: admin } });
    expect(own.headers['cache-control']).toBe('private, no-cache');
    const again = await h.inject({ method: 'GET', url: '/api/account/avatar', headers: { cookie: admin, 'if-none-match': own.headers.etag as string } });
    expect(again.statusCode).toBe(304);

    // The address is in the session, the account and the user list.
    expect((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: admin } })).json<SessionInfo>().user?.avatarUrl).toBe(avatarUrl);
    expect((await h.inject({ method: 'GET', url: '/api/account', headers: { cookie: admin } })).json<AccountInfo>().user?.avatarUrl).toBe(avatarUrl);
    const list = (await h.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } })).json<UserInfo[]>();
    expect(list.find((u) => u.id === adminId)?.avatarUrl).toBe(avatarUrl);
  });

  it('gives a new picture a new address and removes it', async () => {
    const first = (await upload('/api/account/avatar', admin, await png())).json().avatarUrl as string;
    const second = (await upload('/api/account/avatar', admin, await png(300, 300))).json().avatarUrl as string;
    expect(second).not.toBe(first);
    // The old version is not served as immutable any more.
    expect((await h.inject({ method: 'GET', url: first, headers: { cookie: admin } })).headers['cache-control']).toBe('private, no-cache');

    expect((await h.inject({ method: 'DELETE', url: '/api/account/avatar', headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/account/avatar', headers: { cookie: admin } })).statusCode).toBe(404);
    expect((await h.inject({ method: 'GET', url: `/api/users/${adminId}/avatar`, headers: { cookie: admin } })).statusCode).toBe(404);
    expect((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: admin } })).json<SessionInfo>().user?.avatarUrl).toBeNull();
  });

  it('accepts only PNG, JPEG and WebP of at most 2 MB, by their content', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    const bad = await upload('/api/account/avatar', admin, svg, 'image/png', 'evil.png');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/PNG, JPEG or WebP/);

    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
    expect((await upload('/api/account/avatar', admin, gif, 'image/gif', 'a.gif')).statusCode).toBe(400);

    // A PNG signature with nothing readable behind it.
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
    expect((await upload('/api/account/avatar', admin, broken)).statusCode).toBe(400);

    const big = Buffer.concat([await png(), Buffer.alloc(2 * 1024 * 1024)]);
    const tooLarge = await upload('/api/account/avatar', admin, big);
    expect(tooLarge.statusCode).toBe(413);

    const jpeg = await sharp({ create: { width: 50, height: 80, channels: 3, background: '#c00' } }).jpeg().toBuffer();
    expect((await upload('/api/account/avatar', admin, jpeg, 'image/jpeg', 'a.jpg')).statusCode).toBe(200);
    const webp = await sharp({ create: { width: 50, height: 80, channels: 3, background: '#0c0' } }).webp().toBuffer();
    expect((await upload('/api/account/avatar', admin, webp, 'image/webp', 'a.webp')).statusCode).toBe(200);

    expect((await h.inject({ method: 'PUT', url: '/api/account/avatar', headers: { cookie: admin }, payload: { file: 'x' } })).statusCode).toBe(400);
  });

  it('lets admins set and remove the picture of any user, members only their own', async () => {
    const { user: erika, cookie } = await createMember();
    expect(erika.avatarUrl).toBeNull();

    const set = await upload(`/api/users/${erika.id}/avatar`, admin, await png());
    expect(set.statusCode, set.body).toBe(200);
    const url = set.json().avatarUrl as string;
    expect(url).toContain(`/api/users/${erika.id}/avatar`);
    // Members see the pictures of others, but cannot change them.
    expect((await h.inject({ method: 'GET', url, headers: { cookie } })).statusCode).toBe(200);
    expect((await upload(`/api/users/${adminId}/avatar`, cookie, await png())).statusCode).toBe(403);
    expect((await h.inject({ method: 'DELETE', url: `/api/users/${erika.id}/avatar`, headers: { cookie } })).statusCode).toBe(403);
    // … and their own.
    expect((await upload('/api/account/avatar', cookie, await png())).statusCode).toBe(200);

    expect((await h.inject({ method: 'DELETE', url: `/api/users/${erika.id}/avatar`, headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: `/api/users/${erika.id}/avatar`, headers: { cookie } })).statusCode).toBe(404);
    expect((await h.inject({ method: 'GET', url: '/api/users/9999/avatar', headers: { cookie } })).statusCode).toBe(404);

    const log = (await h.inject({ method: 'GET', url: '/api/audit-log', headers: { cookie: admin } })).json() as { action: string }[];
    expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['user.avatar_changed', 'user.avatar_removed']));
  });

  it('serves pictures to API keys with the read scope; only sessions change them', async () => {
    await upload('/api/account/avatar', admin, await png());
    const { user: erika } = await createMember();
    const read = h.ctx.repos.apiKeys.create(erika.id, { name: 'r', scopes: ['read'] }).key;
    const headers = { 'x-api-key': read };
    expect((await h.inject({ method: 'GET', url: `/api/users/${adminId}/avatar`, headers })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/account/avatar', headers })).statusCode).toBe(404);
    const m = multipart(await png());
    expect((await h.inject({ method: 'PUT', url: '/api/account/avatar', payload: m.payload, headers: { ...headers, ...m.headers } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'GET', url: `/api/users/${adminId}/avatar` })).statusCode).toBe(401);
  });

  it('removes the picture with the account', async () => {
    const { user: erika } = await createMember();
    await upload(`/api/users/${erika.id}/avatar`, admin, await png());
    expect((await h.inject({ method: 'DELETE', url: `/api/users/${erika.id}`, headers: { cookie: admin } })).statusCode).toBe(200);
    expect(h.ctx.db.prepare('SELECT COUNT(*) AS c FROM user_avatars WHERE user_id = ?').get(erika.id)).toEqual({ c: 0 });
  });
});

describe('sniffAvatar', () => {
  it('recognises the formats by their first bytes', async () => {
    expect(sniffAvatar(await png(4, 4))).toBe('image/png');
    expect(sniffAvatar(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniffAvatar(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).webp().toBuffer())).toBe('image/webp');
    expect(sniffAvatar(Buffer.from('<svg/>'))).toBeNull();
    expect(sniffAvatar(Buffer.alloc(0))).toBeNull();
  });
});
