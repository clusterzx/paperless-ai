/**
 * Libraries, users and intake channels together: which library a file goes to, who may send it
 * there, what happens to watch folders and mail accounts of deleted libraries, and the guards that
 * keep a watch folder away from the data of the instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, makeTempDir, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { UploadResult } from '../../src/shared/api.js';
import { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { watchFolderProblem } from '../../src/server/archive/folder.js';

let h: Harness;
let cookie: string;
let adminId: number;

beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
  adminId = h.ctx.repos.users.byUsername('admin')!.id;
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;
const pdf = (text: string) => makePdf([[text]]);

function multipart(files: { name: string; data: Buffer }[], fields: Record<string, string> = {}) {
  const boundary = `----b${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/pdf\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(data: Buffer, fields: Record<string, string> = {}, headers: Record<string, string> = { cookie }) {
  const m = multipart([{ name: 'doc.pdf', data }], { skipAnalysis: 'true', ...fields });
  return h.inject({ method: 'POST', url: '/api/documents/upload', headers: { ...headers, 'content-type': m.contentType }, payload: m.payload });
}
const stored = async (res: Awaited<ReturnType<typeof upload>>) => {
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: UploadResult[] }).results[0];
};
const libraryOf = (documentId: number) => local().row(documentId)!.library_id;

async function createLibrary(name: string, headers: Record<string, string> = { cookie }): Promise<number> {
  const res = await h.inject({ method: 'POST', url: '/api/libraries', headers, payload: { name } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { id: number }).id;
}
function member(name: string, scopes: string[] = ['read', 'write', 'upload'], libraryIds: number[] | null = null) {
  const id = h.ctx.repos.users.create(name, 'x', 'member');
  return { id, headers: { 'x-api-key': h.ctx.repos.apiKeys.create(id, { name: 'k', scopes: scopes as never, libraryIds }).key } };
}
const setMembers = (lib: number, members: { type: 'user' | 'group'; id: number; role: string }[]) =>
  h.inject({ method: 'PUT', url: `/api/libraries/${lib}/members`, headers: { cookie }, payload: { members } });

describe('watch folder guards', () => {
  it('refuses the data directory, the file storage, the program and system directories', () => {
    const data = makeTempDir('pai-data-');
    const storage = path.join(data, 'library');
    const list = [data, storage];
    expect(watchFolderProblem(data, list)).toMatch(/uses itself/);
    expect(watchFolderProblem(path.join(storage, 'ab'), list)).toMatch(/inside/);
    expect(watchFolderProblem(path.dirname(data), list)).toMatch(/contains/);
    expect(watchFolderProblem('/', list)).toMatch(/root/);
    expect(watchFolderProblem('/etc/scans', list)).toMatch(/system directory/);
    expect(watchFolderProblem('consume', list)).toMatch(/absolute/);
    expect(watchFolderProblem('/app', list, ['/app'])).toMatch(/program/);
    expect(watchFolderProblem('/app/consume', list, ['/app'])).toBeNull();
    expect(watchFolderProblem(makeTempDir('pai-consume-'), list)).toBeNull();
  });

  it('is checked in the settings, for library folders and before every poll', async () => {
    const bad = await h.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { config: { archive: { builtin: { consumeDir: h.dataDir } } } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Watch folder/);
    const lib = local().ensureDefaultLibrary();
    const libFolder = await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/folders`, headers: { cookie }, payload: { path: path.join(h.dataDir, 'library') } });
    expect(libFolder.statusCode).toBe(400);

    // Set without the settings page (e.g. an environment variable): the watcher refuses to touch it.
    h.ctx.config.update({ archive: { builtin: { consumeDir: h.dataDir } } });
    fs.writeFileSync(path.join(h.dataDir, 'important.pdf'), pdf('must stay'));
    const watcher = local().folders;
    await watcher.poll();
    await watcher.poll();
    expect(fs.existsSync(path.join(h.dataDir, 'important.pdf'))).toBe(true);
    expect(watcher.lastError).toMatch(/uses itself/);
  });

  it('takes a file in a nested watch folder once, for the inner folder', async () => {
    const main = makeTempDir('pai-consume-');
    const inner = path.join(main, 'family');
    fs.mkdirSync(inner);
    const family = await createLibrary('Family');
    expect((await h.inject({ method: 'POST', url: `/api/libraries/${family}/intake/folders`, headers: { cookie }, payload: { path: inner } })).statusCode).toBe(200);
    h.ctx.config.update({ archive: { builtin: { consumeDir: main } } });
    fs.writeFileSync(path.join(inner, 'scan.pdf'), pdf('nested scan'));
    const watcher = local().folders;
    await watcher.poll();
    expect(await watcher.poll()).toBe(1);
    const docs = h.ctx.db.prepare('SELECT id, library_id FROM lib_documents').all() as { id: number; library_id: number }[];
    expect(docs).toHaveLength(1);
    expect(docs[0].library_id).toBe(family);
    // no tag "family" from the main folder
    expect(h.ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_document_tags').get()).toEqual({ c: 0 });
  });
});

describe('watch folders and libraries', () => {
  it('stores a library folder into its library, also when the admin who set it up is no member', async () => {
    const anna = member('anna');
    const annas = await createLibrary('Anna', anna.headers);
    // The admin is no member of Anna's library, but may point a watch folder at it.
    expect(h.ctx.repos.libraries.rolesFor(adminId).has(annas)).toBe(false);
    const dir = makeTempDir('pai-anna-');
    const add = await h.inject({ method: 'POST', url: `/api/libraries/${annas}/intake/folders`, headers: { cookie }, payload: { path: `${dir}/` } });
    expect(add.statusCode, add.body).toBe(200);
    expect((h.ctx.db.prepare('SELECT path FROM intake_folders').get() as { path: string }).path).toBe(dir);
    fs.writeFileSync(path.join(dir, 'letter.pdf'), pdf('letter for anna'));
    await local().folders.poll();
    expect(await local().folders.poll()).toBe(1);
    const doc = h.ctx.db.prepare('SELECT id, library_id FROM lib_documents').get() as { id: number; library_id: number };
    expect(doc.library_id).toBe(annas);
  });

  it('uses the library of the main folder and "library" subfolders', async () => {
    const family = await createLibrary('Family');
    const office = await createLibrary('Office');
    const dir = makeTempDir('pai-consume-');
    h.ctx.config.update({ archive: { builtin: { consumeDir: dir, consumeLibrary: office, consumeSubfolders: 'library' } } });
    fs.mkdirSync(path.join(dir, 'family', 'Taxes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'family', 'Taxes', 'a.pdf'), pdf('taxes of the family'));
    fs.writeFileSync(path.join(dir, 'b.pdf'), pdf('office paper'));
    await local().folders.poll();
    expect(await local().folders.poll()).toBe(2);
    const rows = h.ctx.db.prepare('SELECT original_filename AS file, library_id FROM lib_documents ORDER BY original_filename').all() as { file: string; library_id: number }[];
    expect(rows).toEqual([
      { file: 'a.pdf', library_id: family },
      { file: 'b.pdf', library_id: office },
    ]);
    const meta = h.ctx.metadata(family);
    await meta.snapshot(true);
    expect(meta.current.tags.map((t) => t.name)).toEqual(['Taxes']);
  });
});

describe('deleted libraries', () => {
  it('stop their watch folders, mail accounts and workflows, and take no documents', async () => {
    const old = await createLibrary('Old');
    const dir = makeTempDir('pai-old-');
    await h.inject({ method: 'POST', url: `/api/libraries/${old}/intake/folders`, headers: { cookie }, payload: { path: dir } });
    h.ctx.db
      .prepare("INSERT INTO intake_mail_accounts (library_id, name, host, username, password_enc) VALUES (?, 'old', 'imap.example.com', 'old@example.com', 'x')")
      .run(old);
    h.ctx.db
      .prepare("INSERT INTO workflows (library_id, name, position, trigger_type, trigger, conditions, actions, created_at, updated_at) VALUES (?, 'wf', 0, 'added', '{}', '[]', '[]', 0, 0)")
      .run(old);
    expect((await h.inject({ method: 'DELETE', url: `/api/libraries/${old}`, headers: { cookie } })).statusCode).toBe(200);
    expect(h.ctx.db.prepare('SELECT COUNT(*) AS c FROM intake_folders').get()).toEqual({ c: 0 });
    expect(h.ctx.db.prepare('SELECT COUNT(*) AS c FROM intake_mail_accounts').get()).toEqual({ c: 0 });
    expect(h.ctx.db.prepare('SELECT enabled, suspended_reason FROM workflows').get()).toEqual({ enabled: 0, suspended_reason: 'The library was deleted' });

    // Nothing can move documents into it – not even unrestricted system tasks.
    const r = await stored(await upload(pdf('keep me visible')));
    await expect(local().updateDocument(SYSTEM_SCOPE, r.documentId!, { library_id: old }, { actor: 'system', ref: null })).rejects.toThrow(/cannot move/);
    expect(libraryOf(r.documentId!)).not.toBe(old);
  });
});

describe('the library of an upload', () => {
  it('is the oldest library, not the alphabetically first one', async () => {
    const first = local().ensureDefaultLibrary();
    await createLibrary('AAA comes first');
    const r = await stored(await upload(pdf('default target')));
    expect(libraryOf(r.documentId!)).toBe(first);
    expect(local().targetLibrary(SYSTEM_SCOPE)).toBe(first);
  });

  it('follows the default library of the user and the libraries of an API key', async () => {
    const family = await createLibrary('Family');
    const office = await createLibrary('Office');
    const setDefault = await h.inject({ method: 'PATCH', url: '/api/account/profile', headers: { cookie }, payload: { defaultLibraryId: office } });
    expect(setDefault.statusCode, setDefault.body).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/api/account', headers: { cookie } })).json().defaultLibraryId).toBe(office);
    expect(libraryOf((await stored(await upload(pdf('to the default')))).documentId!)).toBe(office);
    // by name
    expect(libraryOf((await stored(await upload(pdf('by name'), { library: 'family' }))).documentId!)).toBe(family);
    // a key limited to Family uploads there without being told
    const key = h.ctx.repos.apiKeys.create(adminId, { name: 'scanner', scopes: ['upload'], libraryIds: [family] }).key;
    expect(libraryOf((await stored(await upload(pdf('scanner key'), {}, { 'x-api-key': key }))).documentId!)).toBe(family);
    // a default the user cannot add to is refused
    const anna = member('anna');
    const annas = await createLibrary('Anna', anna.headers);
    expect((await h.inject({ method: 'PATCH', url: '/api/account/profile', headers: { cookie }, payload: { defaultLibraryId: annas } })).statusCode).toBe(400);
    // deleting the default library clears it
    const tmp = await createLibrary('Temp');
    await h.inject({ method: 'PATCH', url: '/api/account/profile', headers: { cookie }, payload: { defaultLibraryId: tmp } });
    await h.inject({ method: 'DELETE', url: `/api/libraries/${tmp}`, headers: { cookie } });
    expect(h.ctx.repos.users.byId(adminId)!.default_library_id).toBeNull();
  });

  it('shows a refused upload to its sender in the inbox, not to others', async () => {
    const anna = member('anna');
    const bob = member('bob');
    const annas = await createLibrary('Anna', anna.headers);
    const res = await stored(await upload(pdf('not for you'), { libraryId: String(annas) }, bob.headers));
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('You cannot add documents to this library'); // no name of a library bob cannot see
    const bobs = (await h.inject({ method: 'GET', url: '/api/intake', headers: bob.headers })).json() as { status: string; error: string }[];
    expect(bobs).toHaveLength(1);
    expect(bobs[0].status).toBe('rejected');
    expect((await h.inject({ method: 'GET', url: '/api/intake', headers: anna.headers })).json()).toEqual([]);
  });

  it('counts the Idempotency-Key per user', async () => {
    const anna = member('anna');
    await createLibrary('Anna', anna.headers);
    const a = await stored(await upload(pdf('admin file'), {}, { cookie, 'idempotency-key': 'scan-1' }));
    const b = await stored(await upload(pdf('anna file'), {}, { ...anna.headers, 'idempotency-key': 'scan-1' }));
    expect(b.documentId).not.toBe(a.documentId);
    expect(b.status).toBe('stored');
    // the same user again: the first result
    const again = await stored(await upload(pdf('admin file, sent twice'), {}, { cookie, 'idempotency-key': 'scan-1' }));
    expect(again.documentId).toBe(a.documentId);
  });

  it('keeps library names unique', async () => {
    await createLibrary('Family');
    expect((await h.inject({ method: 'POST', url: '/api/libraries', headers: { cookie }, payload: { name: 'family ' } })).statusCode).toBe(409);
    const other = await createLibrary('Office');
    expect((await h.inject({ method: 'PATCH', url: `/api/libraries/${other}`, headers: { cookie }, payload: { name: 'FAMILY' } })).statusCode).toBe(409);
  });
});

describe('WebDAV', () => {
  it('refuses a library folder the user can only read instead of filing it elsewhere', async () => {
    const anna = member('anna');
    const family = await createLibrary('Family');
    await setMembers(family, [
      { type: 'user', id: adminId, role: 'owner' },
      { type: 'user', id: anna.id, role: 'viewer' },
    ]);
    await createLibrary('Anna', anna.headers);
    const key = anna.headers['x-api-key'];
    const basic = { authorization: `Basic ${Buffer.from(`anna:${key}`).toString('base64')}`, 'content-type': 'application/pdf' };
    const refused = await h.inject({ method: 'PUT', url: '/dav/inbox/Family/Taxes/a.pdf', headers: basic, payload: pdf('read only') });
    expect(refused.statusCode).toBe(403);
    expect(h.ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents').get()).toEqual({ c: 0 });
    const ok = await h.inject({ method: 'PUT', url: '/dav/inbox/Anna/b.pdf', headers: basic, payload: pdf('own library') });
    expect(ok.statusCode).toBe(201);
  });
});

describe('retry', () => {
  it('is only for those who can see the attempt and keeps its hints', async () => {
    const r = await stored(await upload(pdf('retry me'), { tags: 'FromScanner' }));
    // make it a failed attempt whose file is kept
    h.ctx.db.prepare('DELETE FROM lib_documents WHERE id = ?').run(r.documentId);
    h.ctx.db.prepare("UPDATE lib_intake SET status = 'failed', document_id = NULL WHERE id = ?").run(r.intakeId);
    const bob = member('bob');
    await createLibrary('Bob', bob.headers);
    expect((await h.inject({ method: 'POST', url: `/api/intake/${r.intakeId}/retry`, headers: bob.headers })).statusCode).toBe(404);
    expect(h.ctx.db.prepare('SELECT status FROM lib_intake WHERE id = ?').get(r.intakeId)).toEqual({ status: 'failed' });
    const again = await h.inject({ method: 'POST', url: `/api/intake/${r.intakeId}/retry`, headers: { cookie } });
    expect(again.statusCode, again.body).toBe(200);
    const doc = again.json() as UploadResult;
    expect(doc.status).toBe('stored');
    const lib = libraryOf(doc.documentId!);
    const meta = h.ctx.metadata(lib);
    await meta.snapshot(true);
    const tags = (h.ctx.db.prepare('SELECT tag_id FROM lib_document_tags WHERE document_id = ?').all(doc.documentId) as { tag_id: number }[]).map((t) => meta.tagName(t.tag_id));
    expect(tags).toEqual(['FromScanner']);
  });
});

describe('administrators and owners', () => {
  it('needs the admin scope on API keys for administration', async () => {
    const lib = local().ensureDefaultLibrary();
    const docsKey = { 'x-api-key': h.ctx.repos.apiKeys.create(adminId, { name: 'docs', scopes: ['read', 'write'] }).key };
    const adminKey = { 'x-api-key': h.ctx.repos.apiKeys.create(adminId, { name: 'admin', scopes: ['read', 'write', 'admin'] }).key };
    const dir = makeTempDir('pai-key-');
    expect((await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/folders`, headers: docsKey, payload: { path: dir } })).statusCode).toBe(403);
    const anna = member('anna');
    const annas = await createLibrary('Anna', anna.headers);
    expect((await h.inject({ method: 'PUT', url: `/api/libraries/${annas}/members`, headers: docsKey, payload: { members: [{ type: 'user', id: adminId, role: 'owner' }] } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/folders`, headers: adminKey, payload: { path: dir } })).statusCode).toBe(200);
  });

  it('never leaves a library without an owner who can sign in', async () => {
    const anna = member('anna');
    const annas = await createLibrary('Anna', anna.headers);
    const del = await h.inject({ method: 'DELETE', url: `/api/users/${anna.id}`, headers: { cookie } });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toMatch(/only owner of “Anna”/);

    const empty = h.ctx.repos.groups.create('Nobody');
    expect((await setMembers(annas, [{ type: 'group', id: empty, role: 'owner' }])).statusCode).toBe(400);
    const family = h.ctx.repos.groups.create('Family');
    h.ctx.repos.groups.setMembers(family, [anna.id]);
    expect((await setMembers(annas, [{ type: 'group', id: family, role: 'owner' }])).statusCode).toBe(200);
    const delGroup = await h.inject({ method: 'DELETE', url: `/api/groups/${family}`, headers: { cookie } });
    expect(delGroup.statusCode).toBe(400);
    // with another owner both can go
    expect((await setMembers(annas, [{ type: 'group', id: family, role: 'owner' }, { type: 'user', id: adminId, role: 'owner' }])).statusCode).toBe(200);
    expect((await h.inject({ method: 'DELETE', url: `/api/groups/${family}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'DELETE', url: `/api/users/${anna.id}`, headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('interrupted intake', () => {
  it('counts attempts cut off by a restart as failed, so they are tried again', async () => {
    const id = Number(h.ctx.db.prepare("INSERT INTO lib_intake (channel, channel_ref, filename, status, created_at) VALUES ('mail', 'acc:INBOX:1:5:0', 'a.pdf', 'pending', ?)").run(Date.now()).lastInsertRowid);
    local().ingestService.recoverInterrupted();
    expect(h.ctx.db.prepare('SELECT status, error FROM lib_intake WHERE id = ?').get(id)).toEqual({ status: 'failed', error: 'Interrupted by a restart' });
    // The same reference is stored on the next attempt instead of being answered from the dead one.
    const res = await local().ingest(SYSTEM_SCOPE, { data: pdf('after the restart'), filename: 'a.pdf' }, 'mail', { channelRef: 'acc:INBOX:1:5:0', skipAnalysis: true });
    expect(res.status).toBe('stored');
  });
});

describe('watch folder problems', () => {
  it('takes files that are readable but not writable, and shows why a folder does nothing', async () => {
    const lib = local().ensureDefaultLibrary();
    // A folder that is not there (e.g. the host folder is not mounted) – shown with the folder.
    const missing = path.join(makeTempDir('pai-gone-'), 'not-mounted');
    expect((await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/folders`, headers: { cookie }, payload: { path: missing } })).statusCode).toBe(200);
    const folders = (await h.inject({ method: 'GET', url: `/api/libraries/${lib}/intake/folders`, headers: { cookie } })).json() as { path: string; problem: string | null }[];
    expect(folders[0].problem).toMatch(/does not exist in the container/);

    // A file copied by another user (read-only for Paperless-AI) is taken all the same.
    const dir = makeTempDir('pai-readonly-');
    expect((await h.inject({ method: 'POST', url: `/api/libraries/${lib}/intake/folders`, headers: { cookie }, payload: { path: dir } })).statusCode).toBe(200);
    const file = path.join(dir, 'scan.pdf');
    fs.writeFileSync(file, pdf('read only scan'));
    fs.chmodSync(file, 0o444);
    await local().folders.poll();
    expect(await local().folders.poll()).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
