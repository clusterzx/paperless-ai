/**
 * The built-in archive through the HTTP API: intake, processing, versions, change log, trash,
 * libraries and roles, watch folder, maintenance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, makeTempDir, waitFor, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { ActivityItem, DashboardData, DocumentDetail, DocumentListResponse, ProcessingStatus, UploadResult } from '../../src/shared/api.js';
import { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';

let h: Harness;
let cookie: string;

beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  cookie = await h.login();
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;

function multipart(files: { name: string; data: Buffer; type?: string }[], fields: Record<string, string> = {}) {
  const boundary = `----b${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/pdf'}\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function upload(files: { name: string; data: Buffer; type?: string }[], fields: Record<string, string> = {}, headers: Record<string, string> = { cookie }) {
  const m = multipart(files, fields);
  const res = await h.inject({ method: 'POST', url: '/api/documents/upload', headers: { ...headers, 'content-type': m.contentType }, payload: m.payload });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: UploadResult[] }).results;
}

const invoice = makePdf([['Rechnung Nr. 4711', 'Stadtwerke München', 'Stromverbrauch März 2024', 'Betrag: 84,20 EUR']]);

describe('intake', () => {
  it('stores an upload with its text layer, analyses it and logs every step', async () => {
    h.llm.reply(analysisJson({ title: 'Stromrechnung März 2024', correspondent: 'Stadtwerke München', tags: ['Rechnung'], document_date: '2024-03-31' }));
    const [r] = await upload([{ name: 'scan.pdf', data: invoice }], { tags: 'Inbox' });
    expect(r).toMatchObject({ filename: 'scan.pdf', status: 'stored' });
    const id = r.documentId!;
    await h.engine.drain();

    const doc = (await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.title).toBe('Stromrechnung März 2024');
    expect(doc.content).toContain('Stromverbrauch März 2024');
    expect(doc.created).toBe('2024-03-31');
    expect(doc.page_count).toBe(1);
    expect(doc.url).toBe(`/documents/${id}`);
    const meta = h.ctx.metadata(doc.library_id!);
    await meta.snapshot(true);
    expect(doc.tags.map((t) => meta.tagName(t)).sort()).toEqual(['Inbox', 'Rechnung']);
    expect(meta.correspondentName(doc.correspondent)).toBe('Stadtwerke München');

    const activity = (await h.inject({ method: 'GET', url: `/api/documents/${id}/activity`, headers: { cookie } })).json() as ActivityItem[];
    expect(activity.map((a) => a.kind)).toEqual(['ai', 'created']);

    const file = await h.inject({ method: 'GET', url: `/api/documents/${id}/file`, headers: { cookie } });
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(file.rawPayload).equals(invoice)).toBe(true);
    const thumb = await h.inject({ method: 'GET', url: `/api/documents/${id}/thumb`, headers: { cookie } });
    expect(thumb.statusCode).toBe(200);
  });

  it('finds documents by full text and metadata, with snippets', async () => {
    h.llm.reply(analysisJson({ title: 'Stromrechnung' }));
    await upload([{ name: 'a.pdf', data: invoice }]);
    await upload([{ name: 'b.pdf', data: makePdf([['Mietvertrag Leopoldstraße', 'Kaltmiete 900 EUR']]) }]);
    await h.engine.drain();
    const res = (await h.inject({ method: 'GET', url: '/api/documents?q=Stromverbrauch&limit=10', headers: { cookie } })).json() as DocumentListResponse;
    expect(res.results).toHaveLength(1);
    expect(res.results[0].snippet).toContain('<mark>Stromverbrauch</mark>');
    // stemmed prefix search: "Mieten" finds "Miete"
    expect(((await h.inject({ method: 'GET', url: '/api/documents?q=Kaltmieten&limit=10', headers: { cookie } })).json() as DocumentListResponse).results).toHaveLength(1);
  });

  it('refuses duplicates and unsupported files, and honours Idempotency-Key', async () => {
    const [first] = await upload([{ name: 'scan.pdf', data: invoice }], { skipAnalysis: 'true' });
    const [dup] = await upload([{ name: 'copy.pdf', data: invoice }], { skipAnalysis: 'true' });
    expect(dup).toMatchObject({ status: 'duplicate', documentId: first.documentId });
    const [txt] = await upload([{ name: 'evil.html', data: Buffer.from('<script>alert(1)</script>'), type: 'text/html' }]);
    expect(txt.status).toBe('rejected');
    expect(txt.reason).toMatch(/not supported/);

    const other = makePdf([['Anderes Dokument']]);
    const once = await upload([{ name: 'x.pdf', data: other }], { skipAnalysis: 'true' }, { cookie, 'idempotency-key': 'abc-1' });
    const again = await upload([{ name: 'x.pdf', data: other }], { skipAnalysis: 'true' }, { cookie, 'idempotency-key': 'abc-1' });
    expect(again[0]).toMatchObject({ status: 'stored', documentId: once[0].documentId, intakeId: once[0].intakeId });
    await h.engine.drain();
    expect(h.ctx.repos.documents.get(first.documentId!)?.reason).toBe('Not analysed (intake option)');

    const intake = (await h.inject({ method: 'GET', url: '/api/intake', headers: { cookie } })).json() as { status: string }[];
    expect(intake.map((i) => i.status)).toEqual(['stored', 'rejected', 'duplicate', 'stored']);
  });

  it('reads images with OCR and keeps the text', async () => {
    h.ocrEngine.text = 'Lohnsteuerbescheinigung 2023 Finanzamt Musterstadt Arbeitgeber';
    h.llm.reply(analysisJson({ title: 'Lohnsteuerbescheinigung 2023' }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const [r] = await upload([{ name: 'photo.png', data: png, type: 'image/png' }]);
    await h.engine.drain();
    const doc = (await h.inject({ method: 'GET', url: `/api/documents/${r.documentId}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.content).toContain('Lohnsteuerbescheinigung 2023');
    expect(doc.title).toBe('Lohnsteuerbescheinigung 2023');
    expect(doc.mime_type).toBe('image/png');
  });

  it('accepts uploads of apps made for Paperless-ngx (post_document)', async () => {
    const admin = h.ctx.repos.users.byUsername('admin')!;
    const { key } = h.ctx.repos.apiKeys.create(admin.id, { name: 'scanner', scopes: ['upload'] });
    const boundary = '----ngx';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nScanned via app\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="app.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      makePdf([['From the app']]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await h.inject({
      method: 'POST',
      url: '/api/documents/post_document/',
      headers: { authorization: `Token ${key}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(typeof res.json()).toBe('string');
    const list = (await h.inject({ method: 'GET', url: '/api/documents?limit=10', headers: { cookie } })).json() as DocumentListResponse;
    expect(list.results.map((d) => d.title)).toContain('Scanned via app');
  });
});

describe('versions, change log and trash', () => {
  it('adds versions, switches between them and compares their text', async () => {
    const [r] = await upload([{ name: 'v1.pdf', data: makePdf([['Vertrag Version eins', 'Laufzeit 12 Monate']]) }], { skipAnalysis: 'true' });
    const id = r.documentId!;
    const m = multipart([{ name: 'v2.pdf', data: makePdf([['Vertrag Version zwei', 'Laufzeit 24 Monate']]) }], { comment: 'signed' });
    const v2 = await h.inject({ method: 'POST', url: `/api/documents/${id}/versions`, headers: { cookie, 'content-type': m.contentType }, payload: m.payload });
    expect(v2.statusCode, v2.body).toBe(200);
    await h.engine.drain();
    let doc = (await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.current_version).toBe(2);
    expect(doc.content).toContain('24 Monate');
    const versions = (await h.inject({ method: 'GET', url: `/api/documents/${id}/versions`, headers: { cookie } })).json() as { version: number; current: boolean; comment: string }[];
    expect(versions.map((v) => [v.version, v.current, v.comment])).toEqual([
      [2, true, 'signed'],
      [1, false, ''],
    ]);
    const diff = (await h.inject({ method: 'GET', url: `/api/documents/${id}/text/diff?from=1&to=2`, headers: { cookie } })).json() as { lines: { type: string; text: string }[] };
    expect(diff.lines.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['Vertrag Version zwei', 'Laufzeit 24 Monate']);

    // The search index of Ask your archive follows the current version.
    const indexed = () => h.rag.store.documentChunks(id).map((c) => c.text).join(' ');
    await h.rag.sync();
    expect(indexed()).toContain('24 Monate');
    h.ctx.config.update({ rag: { autoSync: true } });

    await h.inject({ method: 'POST', url: `/api/documents/${id}/versions/1/activate`, headers: { cookie } });
    doc = (await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.current_version).toBe(1);
    expect(doc.content).toContain('12 Monate');
    // Switching the version is a document event: the index is updated without waiting for a sync.
    await waitFor(() => indexed().includes('12 Monate'));
    expect(indexed()).not.toContain('24 Monate');
    // the current version cannot be deleted, another one can (owners)
    expect((await h.inject({ method: 'DELETE', url: `/api/documents/${id}/versions/1`, headers: { cookie } })).statusCode).toBe(409);
    expect((await h.inject({ method: 'DELETE', url: `/api/documents/${id}/versions/2`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('undoes version changes and trash moves from the change log', async () => {
    const [r] = await upload([{ name: 'v1.pdf', data: makePdf([['Angebot Version eins']]) }], { skipAnalysis: 'true' });
    const id = r.documentId!;
    const m = multipart([{ name: 'v2.pdf', data: makePdf([['Angebot Version zwei']]) }]);
    await h.inject({ method: 'POST', url: `/api/documents/${id}/versions`, headers: { cookie, 'content-type': m.contentType }, payload: m.payload });
    await h.engine.drain();
    const events = () => h.ctx.db.prepare('SELECT id, kind, reverted_by FROM lib_document_events WHERE document_id = ? ORDER BY id').all(id) as { id: number; kind: string; reverted_by: number | null }[];
    const undo = (eventId: number, force = false) => h.inject({ method: 'POST', url: `/api/documents/${id}/events/${eventId}/undo`, headers: { cookie }, payload: { force } });
    const current = async () => ((await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail).current_version;

    // The new version is undone by making version 1 current again (the file stays in the list).
    const added = events().find((e) => e.kind === 'version_added')!;
    const activity = (await h.inject({ method: 'GET', url: `/api/documents/${id}/activity`, headers: { cookie } })).json() as ActivityItem[];
    expect(activity.find((a) => a.kind === 'version' && a.title === 'New version')?.undo).toEqual({ kind: 'event', id: added.id });
    expect((await undo(added.id)).statusCode).toBe(200);
    expect(await current()).toBe(1);
    expect((await undo(added.id)).json().code).toBe('already_undone');

    // A switch that was overtaken by another one needs force.
    await h.inject({ method: 'POST', url: `/api/documents/${id}/versions/2/activate`, headers: { cookie } });
    const switched = events().filter((e) => e.kind === 'version_switched').at(-1)!;
    await h.inject({ method: 'POST', url: `/api/documents/${id}/versions/1/activate`, headers: { cookie } });
    expect((await undo(switched.id)).json().code).toBe('undo_conflict');
    expect((await undo(switched.id, true)).statusCode).toBe(200);
    expect(await current()).toBe(1);

    // Trash: undoing "moved to the trash" restores, undoing the restore moves it back.
    await h.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: { cookie } });
    const deleted = events().filter((e) => e.kind === 'deleted').at(-1)!;
    const restored = await undo(deleted.id);
    expect(restored.json()).toMatchObject({ ok: true, effect: 'restored' });
    expect((await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).statusCode).toBe(200);
    const restoreEvent = events().filter((e) => e.kind === 'restored').at(-1)!;
    expect(restoreEvent.id).toBeGreaterThan(deleted.id);
    // The restore made by the undo is itself marked as an undo and offers no undo of its own.
    const after = (await h.inject({ method: 'GET', url: `/api/documents/${id}/activity`, headers: { cookie } })).json() as ActivityItem[];
    expect(after.find((a) => a.kind === 'restored')?.undo ?? null).toBeNull();
    expect(after.find((a) => a.kind === 'deleted')?.reverted).toBe(true);
  });

  it('undoes single changes and detects conflicts', async () => {
    const [r] = await upload([{ name: 'doc.pdf', data: invoice }], { skipAnalysis: 'true' });
    const id = r.documentId!;
    await h.inject({ method: 'PATCH', url: `/api/documents/${id}`, headers: { cookie }, payload: { title: 'First', tags: ['A'] } });
    await h.inject({ method: 'PATCH', url: `/api/documents/${id}`, headers: { cookie }, payload: { title: 'Second' } });
    const activity = (await h.inject({ method: 'GET', url: `/api/documents/${id}/activity`, headers: { cookie } })).json() as ActivityItem[];
    const firstChange = activity.filter((a) => a.kind === 'change').at(-1)!;
    expect(firstChange.details!.map((d) => d.field).sort()).toEqual(['Tags', 'Title']);
    // the title was changed again since then
    const conflict = await h.inject({ method: 'POST', url: `/api/documents/${id}/events/${firstChange.undo!.id}/undo`, headers: { cookie }, payload: {} });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('undo_conflict');
    const forced = await h.inject({ method: 'POST', url: `/api/documents/${id}/events/${firstChange.undo!.id}/undo`, headers: { cookie }, payload: { force: true } });
    expect(forced.statusCode, forced.body).toBe(200);
    const doc = (await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).json() as DocumentDetail;
    expect(doc.title).toBe('doc');
    expect(doc.tags).toEqual([]);
  });

  it('moves documents to the trash, restores and purges them', async () => {
    const [r] = await upload([{ name: 'doc.pdf', data: invoice }], { skipAnalysis: 'true' });
    const id = r.documentId!;
    await h.engine.drain();
    expect((await h.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: { cookie } })).json()).toMatchObject({ trash: 'native' });
    expect((await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).statusCode).toBe(404);
    const trash = (await h.inject({ method: 'GET', url: '/api/trash', headers: { cookie } })).json() as { id: number; purgeAt: number }[];
    expect(trash.map((t) => t.id)).toEqual([id]);
    await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: { cookie }, payload: { ids: [id], action: 'restore' } });
    expect((await h.inject({ method: 'GET', url: `/api/documents/${id}`, headers: { cookie } })).statusCode).toBe(200);

    await h.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: { cookie } });
    const purge = await h.inject({ method: 'POST', url: '/api/trash/purge', headers: { cookie }, payload: { ids: [id] } });
    expect(purge.json()).toMatchObject({ purged: 1 });
    expect(local().row(id, true)).toBeUndefined();
    // the file is collected once nothing references it
    const sha = (h.ctx.db.prepare('SELECT sha256 FROM blobs').get() as { sha256: string }).sha256;
    expect(local().blobs.has(sha)).toBe(true);
    await local().maintenance.collectBlobs();
    expect(local().blobs.has(sha)).toBe(false);
  });

  it('leaves documents in the trash out of the statistics and keeps their state for a restore', async () => {
    h.llm.reply(analysisJson({ title: 'Stromrechnung März 2024', tags: ['Rechnung'] }));
    const [r] = await upload([{ name: 'scan.pdf', data: invoice }]);
    const id = r.documentId!;
    await h.engine.drain();
    const status = async () => (await h.inject({ method: 'GET', url: '/api/processing/status', headers: { cookie } })).json() as ProcessingStatus;
    const dashboard = async () => (await h.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } })).json() as DashboardData;
    expect((await status()).counts.processed).toBe(1);

    // In the trash: neither a document nor a processed one ("1 of 0 documents" before).
    await h.inject({ method: 'DELETE', url: `/api/documents/${id}`, headers: { cookie } });
    expect((await status()).counts).toEqual({ processed: 0, failed: 0, skipped: 0 });
    expect((await status()).lastProcessed).toBeNull();
    expect((await dashboard()).archive.documents).toBe(0);

    // A scan does not forget the state, so the restored document is not analysed (and paid for) again.
    await h.engine.scan();
    expect(h.ctx.repos.documents.get(id)?.status).toBe('processed');
    h.llm.clearRequests();
    await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: { cookie }, payload: { ids: [id], action: 'restore' } });
    await h.engine.scan();
    await h.engine.drain();
    expect(h.llm.chatRequests()).toHaveLength(0);
    expect((await status()).counts.processed).toBe(1);
    expect((await dashboard()).archive.documents).toBe(1);
  });

  it('empties the trash after the retention of the library', async () => {
    const [r] = await upload([{ name: 'doc.pdf', data: invoice }], { skipAnalysis: 'true' });
    await h.inject({ method: 'DELETE', url: `/api/documents/${r.documentId}`, headers: { cookie } });
    expect(local().maintenance.purgeTrash()).toBe(0);
    expect(local().maintenance.purgeTrash(Date.now() + 31 * 86_400_000)).toBe(1);
  });
});

describe('libraries and roles', () => {
  it('keeps libraries apart and enforces viewer / editor roles', async () => {
    const [own] = await upload([{ name: 'own.pdf', data: invoice }], { skipAnalysis: 'true' });
    const lib = (await h.inject({ method: 'POST', url: '/api/libraries', headers: { cookie }, payload: { name: 'Family' } })).json() as { id: number };
    const [fam] = await upload([{ name: 'family.pdf', data: makePdf([['Family document']]) }], { libraryId: String(lib.id), skipAnalysis: 'true' });
    await h.engine.drain();

    const memberId = h.ctx.repos.users.create('anna', 'x', 'member');
    const anna = { 'x-api-key': h.ctx.repos.apiKeys.create(memberId, { name: 'k', scopes: ['read', 'write'] }).key };
    // no membership: nothing visible
    expect(((await h.inject({ method: 'GET', url: '/api/documents?limit=50', headers: anna })).json() as DocumentListResponse).results).toEqual([]);
    expect((await h.inject({ method: 'GET', url: `/api/documents/${fam.documentId}`, headers: anna })).statusCode).toBe(404);

    // viewer of "Family": sees its documents, cannot change them
    await h.inject({ method: 'PUT', url: `/api/libraries/${lib.id}/members`, headers: { cookie }, payload: { members: [{ type: 'user', id: h.ctx.repos.users.byUsername('admin')!.id, role: 'owner' }, { type: 'user', id: memberId, role: 'viewer' }] } });
    const visible = (await h.inject({ method: 'GET', url: '/api/documents?limit=50', headers: anna })).json() as DocumentListResponse;
    expect(visible.results.map((d) => d.id)).toEqual([fam.documentId]);
    expect((await h.inject({ method: 'GET', url: `/api/documents/${own.documentId}`, headers: anna })).statusCode).toBe(404);
    const patch = await h.inject({ method: 'PATCH', url: `/api/documents/${fam.documentId}`, headers: anna, payload: { title: 'Mine now' } });
    expect(patch.statusCode).toBe(403);

    // editor via a group
    const group = (await h.inject({ method: 'POST', url: '/api/groups', headers: { cookie }, payload: { name: 'Family', members: [memberId] } })).json() as { id: number };
    await h.inject({ method: 'PUT', url: `/api/libraries/${lib.id}/members`, headers: { cookie }, payload: { members: [{ type: 'user', id: h.ctx.repos.users.byUsername('admin')!.id, role: 'owner' }, { type: 'group', id: group.id, role: 'editor' }] } });
    expect((await h.inject({ method: 'PATCH', url: `/api/documents/${fam.documentId}`, headers: anna, payload: { title: 'Edited by Anna' } })).statusCode).toBe(200);
    // tags live per library
    expect((await h.inject({ method: 'GET', url: '/api/tags', headers: anna })).json()).toEqual([]);

    // moving needs editor rights in both libraries
    const move = await h.inject({ method: 'PATCH', url: `/api/documents/${fam.documentId}`, headers: anna, payload: { libraryId: own.documentId ? h.ctx.repos.libraries.list()[0].id : 0 } });
    expect(move.statusCode).toBe(403);
    const moved = await h.inject({ method: 'PATCH', url: `/api/documents/${fam.documentId}`, headers: { cookie }, payload: { libraryId: h.ctx.repos.libraries.list()[0].id } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await h.inject({ method: 'GET', url: `/api/documents/${fam.documentId}`, headers: anna })).statusCode).toBe(404);
  });
});

describe('watch folder', () => {
  it('takes files once they stopped changing and removes them', async () => {
    const dir = makeTempDir('pai-consume-');
    h.ctx.config.update({ archive: { builtin: { consumeDir: dir } } });
    h.llm.reply(analysisJson({ title: 'From the scanner' }));
    fs.mkdirSync(path.join(dir, 'Steuer'));
    fs.writeFileSync(path.join(dir, 'Steuer', 'scan001.pdf'), invoice);
    fs.writeFileSync(path.join(dir, '.hidden.pdf'), invoice);
    const watcher = local().folders;
    expect(await watcher.poll()).toBe(0); // first sight: maybe still being written
    expect(await watcher.poll()).toBe(1);
    expect(fs.existsSync(path.join(dir, 'Steuer', 'scan001.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.hidden.pdf'))).toBe(true);
    await h.engine.drain();
    const list = (await h.inject({ method: 'GET', url: '/api/documents?limit=10', headers: { cookie } })).json() as DocumentListResponse;
    expect(list.results[0].title).toBe('From the scanner');
    const meta = h.ctx.metadata(list.results[0].library_id!);
    await meta.snapshot(true);
    expect(list.results[0].tags.map((t) => meta.tagName(t))).toContain('Steuer');

    // refused files go to .failed with the reason
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'plain text');
    await watcher.poll();
    await watcher.poll();
    expect(fs.existsSync(path.join(dir, '.failed', 'notes.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.failed', 'notes.txt.error.txt'), 'utf8')).toMatch(/not supported/);
  });
});

describe('crash safety', () => {
  it('collects files whose database row was never written and keeps stored ones', async () => {
    const [r] = await upload([{ name: 'kept.pdf', data: invoice }], { skipAnalysis: 'true' });
    // A crash after the file was renamed into the store but before the transaction committed:
    const orphan = await local().blobs.putBytes(makePdf([['never committed']]));
    expect(local().blobs.has(orphan.sha256)).toBe(true);
    const known = (sha: string) => Boolean(h.ctx.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha));
    expect((await local().blobs.gc(known, 0)).orphans).toBe(1);
    expect(local().blobs.has(orphan.sha256)).toBe(false);
    const doc = await local().getDocument(SYSTEM_SCOPE, r.documentId!);
    expect((await local().download(SYSTEM_SCOPE, doc.id, { original: true })).data.byteLength).toBe(invoice.length);
  });

  it('leaves no half-stored document when the transaction fails', async () => {
    const before = (h.ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents').get() as { c: number }).c;
    const spy = local().refreshFts.bind(local());
    local().refreshFts = () => {
      throw new Error('simulated crash');
    };
    const [r] = await upload([{ name: 'boom.pdf', data: makePdf([['boom']]) }], { skipAnalysis: 'true' });
    local().refreshFts = spy;
    expect(r.status).toBe('failed'); // a passing failure: sending the file again can work
    expect((h.ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents').get() as { c: number }).c).toBe(before);
    expect((h.ctx.db.prepare("SELECT status FROM lib_intake ORDER BY id DESC LIMIT 1").get() as { status: string }).status).toBe('failed');
    // the stored file has no row and is collected
    await local().blobs.gc((sha) => Boolean(h.ctx.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha)), 0);
    expect((h.ctx.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c).toBe(0);
  });
});
