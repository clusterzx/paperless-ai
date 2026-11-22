import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import type { BulkEditResult, DocumentDetail, DocumentListResponse, MetadataItem, SavedView, UploadResult } from '../../src/shared/api.js';

let h: Harness;
let cookie: string;
let tags: Record<string, number>;

beforeAll(async () => {
  h = await createHarness();
  cookie = await h.login();
  const p = h.paperless;
  tags = { invoice: p.addTag('Invoice').id, energy: p.addTag('Energy').id, insurance: p.addTag('Insurance').id };
  const stadtwerke = p.addCorrespondent('Stadtwerke').id;
  p.addCustomField('Amount', 'monetary', { default_currency: 'EUR' });
  p.addDocument({ id: 1, title: 'Electricity March', content: 'electricity invoice', tags: [tags.invoice, tags.energy], correspondent: stadtwerke, created: '2024-03-05' });
  p.addDocument({ id: 2, title: 'Gas April', content: 'gas invoice', tags: [tags.invoice, tags.energy], correspondent: stadtwerke, created: '2024-04-02' });
  p.addDocument({ id: 3, title: 'Car insurance', content: 'motor insurance policy', tags: [tags.insurance], created: '2023-11-20' });
  p.addDocument({ id: 4, title: 'Letter', content: 'plain letter', created: '2022-01-10', file: { data: Buffer.from('<svg onload="alert(1)"/>'), contentType: 'image/svg+xml' }, original_file_name: 'evil.svg' });
});
afterAll(() => h.close());

