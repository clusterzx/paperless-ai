/**
 * The Paperless-ngx compatible API (/ngx/api/) of the built-in archive: what the mobile apps made
 * for Paperless-ngx (Swift Paperless, Paperless Mobile, Paperless Native …) call, in the shapes they
 * decode – and our own Paperless-ngx client (the companion mode) working against it over HTTP.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { PaperlessClient } from '../../src/server/paperless/client.js';
import { newTotpSecret, timeStep, totpCode } from '../../src/server/totp.js';
import { documentDateOf, filterFromQuery, intakeIdOf, taskIdOf, takeDateRanges } from '../../src/server/ngx/format.js';

let h: Harness;
let token: string;
const PASSWORD = 'correct horse battery';

beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
  await h.login();
  const res = await h.inject({ method: 'POST', url: '/ngx/api/token/', payload: { username: 'admin', password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  token = res.json().token;
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;
const auth = (extra: Record<string, string> = {}) => ({ authorization: `Token ${token}`, accept: 'application/json; version=9', ...extra });
const get = (url: string, headers: Record<string, string> = auth()) => h.inject({ method: 'GET', url, headers });

async function addDocument(title: string, text: string, hints: { tags?: string[]; correspondent?: string; created?: string } = {}) {
  // Long enough to count as a good text layer (short ones are read again by the test OCR).
  const lines = [text, 'Sehr geehrte Damen und Herren, anbei erhalten Sie die Unterlagen zu Ihrem Vorgang.', 'Mit freundlichen Grüßen, Ihre Verwaltung'];
  const res = await local().ingest(SYSTEM_SCOPE, { data: makePdf([lines]), filename: `${title}.pdf` }, 'upload', { title, skipAnalysis: true, ...hints });
  expect(res.status).toBe('stored');
  return res.documentId!;
}

describe('signing in like the apps', () => {
  it('answers the server checks of the apps', async () => {
    // Swift Paperless: GET of the token endpoint, versions from 10 down – 406, then 405.
    const v10 = await h.inject({ method: 'GET', url: '/ngx/api/token/', headers: { accept: 'application/json; version=10' } });
    expect(v10.statusCode).toBe(406);
    const v9 = await h.inject({ method: 'GET', url: '/ngx/api/token/', headers: { accept: 'application/json; version=9' } });
    expect(v9.statusCode).toBe(405);
    expect(v9.headers['x-api-version']).toBe('9');
    expect(v9.headers['x-version']).toMatch(/^\d+\.\d+\.\d+$/);
    // Paperless Mobile: HEAD /api/schema/ without signing in, then HEAD /api/profile/ with the token.
    expect((await h.inject({ method: 'HEAD', url: '/ngx/api/schema/' })).statusCode).toBe(200);
    const profile = await h.inject({ method: 'HEAD', url: '/ngx/api/profile/', headers: { authorization: `Token ${token}` } });
    expect(profile.statusCode).toBe(200);
    expect(Number(profile.headers['x-api-version'])).toBeGreaterThanOrEqual(9);
    // Without a token: 401 in the error format of Paperless-ngx, with the version headers.
    const anon = await h.inject({ method: 'GET', url: '/ngx/api/ui_settings/' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toEqual({ detail: 'Authentication credentials were not provided.' });
    expect(anon.headers['x-api-version']).toBe('9');
    const wrong = await h.inject({ method: 'GET', url: '/ngx/api/ui_settings/', headers: { authorization: 'Token nonsense' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ detail: 'Invalid token.' });
  });

  it('answers the server check of Paperparrot without signing in', async () => {
    // Paperparrot tests the address with the version check (open to anyone in Paperless-ngx) …
    const version = await h.inject({ method: 'GET', url: '/ngx/api/remote_version/', headers: { accept: 'application/json' } });
    expect(version.statusCode, version.body).toBe(200);
    expect(version.json()).toEqual({ version: expect.stringMatching(/^v\d+\.\d+\.\d+$/), update_available: false });
    expect(version.headers['x-version']).toMatch(/^\d+\.\d+\.\d+$/);
    // … asks for a single sign-on of the server (none here: 404, not 401) …
    expect((await h.inject({ method: 'GET', url: '/ngx/api/auth/headless/app/v1/config', headers: { accept: 'application/json' } })).statusCode).toBe(404);
    // … and sends the API version as `Version=` and an empty token before the login.
    expect((await h.inject({ method: 'GET', url: '/ngx/api/', headers: { accept: 'application/json; Version=9' } })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/ngx/api/config/', headers: { accept: 'application/json; Version=10' } })).statusCode).toBe(406);
    const config = await h.inject({ method: 'GET', url: '/ngx/api/config/', headers: { authorization: `Token ${token}`, accept: 'application/json; Version=9', 'content-type': 'application/json' } });
    expect(config.statusCode, config.body).toBe(200);
    expect(config.headers['x-version']).toMatch(/^\d+\.\d+\.\d+$/);
    // The JSON content type on every request, also on a DELETE without a body.
    const tag = (await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: auth(), payload: { name: 'Weg' } })).json();
    const del = await h.inject({ method: 'DELETE', url: `/ngx/api/tags/${tag.id}/`, headers: auth({ 'content-type': 'application/json', 'content-length': '0' }) });
    expect(del.statusCode, del.body).toBe(204);
    const broken = await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: auth({ 'content-type': 'application/json' }), payload: '{"name":' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().detail).toMatch(/^JSON parse error/);
  });

  it('gives Paperparrot every field it decodes and takes what it sends', async () => {
    const pp = (extra: Record<string, string> = {}) => auth({ accept: 'application/json; Version=9', 'content-type': 'application/json', ...extra });
    // Status: Paperparrot decodes every field, dates included.
    const status = (await get('/ngx/api/status/', pp())).json();
    expect(status.database.migration_status).toEqual({ latest_migration: expect.any(String), unapplied_migrations: [] });
    expect(typeof status.tasks.redis_url).toBe('string');
    expect(new Date(status.tasks.index_last_modified).getTime()).not.toBeNaN();
    expect(new Date(status.tasks.classifier_last_trained).getTime()).not.toBeNaN();
    expect(typeof status.storage.total).toBe('number');
    // Statistics: the current ASN is a number; logs and sign-in providers are (empty) lists.
    expect(typeof (await get('/ngx/api/statistics/', pp())).json().current_asn).toBe('number');
    expect((await get('/ngx/api/logs/mail/', pp())).json()).toEqual([]);
    expect((await get('/ngx/api/logs/paperless/', pp())).json()).toEqual([]);
    expect((await get('/ngx/api/logs/other/', pp())).statusCode).toBe(404);
    expect((await get('/ngx/api/profile/social_account_providers/', pp())).json()).toEqual([]);
    expect((await get('/ngx/api/ui_settings/', pp())).json().settings.notes_enabled).toBe(false);

    // New tags with their parent, new select fields with their options.
    const parent = (await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: pp(), payload: { name: 'Finanzen', color: '#00ff00' } })).json();
    const child = await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: pp(), payload: { name: 'Steuer', color: '#0000ff', parent: parent.id, match: '', matching_algorithm: 0, is_insensitive: true, is_inbox_tag: false } });
    expect(child.statusCode, child.body).toBe(201);
    expect(child.json()).toMatchObject({ name: 'Steuer', color: '#0000ff', parent: parent.id });
    const select = await h.inject({ method: 'POST', url: '/ngx/api/custom_fields/', headers: pp(), payload: { name: 'Status', data_type: 'select', extra_data: { select_options: [{ id: null, label: 'Offen' }, { id: null, label: 'Bezahlt' }], default_currency: null } } });
    expect(select.statusCode, select.body).toBe(201);
    expect(select.json().extra_data.select_options.map((o: { label: string }) => o.label)).toEqual(['Offen', 'Bezahlt']);
    const renamed = await h.inject({ method: 'PATCH', url: `/ngx/api/custom_fields/${select.json().id}/`, headers: pp(), payload: { name: 'Status', data_type: 'select', extra_data: { select_options: [...select.json().extra_data.select_options, { id: null, label: 'Storniert' }] } } });
    expect(renamed.json().extra_data.select_options.map((o: { label: string }) => o.label)).toEqual(['Offen', 'Bezahlt', 'Storniert']);
    expect(renamed.json().extra_data.select_options[0].id).toBe(select.json().extra_data.select_options[0].id);

    // A document changed with Swift's default JSONEncoder: the date as seconds since 2001.
    const id = await addDocument('Rechnung', 'Eine Rechnung über einen Betrag');
    const doc = (await get(`/ngx/api/documents/${id}/`, pp())).json();
    const midnightBerlin = Date.UTC(2024, 2, 30, 23, 0, 0) / 1000 - 978_307_200; // 2024-03-31 00:00 in UTC+1
    const changed = await h.inject({ method: 'PATCH', url: `/ngx/api/documents/${id}/`, headers: pp(), payload: { ...doc, title: 'Rechnung März', created: midnightBerlin, set_permissions: null } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ title: 'Rechnung März', created: '2024-03-31' });
  });

  it('gives a token for user name and password, and asks for the code with two-factor authentication', async () => {
    const bad = await h.inject({ method: 'POST', url: '/ngx/api/token/', payload: { username: 'admin', password: 'wrong' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().non_field_errors[0]).toMatch(/Unable to log in/);
    // form encoded as well
    const form = await h.inject({ method: 'POST', url: '/ngx/api/token/', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `username=admin&password=${encodeURIComponent(PASSWORD)}` });
    expect(form.statusCode, form.body).toBe(200);

    const admin = h.ctx.repos.users.byUsername('admin')!;
    const secret = newTotpSecret();
    h.ctx.repos.users.setPendingTotp(admin.id, secret);
    h.ctx.repos.users.enableTotp(admin.id, timeStep() - 5, []);
    const noCode = await h.inject({ method: 'POST', url: '/ngx/api/token/', payload: { username: 'admin', password: PASSWORD } });
    expect(noCode.statusCode).toBe(400);
    expect(noCode.json().non_field_errors).toEqual(['MFA code is required']);
    const withCode = await h.inject({ method: 'POST', url: '/ngx/api/token/', payload: { username: 'admin', password: PASSWORD, code: totpCode(secret, timeStep()) } });
    expect(withCode.statusCode, withCode.body).toBe(200);
    expect(withCode.json().token).toMatch(/^pai_/);
  });

  it('describes the user with the permissions the apps check', async () => {
    const ui = (await get('/ngx/api/ui_settings/')).json();
    expect(ui.user.username).toBe('admin');
    expect(ui.permissions).toEqual(expect.arrayContaining(['view_document', 'change_document', 'add_tag', 'view_customfield', 'view_applicationconfiguration']));
    // Settings the app saves come back.
    await h.inject({ method: 'POST', url: '/ngx/api/ui_settings/', headers: auth(), payload: { settings: { saved_views: { dashboard_views_visible_ids: [] } } } });
    expect((await get('/ngx/api/ui_settings/')).json().settings.saved_views).toEqual({ dashboard_views_visible_ids: [] });
    // Paperless Native finds itself in the user list.
    const users = (await get('/ngx/api/users/?username=admin')).json();
    expect(users.results).toHaveLength(1);
    expect(users.results[0].inherited_permissions).toContain('view_document');
    expect(users.results[0]).toHaveProperty('is_mfa_enabled', false);
    expect((await get('/ngx/api/config/')).json()).toHaveLength(1);
    expect((await get('/ngx/api/remote_version/')).json()).toEqual({ version: expect.stringMatching(/^v\d/), update_available: false });
  });
});

describe('documents', () => {
  it('lists, filters, pages and shows documents as Paperless-ngx', async () => {
    const a = await addDocument('Stromrechnung März', 'Stadtwerke Strom März', { tags: ['Rechnung'], correspondent: 'Stadtwerke', created: '2024-03-31' });
    await addDocument('Mietvertrag', 'Mietvertrag Wohnung', { tags: ['Vertrag'], created: '2021-03-01' });
    await addDocument('Versicherung', 'Kfz Versicherung', { created: '2024-12-02' });
    const list = (await get('/ngx/api/documents/?page=1&page_size=2&truncate_content=true&full_perms=true&ordering=-created,id')).json();
    expect(list.count).toBe(3);
    expect(list.results.map((d: { title: string }) => d.title)).toEqual(['Versicherung', 'Stromrechnung März']);
    // `next`: absolute, with the public host and the /ngx prefix (Swift Paperless follows it as is).
    expect(list.next).toMatch(/^http:\/\/localhost(:80)?\/ngx\/api\/documents\/\?page=2&page_size=2&truncate_content=true&full_perms=true&ordering=-created%2Cid$/);
    expect(list.results[1]).toMatchObject({ created: '2024-03-31', created_date: '2024-03-31', storage_path: null, notes: [], is_shared_by_requester: false });
    expect(list.results[1].permissions).toEqual({ view: { users: [], groups: [] }, change: { users: [], groups: [] } });
    expect(list.results[1].content).toContain('Stadtwerke');
    const second = (await get('/ngx/api/documents/?page=2&page_size=2&ordering=-created,id')).json();
    expect(second.results.map((d: { title: string }) => d.title)).toEqual(['Mietvertrag']);
    expect(second.next).toBeNull();

    const tags = (await get('/ngx/api/tags/?page=1&page_size=100000&full_perms=true')).json();
    const rechnung = tags.results.find((t: { name: string }) => t.name === 'Rechnung');
    expect(rechnung).toMatchObject({ slug: 'rechnung', matching_algorithm: 0, is_inbox_tag: false, match: '', is_insensitive: true, document_count: 1 });
    expect(rechnung.color).toMatch(/^#[0-9a-f]{6}$/);
    const byTag = (await get(`/ngx/api/documents/?tags__id__all=${rechnung.id}`)).json();
    expect(byTag.results.map((d: { id: number }) => d.id)).toEqual([a]);
    const byText = (await get('/ngx/api/documents/?query=Wohnung')).json();
    expect(byText.results.map((d: { title: string }) => d.title)).toEqual(['Mietvertrag']);
    expect((await get('/ngx/api/documents/?created__date__gt=2024-01-01&ordering=created')).json().results.map((d: { title: string }) => d.title)).toEqual(['Stromrechnung März', 'Versicherung']);
    expect((await get('/ngx/api/documents/?is_tagged=0')).json().results.map((d: { title: string }) => d.title)).toEqual(['Versicherung']);
    expect((await get('/ngx/api/documents/?storage_path__id=3')).json().count).toBe(0);
    // An API version before 9: `created` as date and time.
    const old = (await get(`/ngx/api/documents/${a}/`, auth({ accept: 'application/json; version=5' }))).json();
    expect(old.created).toBe('2024-03-31T12:00:00Z');

    // the files
    const thumb = await get(`/ngx/api/documents/${a}/thumb/`);
    expect(thumb.statusCode).toBe(200);
    expect(String(thumb.headers['content-type'])).toMatch(/^image\/(webp|png)/);
    const download = await get(`/ngx/api/documents/${a}/download/?original=true`);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(String(download.headers['content-disposition'])).toMatch(/^attachment/);
    expect((await get(`/ngx/api/documents/${a}/preview/`)).headers['content-disposition']).toMatch(/^inline/);
    expect((await get(`/ngx/api/documents/${a}/metadata/`)).json()).toMatchObject({ original_mime_type: 'application/pdf', has_archive_version: false });
    expect((await get(`/ngx/api/documents/${a}/suggestions/`)).json()).toEqual({ correspondents: [], tags: [], document_types: [], storage_paths: [], dates: [] });
    expect((await get('/ngx/api/documents/999/')).statusCode).toBe(404);
  });

  it('reads all ids of a large page in parts', async () => {
    for (let i = 0; i < 7; i++) await addDocument(`Doc ${i}`, `Inhalt ${i}`);
    const all = (await get('/ngx/api/documents/?fields=id&page_size=25000')).json();
    expect(all.results).toHaveLength(7);
    expect(Object.keys(all.results[0])).toEqual(['id']);
    // page_size 3 → three pages of 3, 3, 1
    const p3 = (await get('/ngx/api/documents/?fields=id&page_size=3&page=3')).json();
    expect(p3.results).toHaveLength(1);
  });

  it('changes, edits in bulk, deletes and restores documents', async () => {
    const id = await addDocument('Brief', 'Ein Brief vom Amt mit langem Text '.repeat(20), { tags: ['Post'] });
    const fieldRes = await h.inject({ method: 'POST', url: '/ngx/api/custom_fields/', headers: auth(), payload: { name: 'Betrag', data_type: 'monetary', extra_data: { default_currency: 'EUR' } } });
    expect(fieldRes.statusCode, fieldRes.body).toBe(201);
    const field = fieldRes.json();
    const tag = (await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: auth(), payload: { name: 'Erledigt', color: '#ff0000' } })).json();
    expect(tag).toMatchObject({ name: 'Erledigt', color: '#ff0000', text_color: '#ffffff' });

    // Paperless Mobile sends the date as a date and time without time zone; the shortened text of a list stays out.
    const listed = (await get(`/ngx/api/documents/?id__in=${id}&truncate_content=true`)).json().results[0];
    const patched = await h.inject({
      method: 'PATCH',
      url: `/ngx/api/documents/${id}/`,
      headers: auth(),
      payload: { title: 'Brief vom Amt', created: '2024-05-01T00:00:00.000', tags: [...listed.tags, tag.id], custom_fields: [{ field: field.id, value: 'EUR12.50' }], content: listed.content },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ title: 'Brief vom Amt', created: '2024-05-01', custom_fields: [{ field: field.id, value: 'EUR12.50' }] });
    expect(listed.content.length).toBe(300);
    expect((await local().getDocument(SYSTEM_SCOPE, id)).content!.length).toBeGreaterThan(300); // not cut to the list's 300 characters

    const bulk = await h.inject({ method: 'POST', url: '/ngx/api/documents/bulk_edit/', headers: auth(), payload: { documents: [id], method: 'modify_tags', parameters: { add_tags: [], remove_tags: [tag.id] } } });
    expect(bulk.json()).toEqual({ result: 'OK' });
    expect((await get(`/ngx/api/documents/${id}/`)).json().tags).not.toContain(tag.id);

    expect((await h.inject({ method: 'DELETE', url: `/ngx/api/documents/${id}/`, headers: auth() })).statusCode).toBe(204);
    const trash = (await get('/ngx/api/trash/')).json();
    expect(trash.results.map((d: { id: number }) => d.id)).toEqual([id]);
    expect(trash.results[0].deleted_at).toBeTruthy();
    await h.inject({ method: 'POST', url: '/ngx/api/trash/', headers: auth(), payload: { action: 'restore', documents: [id] } });
    expect((await get(`/ngx/api/documents/${id}/`)).statusCode).toBe(200);

    // labels: PUT and PATCH (200), DELETE (204)
    expect((await h.inject({ method: 'PUT', url: `/ngx/api/tags/${tag.id}/`, headers: auth(), payload: { ...tag, name: 'Fertig' } })).json().name).toBe('Fertig');
    expect((await h.inject({ method: 'DELETE', url: `/ngx/api/tags/${tag.id}/`, headers: auth() })).statusCode).toBe(204);
    expect((await get(`/ngx/api/tags/${tag.id}/`)).statusCode).toBe(404);
  });

  it('always sends a document date – the apps cannot read a list with an empty one', async () => {
    const id = await addDocument('Ohne Datum', 'Ein Schreiben ganz ohne Angabe eines Tages');
    expect((await local().getDocument(SYSTEM_SCOPE, id)).created ?? null).toBeNull();
    const listed = (await get('/ngx/api/documents/?ordering=-created,id')).json().results[0];
    expect(listed.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(listed.created).toBe(String(listed.added).slice(0, 10));
    expect(listed.created_date).toBe(listed.created);
    expect(listed.title).toBe('Ohne Datum');

    // Swift Paperless sends the whole document back when the title changes: the date shown is not saved.
    const res = await h.inject({ method: 'PUT', url: `/ngx/api/documents/${id}/`, headers: auth(), payload: { ...listed, title: 'Schreiben' } });
    expect(res.statusCode, res.body).toBe(200);
    const doc = await local().getDocument(SYSTEM_SCOPE, id);
    expect(doc.title).toBe('Schreiben');
    expect(doc.created ?? null).toBeNull();
    // A date picked in the app is.
    await h.inject({ method: 'PATCH', url: `/ngx/api/documents/${id}/`, headers: auth(), payload: { created: '2023-07-14' } });
    expect((await local().getDocument(SYSTEM_SCOPE, id)).created).toBe('2023-07-14');
  });

  it('uploads like the apps and reports the task', async () => {
    const boundary = '----app';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nVom Handy\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      makePdf([['Gescannt mit der App']]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await h.inject({ method: 'POST', url: '/ngx/api/documents/post_document/', headers: auth({ 'content-type': `multipart/form-data; boundary=${boundary}` }), payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const taskId = res.json() as string;
    expect(taskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    const [task] = (await get(`/ngx/api/tasks/?task_id=${taskId}`)).json();
    expect(task).toMatchObject({ task_id: taskId, status: 'SUCCESS', task_name: 'consume_file', type: 'auto_task', acknowledged: false });
    expect(typeof task.related_document).toBe('string');
    // Paperless Mobile (no API version) gets pages, the others a list.
    const paged = (await get('/ngx/api/tasks/?task_name=consume_file', { authorization: `Token ${token}` })).json();
    expect(paged.results.map((t: { task_id: string }) => t.task_id)).toContain(taskId);
    await h.inject({ method: 'POST', url: '/ngx/api/tasks/acknowledge/', headers: auth(), payload: { tasks: [task.id] } });
    expect((await get('/ngx/api/tasks/?acknowledged=false')).json()).toEqual([]);
  });

  it('counts, searches and describes a selection', async () => {
    const a = await addDocument('Stromrechnung', 'Stadtwerke Strom Abrechnung', { tags: ['Rechnung'], correspondent: 'Stadtwerke' });
    await addDocument('Stundenplan', 'Stundenplan der Schule');
    const stats = (await get('/ngx/api/statistics/')).json();
    expect(stats).toMatchObject({ documents_total: 2, tag_count: 1, correspondent_count: 1, storage_path_count: 0 });
    expect(stats.document_file_type_counts).toEqual([{ mime_type: 'application/pdf', mime_type_count: 2 }]);
    expect(stats.character_count).toBeGreaterThan(50);
    expect((await get('/ngx/api/search/autocomplete/?term=stu&limit=10')).json()).toEqual(['stundenplan']);
    const search = (await get('/ngx/api/search/?query=Stadtwerke')).json();
    expect(search.documents.map((d: { id: number }) => d.id)).toEqual([a]);
    expect(search.correspondents.map((c: { name: string }) => c.name)).toEqual(['Stadtwerke']);
    for (const key of ['saved_views', 'storage_paths', 'users', 'groups', 'mail_rules', 'mail_accounts', 'workflows', 'custom_fields']) expect(search[key]).toEqual(expect.any(Array));
    const selection = (await h.inject({ method: 'POST', url: '/ngx/api/documents/selection_data/', headers: auth(), payload: { documents: [a] } })).json();
    expect(selection.selected_tags).toEqual([expect.objectContaining({ document_count: 1 })]);
    expect(await (await get('/ngx/api/documents/next_asn/')).json()).toBe(1);
    // A second tag of the same name is refused as in Paperless-ngx.
    const dup = await h.inject({ method: 'POST', url: '/ngx/api/tags/', headers: auth(), payload: { name: 'Rechnung' } });
    expect(dup.statusCode).toBe(400);
  });

  it('answers what does not exist here in the API format and only with the built-in archive', async () => {
    expect((await get('/ngx/api/storage_paths/?page_size=100000')).json()).toMatchObject({ count: 0, results: [] });
    expect((await get('/ngx/api/saved_views/')).json().results).toEqual([]);
    const missing = await get('/ngx/api/whatever/');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ detail: 'Not found.' });
  });
});

describe('our own Paperless-ngx client against it', () => {
  it('connects, reads, writes and uploads over HTTP', async () => {
    await addDocument('Stromrechnung', 'Stadtwerke Strom', { tags: ['Rechnung'], correspondent: 'Stadtwerke', created: '2024-03-31' });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const client = new PaperlessClient({ url: `http://127.0.0.1:${port}/ngx`, token });
    const info = await client.connect();
    expect(info.user.username).toBe('admin');
    expect(info.apiVersion).toBe(9);
    const docs = await client.listDocuments({});
    expect(docs.map((d) => d.title)).toEqual(['Stromrechnung']);
    const doc = await client.getDocument(docs[0].id);
    expect(doc.content).toContain('Stadtwerke');
    expect((await client.tags()).map((t) => t.name)).toEqual(['Rechnung']);
    expect((await client.correspondents()).map((c) => c.name)).toEqual(['Stadtwerke']);
    const created = await client.createTag('Neu');
    await client.updateDocument(doc.id, { title: 'Stromrechnung März', tags: [...doc.tags, created.id] });
    const after = await client.getDocument(doc.id);
    expect(after.title).toBe('Stromrechnung März');
    expect(after.tags).toContain(created.id);
    const file = await client.download(doc.id, true);
    expect(file.contentType).toBe('application/pdf');
    expect((await client.thumbnail(doc.id)).data.length).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('turns task ids into intake ids and back', () => {
    expect(intakeIdOf(taskIdOf(4711))).toBe(4711);
    expect(intakeIdOf('intake-12')).toBe(12);
    expect(intakeIdOf('nonsense')).toBeNull();
  });

  it('reads document dates in the forms the apps send', () => {
    expect(documentDateOf('2024-03-31')).toBe('2024-03-31');
    expect(documentDateOf('2024-03-31T00:00:00')).toBe('2024-03-31');
    expect(documentDateOf('2024-03-31T00:00:00.000')).toBe('2024-03-31');
    expect(documentDateOf('2024-03-31T12:00:00Z')).toBe('2024-03-31');
    expect(documentDateOf('2024-03-31T12:00:00+02:00')).toBe('2024-03-31');
    // Swift's default: seconds since 2001 – midnight on the phone, east or west of UTC.
    expect(documentDateOf(733_536_000)).toBe('2024-03-31'); // 00:00 UTC
    expect(documentDateOf(733_536_000 - 2 * 3600)).toBe('2024-03-31'); // 00:00 in UTC+2
    expect(documentDateOf(733_536_000 + 5 * 3600)).toBe('2024-03-31'); // 00:00 in UTC-5
    expect(documentDateOf('31.03.2024')).toBeNull();
    expect(documentDateOf(null)).toBeNull();
  });

  it('reads the relative date ranges of Paperless Mobile', () => {
    const today = new Date('2026-11-22T10:00:00Z');
    expect(takeDateRanges('created:[-1 week to now]', today)).toEqual({ rest: '', created: { from: '2026-11-15', to: '2026-11-22' }, added: {} });
    const f = filterFromQuery({ query: 'rechnung,added:[-1 month to now]' }, today);
    expect(f).toMatchObject({ query: 'rechnung', addedFrom: '2026-10-22', addedTo: '2026-11-22' });
    expect(takeDateRanges('created:[  20240101   TO   20241231 ] strom', today)).toEqual({ rest: 'strom', created: { from: '2024-01-01', to: '2024-12-31' }, added: {} });
    // Without " to " the bracket stays text.
    expect(takeDateRanges('added:[2024]', today).rest).toBe('added:[2024]');
    // Long runs of spaces (CodeQL: polynomial regular expression) take no time.
    const started = Date.now();
    takeDateRanges(`added:[${' '.repeat(50_000)}x`, today);
    takeDateRanges(`added:[ to ${'  '.repeat(50_000)}`, today);
    takeDateRanges(`a${' '.repeat(50_000)},b`, today);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('with Paperless-ngx as the archive', () => {
  it('is not there', async () => {
    const companion = await createHarness();
    try {
      const res = await companion.inject({ method: 'GET', url: '/ngx/api/ui_settings/', headers: { 'x-api-key': companion.ctx.cfg.security.apiKey } });
      expect(res.statusCode).toBe(404);
      expect(res.json().detail).toMatch(/built-in archive/);
    } finally {
      await companion.close();
    }
  });
});
