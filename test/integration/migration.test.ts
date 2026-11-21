/**
 * Migration assistant Paperless-ngx → built-in archive (docs/standalone/migration.md §6) against
 * the mock Paperless-ngx: analysis, plan ("who will see what"), import with the same ids and
 * `modified`, incremental sync, cutover with everything staying valid, exports, discard.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { MigrationPlan, MigrationReport, MigrationStatus } from '../../src/shared/migration.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { IMPORTED_REASON } from '../../src/server/processing/engine.js';
import { checksumProblem } from '../../src/server/migration/service.js';

let h: Harness;
let cookie: string;
afterEach(async () => {
  await h?.close();
});

const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdfA = makePdf([['Stromrechnung März', 'Stadtwerke', '84,20 EUR']]);
const pdfB = makePdf([['Mietvertrag', 'Leopoldstraße 12']]);

async function seed() {
  h = await createHarness();
  cookie = await h.login();
  const p = h.paperless;
  p.user = { id: 1, username: 'paperless-admin', is_superuser: true };
  p.users = [
    { id: 1, username: 'paperless-admin', is_superuser: true },
    { id: 7, username: 'anna' },
    { id: 8, username: 'bob' },
  ];
  p.groups = [{ id: 3, name: 'Familie' }];
  p.extras.workflows = [{ id: 1 }, { id: 2 }];
  p.extras.mail_accounts = [{ id: 1 }];
  p.extras.saved_views = [{ id: 1 }];
  p.addTag('Rechnung', 10).color = '#ff0000';
  p.addTag('Posteingang', 11).is_inbox_tag = true;
  p.addCorrespondent('Stadtwerke', 20);
  p.addDocumentType('Rechnung', 30);
  p.storagePaths.set(40, { id: 40, name: 'Finanzen', path: '{{ created_year }}/{{ correspondent }}' });
  const amount = p.addCustomField('Betrag', 'monetary', { default_currency: 'EUR' }, 50);
  const kind = p.addCustomField('Art', 'select', { select_options: [{ id: 'a1', label: 'Strom' }, { id: 'a2', label: 'Gas' }] }, 51);
  const count = p.addCustomField('Anzahl', 'integer', null, 52);
  // Anna's invoice: Bob may view it. Bob's contract: private. One document without owner.
  p.addDocument({
    id: 101,
    title: 'Stromrechnung März',
    content: 'Stromrechnung März Stadtwerke 84,20 EUR',
    owner: 7,
    tags: [10, 11],
    correspondent: 20,
    document_type: 30,
    storage_path: 40,
    created: '2024-03-31',
    archive_serial_number: 17,
    custom_fields: [
      { field: amount.id, value: 'EUR84.20' },
      { field: kind.id, value: 'a1' },
      { field: count.id, value: 'zwölf' },
    ],
    permissions: { view: { users: [8], groups: [] }, change: { users: [], groups: [] } },
    notes: [{ id: 1, note: 'Bezahlt am 2.4.', created: '2024-04-02T10:00:00Z', user: 7 }],
    file: { data: pdfA, contentType: 'application/pdf' },
    archive: makePdf([['Archived PDF/A']]),
  });
  p.addDocument({ id: 102, title: 'Mietvertrag', content: 'Mietvertrag Leopoldstraße 12', owner: 8, created: '2023-05-01', file: { data: pdfB, contentType: 'application/pdf' } });
  p.addDocument({ id: 103, title: 'Gemeinsam', content: 'Ein Dokument für alle im Haushalt', owner: null, created: '2022-01-01' });

  // State of Paperless-AI that refers to the documents: processed, history, calendar.
  h.llm.reply(analysisJson({ title: 'Stromrechnung März', events: [{ title: 'Zahlung', date: '2024-04-14', time: null, kind: 'due' }] }));
  h.ctx.config.update({ processing: { functions: { events: true } } });
  await h.inject({ method: 'POST', url: '/api/processing/scan', headers: h.apiKeyHeaders() });
  await h.engine.drain();
  await h.workflows.drain();
  // Bob exists in Paperless-AI already; Anna does not.
  h.ctx.repos.users.create('bob', 'x', 'member');
}

const post = (url: string, payload: unknown = {}) => h.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });

describe('migration from Paperless-ngx', () => {
  it('analyses, plans, imports with the same ids, syncs and switches over', async () => {
    await seed();
    const processedBefore = new Map([101, 102, 103].map((id) => [id, h.ctx.repos.documents.get(id)]));
    expect([...processedBefore.values()].every((s) => s?.status === 'processed')).toBe(true);

    const report = (await post('/api/migration/analyse')).json() as MigrationReport;
    expect(report.counts).toMatchObject({ documents: 3, tags: 2, correspondents: 1, documentTypes: 1, customFields: 3, storagePaths: 1, users: 3, notes: 1 });
    expect(report.notTransferred).toMatchObject({ workflows: 2, mailAccounts: 1, savedViews: 1, notes: 1 });
    expect(report.fieldProblems).toEqual([{ documentId: 101, field: 'Anzahl', value: 'zwölf' }]);
    expect(report.owners.map((o) => o.name).sort()).toEqual(['(no owner)', 'anna', 'bob']);
    expect(report.storage.estimatedBytes).toBeGreaterThan(0);

    const strategy = { kind: 'owner', sharedName: 'Gemeinsam' };
    const options = { archived: true, createUsers: true, concurrency: 2 };
    const plan = (await post('/api/migration/plan', { strategy, options })).json() as MigrationPlan;
    const lib = (name: string) => plan.libraries.find((l) => l.name === name)!;
    expect(lib('anna').members).toEqual(expect.arrayContaining([{ user: 'anna', role: 'owner' }, { user: 'bob', role: 'viewer' }]));
    expect(lib('bob').members.map((m) => m.user)).not.toContain('anna');
    expect(plan.users.find((u) => u.ngx === 'bob')).toMatchObject({ action: 'match', local: 'bob' });
    expect(plan.users.find((u) => u.ngx === 'anna')).toMatchObject({ action: 'create' });
    // Documents without owner are visible to everyone in Paperless-ngx – no widening there.
    expect(plan.widened.filter((w) => w.library === 'Gemeinsam')).toEqual([]);

    const started = (await post('/api/migration/start', { strategy, options })).json() as MigrationStatus;
    expect(started.state).toBe('importing');
    await waitFor(async () => ((await h.inject({ method: 'GET', url: '/api/migration/status', headers: { cookie } })).json() as MigrationStatus).state === 'imported');

    // Same ids, same `modified`, metadata by name in the libraries, users and members.
    const db = h.ctx.db;
    const rows = db.prepare('SELECT id, library_id, title, created, modified, archive_serial_number, owner_id FROM lib_documents ORDER BY id').all() as { id: number; library_id: number; modified: string; owner_id: number | null }[];
    expect(rows.map((r) => r.id)).toEqual([101, 102, 103]);
    for (const r of rows) expect(r.modified).toBe(h.paperless.docs.get(r.id)!.modified);
    const anna = h.ctx.repos.users.byUsername('anna')!;
    expect(anna.disabled_at).not.toBeNull();
    expect(rows[0].owner_id).toBe(anna.id);
    const libs = h.ctx.repos.libraries.list();
    const annaLib = libs.find((l) => l.name === 'anna')!;
    expect(rows[0].library_id).toBe(annaLib.id);
    expect(libs.find((l) => l.id === rows[2].library_id)?.name).toBe('Gemeinsam');
    expect(h.ctx.repos.libraries.rolesFor(h.ctx.repos.users.byUsername('bob')!.id).get(annaLib.id)).toBe('viewer');
    expect(h.ctx.repos.libraries.rolesFor(h.ctx.repos.users.byUsername('admin')!.id).get(annaLib.id)).toBe('owner');
    const tag = db.prepare("SELECT color, is_inbox FROM lib_tags WHERE library_id = ? AND name = 'Posteingang'").get(annaLib.id) as { color: string | null; is_inbox: number };
    expect(tag.is_inbox).toBe(1);
    const fields = db.prepare('SELECT f.name, v.value_text, v.value_num, v.value_json FROM lib_custom_field_values v JOIN lib_custom_fields f ON f.id = v.field_id WHERE v.document_id = 101 ORDER BY f.name').all();
    expect(fields).toEqual([
      { name: 'Anzahl', value_text: 'zwölf', value_num: null, value_json: null }, // did not fit: kept as text
      { name: 'Art', value_text: 'a1', value_num: null, value_json: null },
      { name: 'Betrag', value_text: null, value_num: 84.2, value_json: '{"currency":"EUR"}' },
    ]);
    const files = db.prepare('SELECT kind, blob_sha256 FROM lib_document_files WHERE document_id = 101 ORDER BY kind').all() as { kind: string; blob_sha256: string }[];
    expect(files.map((f) => f.kind)).toEqual(['archive', 'original']);
    const local = () => h.ctx.archive() as unknown as LocalBackend;
    expect(fs.existsSync(path.join(h.dataDir, 'migration', 'notes.json'))).toBe(true);
    expect(db.prepare("SELECT actor_type, ref FROM lib_document_events WHERE document_id = 101 AND kind = 'created'").get()).toEqual({ actor_type: 'import', ref: 'ngx:101' });

    // Changes in Paperless-ngx: a title, a new file, a deleted and a new document.
    h.paperless.editDocument(101, { title: 'Stromrechnung März 2024' });
    h.paperless.editDocument(102, { file: { data: makePdf([['Mietvertrag', 'unterschrieben']]), contentType: 'application/pdf' } });
    const title103 = h.paperless.docs.get(103)!.title;
    h.paperless.deleteDocument(103);
    h.paperless.addDocument({ id: 104, title: 'Neu', content: 'Neues Dokument', owner: 7 });
    const sync = (await post('/api/migration/sync')).json() as { added: number; updated: number; deleted: number };
    expect(sync).toEqual({ added: 1, updated: 2, deleted: 1 });
    const after = db.prepare('SELECT id, title, current_version, deleted_at IS NOT NULL AS trashed, modified FROM lib_documents ORDER BY id').all() as { id: number; title: string; current_version: number; trashed: number; modified: string }[];
    expect(after.map((r) => [r.id, r.title, r.current_version, r.trashed])).toEqual([
      [101, 'Stromrechnung März 2024', 1, 0],
      [102, h.paperless.docs.get(102)!.title, 2, 0], // new file → version 2
      [103, title103, 1, 1], // deleted in Paperless-ngx → trash
      [104, 'Neu', 1, 0],
    ]);
    expect(after[0].modified).toBe(h.paperless.docs.get(101)!.modified);

    // Cutover: the built-in archive is the archive now; nothing is analysed or indexed again.
    await h.rag.sync();
    const chunkIds = h.rag.store.documentChunks(102).map((c) => c.id);
    const cut = (await post('/api/migration/cutover')).json() as MigrationStatus;
    expect(cut).toMatchObject({ state: 'cutover', mode: 'builtin' });
    h.llm.clearRequests();
    await h.engine.scan();
    await h.engine.drain();
    // Only the document that was new in Paperless-ngx (never analysed) is analysed – none again.
    expect(h.llm.chatRequests().map((r) => JSON.stringify(r.body).includes('Neues Dokument'))).toEqual([true]);
    const list = (await h.inject({ method: 'GET', url: '/api/documents?limit=50', headers: { cookie } })).json() as { results: { id: number; title: string }[] };
    expect(list.results.map((d) => d.id).sort()).toEqual([101, 102, 104]);
    const file = await h.inject({ method: 'GET', url: '/api/documents/101/file?original=true', headers: { cookie } });
    expect(md5(Buffer.from(file.rawPayload))).toBe(md5(pdfA));
    expect(h.ctx.repos.calendar.list({}).some((e) => e.document_id === 101)).toBe(true);
    await h.rag.sync();
    expect(h.rag.store.documentChunks(102).map((c) => c.id)).toEqual(chunkIds);
    expect((h.ctx.indexDb.prepare('SELECT library_id FROM rag_documents WHERE id = 101').get() as { library_id: number }).library_id).toBe(annaLib.id);

    // Exports of the built-in archive.
    const ngxDir = path.join(h.dataDir, 'export-ngx');
    const ngx = (await post('/api/archive/export', { format: 'ngx', directory: ngxDir })).json() as { documents: number; files: number };
    expect(ngx).toMatchObject({ documents: 3 });
    const manifest = JSON.parse(fs.readFileSync(path.join(ngxDir, 'manifest.json'), 'utf8')) as { model: string; pk: number; fields: Record<string, unknown>; __exported_file_name__?: string }[];
    const doc101 = manifest.find((m) => m.model === 'documents.document' && m.pk === 101)!;
    expect(doc101.fields).toMatchObject({ title: 'Stromrechnung März 2024', checksum: sha256(pdfA), archive_serial_number: 17, created: '2024-03-31', storage_type: 'unencrypted' });
    expect(md5(fs.readFileSync(path.join(ngxDir, doc101.__exported_file_name__!)))).toBe(md5(pdfA));
    // For an older Paperless-ngx: MD5 checksums.
    const oldDir = path.join(h.dataDir, 'export-ngx-md5');
    await post('/api/archive/export', { format: 'ngx', directory: oldDir, checksums: 'md5' });
    const oldManifest = JSON.parse(fs.readFileSync(path.join(oldDir, 'manifest.json'), 'utf8')) as { model: string; pk: number; fields: Record<string, unknown> }[];
    expect(oldManifest.find((m) => m.model === 'documents.document' && m.pk === 101)!.fields.checksum).toBe(md5(pdfA));
    expect(manifest.filter((m) => m.model === 'documents.customfieldinstance' && m.fields.document === 101).map((m) => m.fields.value_monetary ?? m.fields.value_select ?? m.fields.value_int)).toEqual(
      expect.arrayContaining(['EUR84.20', 'a1']),
    );
    expect(JSON.parse(fs.readFileSync(path.join(ngxDir, 'metadata.json'), 'utf8')).version).toMatch(/^2\./);
    const plainDir = path.join(h.dataDir, 'export-plain');
    await post('/api/archive/export', { format: 'plain', directory: plainDir });
    const meta = JSON.parse(fs.readFileSync(path.join(plainDir, 'metadata.json'), 'utf8')) as { id: number; file: string }[];
    expect(meta.find((m) => m.id === 101)?.file).toBe('anna/Stadtwerke/2024/2024-03-31 Stromrechnung März 2024.pdf');
    expect(fs.readFileSync(path.join(plainDir, 'metadata.csv'), 'utf8')).toContain('Stromrechnung März 2024');
    void local;
  });

  it('never replaces documents added in the built-in archive itself', async () => {
    await seed();
    const db = h.ctx.db;
    const lib = h.ctx.repos.libraries.create('Eigenes', null, { trashDays: 30 });
    const own = (id: number) =>
      db
        .prepare("INSERT INTO lib_documents (id, library_id, title, added, modified, mime_type, source) VALUES (?, ?, 'Mein eigenes Dokument', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'application/pdf', 'upload')")
        .run(id, lib);
    const title = (id: number) => (db.prepare('SELECT title FROM lib_documents WHERE id = ?').get(id) as { title: string } | undefined)?.title;
    const status = async () => (await h.inject({ method: 'GET', url: '/api/migration/status', headers: { cookie } })).json() as MigrationStatus;
    const start = () => post('/api/migration/start', { strategy: { kind: 'single', libraryName: 'Archiv' }, options: { archived: false, createUsers: false, concurrency: 4 } });

    // Same id as a Paperless-ngx document: the import does not start at all.
    own(102);
    expect((await status()).ownDocuments).toBe(1);
    const refused = await start();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('1 document(s) of its own');
    expect((await status()).ids).toBe('keep');
    expect(title(102)).toBe('Mein eigenes Dokument');

    // Without them it runs; a document added here later with the id of a new ngx document is kept.
    db.prepare('DELETE FROM lib_documents WHERE id = 102').run();
    expect((await start()).statusCode).toBe(200);
    await waitFor(async () => (await status()).state === 'imported');
    expect((await status()).ownDocuments).toBe(0);
    own(104);
    h.paperless.addDocument({ id: 104, title: 'Neu in Paperless-ngx', content: 'Neu', owner: null, created: '2024-06-01', file: { data: makePdf([['Neu in Paperless-ngx']]), contentType: 'application/pdf' } });
    await post('/api/migration/sync');
    await waitFor(async () => (await status()).counts.pending === 0 && !(await status()).running);
    expect(title(104)).toBe('Mein eigenes Dokument');
    expect((await status()).errors).toEqual([{ id: 104, error: 'The built-in archive has its own document 104 – it is not replaced' }]);
  });

  it('does not switch an installation back that started with the built-in archive', async () => {
    h = await createHarness({ archive: 'builtin' });
    cookie = await h.login();
    const res = await post('/api/migration/rollback');
    expect(res.statusCode).toBe(409);
    expect(h.ctx.archiveMode()).toBe('builtin');
  });

  it('discards an import before the cutover', async () => {
    await seed();
    h.paperless.checksums = 'md5'; // an older Paperless-ngx: its MD5 checksums are checked as well
    const patchesBefore = h.paperless.calls('PATCH', /\/api\/documents\//).length;
    await post('/api/migration/start', { strategy: { kind: 'single', libraryName: 'Archiv' }, options: { archived: false, createUsers: false, concurrency: 4 } });
    await waitFor(async () => ((await h.inject({ method: 'GET', url: '/api/migration/status', headers: { cookie } })).json() as MigrationStatus).state === 'imported');
    expect((h.ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents').get() as { c: number }).c).toBe(3);
    // "Continue" retries documents that failed three times.
    h.ctx.db.prepare("UPDATE migration_items SET status = 'failed', attempts = 3, error = 'x' WHERE ngx_id = 103").run();
    await post('/api/migration/resume');
    await waitFor(async () => ((await h.inject({ method: 'GET', url: '/api/migration/status', headers: { cookie } })).json() as MigrationStatus).state === 'imported');
    expect(((await h.inject({ method: 'GET', url: '/api/migration/status', headers: { cookie } })).json() as MigrationStatus).counts).toMatchObject({ imported: 3, failed: 0 });
    const res = await post('/api/migration/discard');
    expect(res.statusCode, res.body).toBe(200);
    expect((h.ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents').get() as { c: number }).c).toBe(0);
    expect((h.ctx.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c).toBe(0);
    expect(h.ctx.repos.libraries.list().map((l) => l.name)).not.toContain('Archiv');
    expect((res.json() as MigrationStatus).state).toBe('idle');
    // Paperless-ngx is untouched (only read).
    expect(h.paperless.calls('PATCH', /\/api\/documents\//)).toHaveLength(patchesBefore);
    void SYSTEM_SCOPE;
  });
});

describe('checksums of Paperless-ngx', () => {
  it('compares SHA-256 (current versions) and MD5 (older ones) and reports a mismatch', () => {
    expect(checksumProblem(pdfA, sha256(pdfA))).toBeNull();
    expect(checksumProblem(pdfA, md5(pdfA).toUpperCase())).toBeNull();
    expect(checksumProblem(pdfA, sha256(pdfB))).toMatch(/^sha256 .+ bytes$/);
    expect(checksumProblem(pdfA, md5(pdfB))).toMatch(/^md5 /);
    expect(checksumProblem(pdfA, null)).toBeNull();
    expect(checksumProblem(pdfA, 'not-a-digest')).toBeNull();
  });
});

describe('import into a built-in archive with documents of its own', () => {
  it('imports with new ids next to them, keeps the metadata, analyses nothing and discards only the import', async () => {
    h = await createHarness({ archive: 'builtin' });
    cookie = await h.login();
    const db = h.ctx.db;
    const local = h.ctx.archive() as LocalBackend;
    const lib = local.ensureDefaultLibrary();
    const ingest = async (name: string, line: string, tags?: string[]) => (await local.ingest(SYSTEM_SCOPE, { data: makePdf([[line]]), filename: name }, 'upload', { tags, skipAnalysis: true })).documentId!;
    const ownA = await ingest('telekom.pdf', 'Eigene Rechnung der Telekom', ['Rechnung']);
    const ownB = await ingest('finanzamt.pdf', 'Eigener Brief vom Finanzamt');
    await h.engine.drain();
    db.prepare('UPDATE lib_documents SET archive_serial_number = 17 WHERE id = ?').run(ownA);

    // Paperless-ngx documents with the same ids (and the same archive serial number).
    const p = h.paperless;
    p.addTag('Rechnung', 10);
    p.addCorrespondent('Stadtwerke', 20);
    p.addDocument({ id: ownA, title: 'Stromrechnung März', content: 'Stromrechnung März Stadtwerke 84,20 EUR', owner: null, tags: [10], correspondent: 20, created: '2024-03-31', archive_serial_number: 17, file: { data: pdfA, contentType: 'application/pdf' } });
    p.addDocument({ id: ownB, title: 'Mietvertrag', content: 'Mietvertrag Leopoldstraße 12', owner: null, created: '2023-05-01', file: { data: pdfB, contentType: 'application/pdf' } });

    const status = async () => (await h.inject({ method: 'GET', url: '/api/migration/status', headers: { cookie } })).json() as MigrationStatus;
    expect(await status()).toMatchObject({ ids: 'new', ownDocuments: 2 });
    h.llm.clearRequests();
    const libName = h.ctx.repos.libraries.get(lib)!.name;
    const started = await post('/api/migration/start', { strategy: { kind: 'single', libraryName: libName }, options: { createUsers: false } });
    expect(started.statusCode, started.body).toBe(200);
    await waitFor(async () => (await status()).state === 'imported');

    type Row = { id: number; title: string; library_id: number; archive_serial_number: number | null; source: string };
    const rows = () => db.prepare('SELECT id, title, library_id, archive_serial_number, source FROM lib_documents WHERE deleted_at IS NULL ORDER BY id').all() as Row[];
    // The own documents are untouched, the imported ones have new ids in the chosen library.
    expect(rows().filter((r) => r.source !== 'import').map((r) => [r.id, r.title])).toEqual([
      [ownA, 'telekom'],
      [ownB, 'finanzamt'],
    ]);
    const imported = rows().filter((r) => r.source === 'import');
    expect(imported.map((r) => r.title).sort()).toEqual(['Mietvertrag', 'Stromrechnung März']);
    for (const r of imported) {
      expect([ownA, ownB]).not.toContain(r.id);
      expect(r.library_id).toBe(lib);
    }
    const strom = imported.find((r) => r.title === 'Stromrechnung März')!;
    expect(strom.archive_serial_number).toBeNull(); // 17 belongs to the own document
    expect((db.prepare('SELECT local_id FROM migration_items WHERE ngx_id = ?').get(ownA) as { local_id: number }).local_id).toBe(strom.id);
    // Names are merged: one tag "Rechnung" in the library, on both documents.
    expect((db.prepare("SELECT COUNT(*) AS c FROM lib_tags WHERE library_id = ? AND name_norm = 'rechnung'").get(lib) as { c: number }).c).toBe(1);
    const meta = h.ctx.metadata(lib);
    await meta.snapshot(true);
    expect((await local.getDocument(SYSTEM_SCOPE, strom.id)).tags.map((t) => meta.tagName(t))).toEqual(['Rechnung']);
    expect((await status()).ownDocuments).toBe(2);

    // Not analysed – neither now nor by a later scan; the text comes from Paperless-ngx.
    expect(h.ctx.repos.documents.get(strom.id)).toMatchObject({ status: 'skipped', reason: IMPORTED_REASON });
    await h.engine.scan();
    await h.engine.drain();
    expect(h.llm.chatRequests()).toHaveLength(0);
    expect((await local.getDocument(SYSTEM_SCOPE, strom.id)).content).toContain('84,20 EUR');

    // Sync: gone in Paperless-ngx → the imported copy goes to the trash, the own document with that id stays.
    p.deleteDocument(ownB);
    await post('/api/migration/sync');
    const mietId = imported.find((r) => r.title === 'Mietvertrag')!.id;
    expect(local.row(mietId, true)?.deleted_at).not.toBeNull();
    expect(local.row(ownB)?.title).toBe('finanzamt');

    // Discard: only the imported documents (and their state) go.
    const res = await post('/api/migration/discard');
    expect(res.statusCode, res.body).toBe(200);
    expect((db.prepare('SELECT id FROM lib_documents ORDER BY id').all() as { id: number }[]).map((r) => r.id)).toEqual([ownA, ownB]);
    expect(h.ctx.repos.documents.get(strom.id)).toBeUndefined();
    expect(h.ctx.repos.documents.get(ownA)?.status).toBe('skipped');
    expect(h.ctx.repos.libraries.get(lib)).toBeDefined();
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