const get = async <T>(url: string) => {
  const res = await h.inject({ method: 'GET', url, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as T;
};

describe('document list', () => {
  it('filters, sorts and pages with a cursor', async () => {
    const first = await get<DocumentListResponse>(`/api/documents?limit=2&sort=title&tags=${tags.invoice},${tags.insurance}`);
    expect(first.count).toBe(3);
    expect(first.results.map((d) => d.title)).toEqual(['Car insurance', 'Electricity March']);
    expect(first.results[1]).toMatchObject({ mime_type: 'application/pdf', page_count: 1, library_id: null });
    const second = await get<DocumentListResponse>(`/api/documents?limit=2&sort=title&tags=${tags.invoice},${tags.insurance}&cursor=${first.nextCursor}`);
    expect(second.results.map((d) => d.title)).toEqual(['Gas April']);
    expect(second.nextCursor).toBeNull();

    const none = await get<DocumentListResponse>('/api/documents?limit=10&correspondent=none&sort=-created');
    expect(none.results.map((d) => d.id)).toEqual([3, 4]);
    const dated = await get<DocumentListResponse>('/api/documents?limit=10&createdFrom=2024-01-01&createdTo=2024-03-31');
    expect(dated.results.map((d) => d.id)).toEqual([1]);
    const text = await get<DocumentListResponse>('/api/documents?limit=10&q=policy');
    expect(text.results.map((d) => d.id)).toEqual([3]);
    expect((await h.inject({ method: 'GET', url: '/api/documents?tags=abc', headers: { cookie } })).statusCode).toBe(400);
  });

  it('counts facets within the filter', async () => {
    const f = await get<{ total: number; tags: { id: number; count: number }[] }>(`/api/documents/facets?tags=${tags.energy}`);
    expect(f.total).toBe(2);
    expect(f.tags.find((t) => t.id === tags.invoice)?.count).toBe(2);
    expect(f.tags.find((t) => t.id === tags.insurance)).toBeUndefined();
  });
});

describe('document detail and editing', () => {
  it('changes metadata by name and records the change', async () => {
    const res = await h.inject({
      method: 'PATCH',
      url: '/api/documents/3',
      headers: { cookie },
      payload: { title: 'Car insurance 2024', tags: ['Insurance', 'Car'], correspondent: 'Allianz', created: '2023-11-21', customFields: [{ field_name: 'Amount', value: '412,50 €' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { document: DocumentDetail; changed: string[] };
    expect(body.changed.sort()).toEqual(['correspondent', 'created', 'custom_fields', 'tags', 'title']);
    expect(body.document.title).toBe('Car insurance 2024');
    const doc = h.paperless.docs.get(3)!;
    expect(doc.tags).toContain(h.paperless.tagByName('Car')!.id);
    expect(doc.custom_fields[0].value).toBe('EUR412.50');
    // a plain edit is no AI analysis: the document is still processed later
    expect(h.ctx.repos.documents.get(3)?.status).not.toBe('processed');
    const activity = await get<{ kind: string; title: string; details: { field: string }[] }[]>('/api/documents/3/activity');
    expect(activity[0]).toMatchObject({ kind: 'change', title: 'Changed' });
    expect(activity[0].details.map((d) => d.field)).toContain('Title');
  });

  it('serves the file with safe headers and ranges', async () => {
    const pdf = await h.inject({ method: 'GET', url: '/api/documents/1/file', headers: { cookie } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.headers['content-disposition'])).toMatch(/^inline; filename=/);
    const part = await h.inject({ method: 'GET', url: '/api/documents/1/file', headers: { cookie, range: 'bytes=0-3' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('%PDF');
    expect(part.headers['content-range']).toMatch(/^bytes 0-3\//);
    // an SVG (could carry scripts) is never shown inline
    const svg = await h.inject({ method: 'GET', url: '/api/documents/4/file?original=true', headers: { cookie } });
    expect(String(svg.headers['content-disposition'])).toMatch(/^attachment; filename="evil.svg"/);
    expect(svg.headers['content-security-policy']).toContain('sandbox');
  });

  it('bulk edits, analyses and deletes', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: { cookie }, payload: { ids: [1, 2], action: 'edit', edit: { addTags: ['Paid'], removeTags: ['Energy'] } } });
    const r = res.json() as BulkEditResult;
    expect(r).toMatchObject({ ok: 2, failed: [] });
    expect(r.ref).toMatch(/^bulk:/);
    const paid = h.paperless.tagByName('Paid')!.id;
    for (const id of [1, 2]) {
      expect(h.paperless.docs.get(id)!.tags).toContain(paid);
      expect(h.paperless.docs.get(id)!.tags).not.toContain(tags.energy);
    }
    // by filter
    const byFilter = (await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: { cookie }, payload: { filter: { tags: String(paid) }, action: 'edit', edit: { documentType: 'Bill' } } })).json() as BulkEditResult;
    expect(byFilter.ok).toBe(2);
    expect(h.paperless.docs.get(1)!.document_type).toBe(h.paperless.documentTypeByName('Bill')!.id);

    const failed = (await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: { cookie }, payload: { ids: [999], action: 'delete' } })).json() as BulkEditResult;
    expect(failed.failed[0].id).toBe(999);
    // Deleted (into the trash of Paperless-ngx): the processing state goes at once, so the
    // statistics never count more processed documents than there are.
    h.ctx.repos.documents.markProcessed(4, 'Doc 4', null);
    expect((await h.inject({ method: 'DELETE', url: '/api/documents/4', headers: { cookie } })).statusCode).toBe(200);
    expect(h.paperless.docs.has(4)).toBe(false);
    expect(h.ctx.repos.documents.get(4)).toBeUndefined();
    // The menu links to the trash of Paperless-ngx.
    const session = (await h.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json() as { archive: { trashUrl: string | null } };
    expect(session.archive.trashUrl).toMatch(/\/trash$/);
  });
});

describe('upload', () => {
  it('forwards uploads to Paperless-ngx with the hints', async () => {
    const boundary = '----test';
    const body = [
      `--${boundary}\r\nContent-Disposition: form-data; name="tags"\r\n\r\nInbox,Scanned\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nScanned letter\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 test\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const res = await h.inject({ method: 'POST', url: '/api/documents/upload', headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const [r] = (res.json() as { results: UploadResult[] }).results;
    expect(r).toMatchObject({ filename: 'scan.pdf', status: 'forwarded' });
    expect(r.taskId).toMatch(/^task-/);
    const upload = h.paperless.uploads.at(-1)!;
    const doc = h.paperless.docs.get(upload.documentId)!;
    expect(doc.title).toBe('Scanned letter');
    expect(doc.tags.map((t) => [...h.paperless.tags.values()].find((x) => x.id === t)?.name).sort()).toEqual(['Inbox', 'Scanned']);
  });

  it('needs the upload scope for API keys', async () => {
    const user = h.ctx.repos.users.byUsername('admin')!;
    const { key } = h.ctx.repos.apiKeys.create(user.id, { name: 'r', scopes: ['read'] });
    const res = await h.inject({ method: 'POST', url: '/api/documents/upload', headers: { 'x-api-key': key, 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' });
    expect(res.statusCode).toBe(403);
  });
});

describe('metadata management', () => {
  it('creates, renames, merges and deletes tags', async () => {
    const created = await h.inject({ method: 'POST', url: '/api/tags', headers: { cookie }, payload: { name: 'Receipts' } });
    expect(created.statusCode, created.body).toBe(200);
    const receipts = created.json() as MetadataItem;
    expect((await h.inject({ method: 'POST', url: '/api/tags', headers: { cookie }, payload: { name: 'receipts' } })).statusCode).toBe(400);
    expect((await h.inject({ method: 'PATCH', url: `/api/tags/${receipts.id}`, headers: { cookie }, payload: { name: 'Receipt' } })).statusCode).toBe(200);
    expect(h.paperless.tags.get(receipts.id)!.name).toBe('Receipt');

    const paid = h.paperless.tagByName('Paid')!.id;
    const merged = await h.inject({ method: 'POST', url: '/api/tags/merge', headers: { cookie }, payload: { sourceIds: [paid], targetId: receipts.id } });
    expect(merged.json()).toMatchObject({ ok: true, documents: 2 });
    expect(h.paperless.tags.has(paid)).toBe(false);
    expect(h.paperless.docs.get(1)!.tags).toContain(receipts.id);

    const list = await get<MetadataItem[]>('/api/tags');
    expect(list.find((t) => t.id === receipts.id)?.document_count).toBe(2);
    expect((await h.inject({ method: 'DELETE', url: `/api/tags/${receipts.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect(h.paperless.docs.get(1)!.tags).not.toContain(receipts.id);
  });
});

describe('saved views', () => {
  it('keeps views per user', async () => {
    const created = await h.inject({ method: 'POST', url: '/api/saved-views', headers: { cookie }, payload: { name: 'Invoices 2024', filter: { tags: String(tags.invoice), createdFrom: '2024-01-01', sort: '-created' }, inNavigation: true } });
    expect(created.statusCode, created.body).toBe(200);
    const v = created.json() as SavedView;
    expect(v).toMatchObject({ name: 'Invoices 2024', inNavigation: true, own: true, shared: false });
    expect(await get<SavedView[]>('/api/saved-views')).toHaveLength(1);
    await h.inject({ method: 'PATCH', url: `/api/saved-views/${v.id}`, headers: { cookie }, payload: { name: 'Renamed' } });
    expect((await get<SavedView[]>('/api/saved-views'))[0].name).toBe('Renamed');
    expect((await h.inject({ method: 'DELETE', url: `/api/saved-views/${v.id}`, headers: { cookie } })).statusCode).toBe(200);
  });
});
