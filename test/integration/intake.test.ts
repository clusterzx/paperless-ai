/**
 * More intake channels: the WebDAV inbox (scanners, file managers) and the share target of the
 * installed app.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';

let h: Harness;
let auth: Record<string, string>;
beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  await h.login();
  const admin = h.ctx.repos.users.byUsername('admin')!.id;
  const key = h.ctx.repos.apiKeys.create(admin, { name: 'scanner', scopes: ['upload'] }).key;
  auth = { authorization: `Basic ${Buffer.from(`scanner:${key}`).toString('base64')}` };
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;
const docs = () => h.ctx.db.prepare("SELECT id, library_id, original_filename FROM lib_documents WHERE source = 'webdav' ORDER BY id").all() as { id: number; library_id: number; original_filename: string }[];

describe('WebDAV inbox', () => {
  it('asks for credentials and describes itself', async () => {
    const options = await h.inject({ method: 'OPTIONS', url: '/dav/inbox/' });
    expect(options.headers.dav).toBe('1, 2');
    expect(String(options.headers.allow)).toContain('PROPFIND');
    const anonymous = await h.inject({ method: 'PROPFIND' as 'GET', url: '/dav/inbox/', headers: { depth: '1' } });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Basic realm=');
    // A key without the upload scope may not use the inbox.
    const admin = h.ctx.repos.users.byUsername('admin')!.id;
    const readKey = h.ctx.repos.apiKeys.create(admin, { name: 'read', scopes: ['read'] }).key;
    const read = await h.inject({ method: 'PROPFIND' as 'GET', url: '/dav/inbox/', headers: { depth: '0', authorization: `Basic ${Buffer.from(`x:${readKey}`).toString('base64')}` } });
    expect(read.statusCode).toBe(403);
  });

  it('stores files put into it – library and tags from the folders', async () => {
    const main = local().ensureDefaultLibrary();
    const family = h.ctx.repos.libraries.create('Familie', h.ctx.repos.users.byUsername('admin')!.id, {});
    const list = await h.inject({ method: 'PROPFIND' as 'GET', url: '/dav/inbox/', headers: { ...auth, depth: '1' } });
    expect(list.statusCode).toBe(207);
    expect(list.body).toContain('<D:collection/>');
    expect(list.body).toContain('/dav/inbox/Familie/');

    const pdf = makePdf([['Lohnsteuerbescheinigung 2024']]);
    const put = (url: string, body: Buffer, type = 'application/pdf') => h.inject({ method: 'PUT', url, headers: { ...auth, 'content-type': type }, payload: body });
    expect((await h.inject({ method: 'MKCOL' as 'GET', url: '/dav/inbox/Familie/Steuer', headers: auth })).statusCode).toBe(201);
    expect((await put('/dav/inbox/Familie/Steuer/2024/beleg.pdf', Buffer.alloc(0))).statusCode).toBe(201); // Windows: empty first
    expect((await put('/dav/inbox/Familie/Steuer/2024/beleg.pdf', pdf)).statusCode).toBe(201);
    expect((await put('/dav/inbox/Familie/Steuer/2024/._beleg.pdf', Buffer.from('apple double'))).statusCode).toBe(201);
    expect((await put('/dav/inbox/scan%20001.pdf', makePdf([['Ohne Ordner']]))).statusCode).toBe(201);
    expect((await put('/dav/inbox/data.json', Buffer.from('{"just": "data"}'), 'application/json')).statusCode).toBe(415);

    expect(docs().map((d) => [d.original_filename, d.library_id])).toEqual([
      ['beleg.pdf', family],
      ['scan 001.pdf', main],
    ]);
    const meta = h.ctx.metadata(family);
    await meta.snapshot(true);
    const doc = await h.ctx.backend().getDocument(docs()[0].id);
    expect(doc.tags.map((t) => meta.tagName(t)).sort()).toEqual(['2024', 'Steuer']);

    // Right after the upload the file can be found (clients check that), otherwise the inbox is empty.
    const check = await h.inject({ method: 'PROPFIND' as 'GET', url: '/dav/inbox/Familie/Steuer/2024/beleg.pdf', headers: { ...auth, depth: '0' } });
    expect(check.statusCode).toBe(207);
    expect(check.body).toContain(`<D:getcontentlength>${pdf.length}</D:getcontentlength>`);
    const lock = await h.inject({ method: 'LOCK' as 'GET', url: '/dav/inbox/x.pdf', headers: auth });
    expect(lock.headers['lock-token']).toMatch(/^<opaquelocktoken:/);
  });
});

describe('share target (installed app)', () => {
  function multipart(files: { name: string; data: Buffer }[]) {
    const b = '----share';
    const parts: Buffer[] = [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nShared\r\n`)];
    for (const f of files) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/pdf\r\n\r\n`), f.data, Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${b}--\r\n`));
    return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
  }

  it('stores shared files and goes to the inbox – or to the sign-in page', async () => {
    const cookie = await h.login();
    const m = multipart([{ name: 'shared.pdf', data: makePdf([['Geteiltes Dokument']]) }]);
    const res = await h.inject({ method: 'POST', url: '/share-target', headers: { cookie, 'content-type': m.contentType }, payload: m.payload });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/inbox?shared=1&of=1');
    expect((h.ctx.db.prepare("SELECT COUNT(*) AS c FROM lib_documents WHERE source = 'share'").get() as { c: number }).c).toBe(1);

    const anonymous = await h.inject({ method: 'POST', url: '/share-target', headers: { 'content-type': m.contentType }, payload: m.payload });
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe('/login');
  });

  it('serves the manifest of the installable app with the share target', async () => {
    const fs = await import('node:fs');
    const manifest = JSON.parse(fs.readFileSync('src/web/public/manifest.webmanifest', 'utf8')) as { share_target: { action: string; params: { files: { name: string }[] } } };
    expect(manifest.share_target.action).toBe('/share-target');
    expect(manifest.share_target.params.files[0].name).toBe('file');
  });
});
