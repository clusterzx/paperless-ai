/**
 * Profile pictures (#1045): always stored as a 256×256 WebP made here (no EXIF, no SVG), visible to
 * signed-in users and keys with `read`, changed by the account itself or by administrators.
 */
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_USER, type Harness } from '../helpers/appHarness.js';
import { hashPassword, issueSession, SESSION_COOKIE } from '../../src/server/auth.js';
import type { AccountInfo, SessionInfo, UserInfo } from '../../src/shared/api.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

function multipart(data: Buffer, filename = 'me.png', type = 'image/png') {
  const b = '----avatar';
  return {
    payload: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${b}`,
  };
}

/** A photo with a GPS position in its EXIF data. */
const photo = () =>
  sharp({ create: { width: 800, height: 500, channels: 3, background: '#3366cc' } })
    .withExif({ IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1' } })
    .jpeg()
    .toBuffer();

describe('profile pictures', () => {
  it('stores the own picture as a 256×256 WebP without EXIF data and shows it to everyone signed in', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const me = h.ctx.repos.users.byUsername(TEST_USER)!;
    const input = await photo();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const m = multipart(input, 'photo.jpg', 'image/jpeg');
    const put = await h.inject({ method: 'PUT', url: '/api/account/avatar', headers: { cookie, 'content-type': m.contentType }, payload: m.payload });
    expect(put.statusCode, put.body).toBe(200);
    const { avatarUrl } = put.json() as { avatarUrl: string };
    expect(avatarUrl).toMatch(new RegExp(`^/api/users/${me.id}/avatar\\?v=[0-9a-f]{12}$`));

    const img = await h.inject({ method: 'GET', url: avatarUrl, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect(img.headers['content-security-policy']).toContain('sandbox');
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 256, height: 256 });
    expect(meta.exif).toBeUndefined();
    // Unchanged: 304.
    expect((await h.inject({ method: 'GET', url: avatarUrl, headers: { cookie, 'if-none-match': String(img.headers.etag) } })).statusCode).toBe(304);

    // Session, account and the user list name it.
    expect(((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json() as SessionInfo).user?.avatarUrl).toBe(avatarUrl);
    expect(((await h.inject({ method: 'GET', url: '/api/account', headers: { cookie } })).json() as AccountInfo).user?.avatarUrl).toBe(avatarUrl);
    expect(((await h.inject({ method: 'GET', url: '/api/users', headers: { cookie } })).json() as UserInfo[]).find((u) => u.id === me.id)?.avatarUrl).toBe(avatarUrl);

    // Another user (and a key with `read`) sees it.
    const otherId = h.ctx.repos.users.create('mia', await hashPassword('mia password 1'), 'member');
    const mia = `${SESSION_COOKIE}=${await issueSession(h.ctx, h.ctx.repos.users.byId(otherId)!)}`;
    expect((await h.inject({ method: 'GET', url: `/api/users/${me.id}/avatar`, headers: { cookie: mia } })).statusCode).toBe(200);
    const readKey = { 'x-api-key': h.ctx.repos.apiKeys.create(otherId, { name: 'r', scopes: ['read'] }).key };
    expect((await h.inject({ method: 'GET', url: `/api/users/${me.id}/avatar`, headers: readKey })).statusCode).toBe(200);
    // … but cannot change it.
    const m2 = multipart(await photo());
    expect((await h.inject({ method: 'PUT', url: `/api/users/${me.id}/avatar`, headers: { cookie: mia, 'content-type': m2.contentType }, payload: m2.payload })).statusCode).toBe(403);
    expect((await h.inject({ method: 'DELETE', url: `/api/users/${me.id}/avatar`, headers: { cookie: mia } })).statusCode).toBe(403);

    // Removed: 404 and no URL.
    expect((await h.inject({ method: 'DELETE', url: '/api/account/avatar', headers: { cookie } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: `/api/users/${me.id}/avatar`, headers: { cookie } })).statusCode).toBe(404);
    expect(((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json() as SessionInfo).user?.avatarUrl).toBeNull();
  });

  it('takes the picture as the body from apps with a key that may write', async () => {
    h = await createHarness({ archive: 'builtin' });
    await h.login();
    const me = h.ctx.repos.users.byUsername(TEST_USER)!;
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#ff000080' } }).png().toBuffer();
    const writer = { 'x-api-key': h.ctx.repos.apiKeys.create(me.id, { name: 'app', scopes: ['read', 'write'] }).key };
    const res = await h.app.inject({ method: 'PUT', url: '/api/account/avatar', headers: { ...writer, 'content-type': 'image/png' }, payload: png });
    expect(res.statusCode, res.body).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/account/avatar', headers: writer })).headers['content-type']).toBe('image/webp');
    const reader = { 'x-api-key': h.ctx.repos.apiKeys.create(me.id, { name: 'r', scopes: ['read'] }).key };
    expect((await h.app.inject({ method: 'PUT', url: '/api/account/avatar', headers: { ...reader, 'content-type': 'image/png' }, payload: png })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/account/avatar', headers: reader })).statusCode).toBe(403);
  });

  it('refuses SVG, other files, broken pictures and pictures above 2 MB', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const put = (data: Buffer, type: string) => {
      const m = multipart(data, 'x', type);
      return h.inject({ method: 'PUT', url: '/api/account/avatar', headers: { cookie, 'content-type': m.contentType }, payload: m.payload });
    };
    expect((await put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).statusCode).toBe(415);
    expect((await put(Buffer.from('%PDF-1.7 not a picture'), 'image/png')).statusCode).toBe(415);
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    expect((await put(broken, 'image/png')).statusCode).toBe(422);
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024 + 10)]);
    expect((await put(huge, 'image/jpeg')).statusCode).toBe(413);
    expect(h.ctx.repos.users.avatar(h.ctx.repos.users.byUsername(TEST_USER)!.id)).toBeUndefined();
  });

  it('lets administrators set and remove the picture of others – only from the signed-in browser', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const otherId = h.ctx.repos.users.create('olga', await hashPassword('olga password 1'), 'member');
    const m = multipart(await photo());
    const set = await h.inject({ method: 'PUT', url: `/api/users/${otherId}/avatar`, headers: { cookie, 'content-type': m.contentType }, payload: m.payload });
    expect(set.statusCode, set.body).toBe(200);
    expect(h.ctx.repos.audit.list({}).some((e: { action: string }) => e.action === 'user.avatar_changed')).toBe(true);
    // An admin key does not change accounts.
    const adminKey = { 'x-api-key': h.ctx.repos.apiKeys.create(h.ctx.repos.users.byUsername(TEST_USER)!.id, { name: 'a', scopes: ['admin', 'read', 'write'] }).key };
    expect((await h.app.inject({ method: 'DELETE', url: `/api/users/${otherId}/avatar`, headers: adminKey })).statusCode).toBe(403);
    expect((await h.inject({ method: 'DELETE', url: `/api/users/${otherId}/avatar`, headers: { cookie } })).statusCode).toBe(200);
    expect(h.ctx.repos.users.avatar(otherId)).toBeUndefined();
    // Deleting an account deletes its picture.
    const m2 = multipart(await photo());
    await h.inject({ method: 'PUT', url: `/api/users/${otherId}/avatar`, headers: { cookie, 'content-type': m2.contentType }, payload: m2.payload });
    await h.inject({ method: 'DELETE', url: `/api/users/${otherId}`, headers: { cookie } });
    expect(h.ctx.db.prepare('SELECT COUNT(*) AS c FROM user_avatars WHERE user_id = ?').get(otherId)).toEqual({ c: 0 });
    expect((await h.inject({ method: 'GET', url: `/api/users/${otherId}/avatar`, headers: { cookie } })).statusCode).toBe(404);
  });
});
