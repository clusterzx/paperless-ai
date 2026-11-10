import { afterEach, describe, expect, it } from 'vitest';
import { documentUrl, PaperlessClient, PaperlessError } from '../../src/server/paperless/client.js';
import { MockPaperless, type MockPaperlessOptions } from '../helpers/mockPaperless.js';

const servers: MockPaperless[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(opts: MockPaperlessOptions = {}) {
  const mock = await new MockPaperless(opts).start();
  servers.push(mock);
  const client = new PaperlessClient({ url: `${mock.url}/api/`, token: mock.token });
  return { mock, client };
}

const PAPERLESS_3 = { minVersion: 9, maxVersion: 10, serverVersion: '3.0.1' };
const PAPERLESS_2_20 = { maxVersion: 9, serverVersion: '2.20.3' };
const PAPERLESS_2_14 = { maxVersion: 7, serverVersion: '2.14.7' };

describe('PaperlessClient version negotiation', () => {
  it('uses API v10 with Paperless-ngx 3.x', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    const info = await client.connect();
    expect(info).toEqual({
      user: { id: 3, username: 'paperless-ai', isSuperuser: false },
      apiVersion: 10,
      serverVersion: '3.0.1',
      aiEnabled: false,
      permissions: [],
    });
    expect(client.negotiatedVersion).toBe(10);
    expect(client.baseUrl).toBe(mock.url);
    mock.addDocument({ id: 1 });
    await client.getDocument(1);
    const [first, ...rest] = mock.requests;
    expect(first.headers.accept).toBe('application/json; version=9');
    expect(rest.map((r) => r.headers.accept)).toEqual(['application/json; version=10']);
  });

  it('uses API v9 with Paperless-ngx 2.16 – 2.20', async () => {
    const { mock, client } = await setup(PAPERLESS_2_20);
    expect((await client.connect()).apiVersion).toBe(9);
    mock.addDocument({ id: 1 });
    await client.getDocument(1);
    expect(mock.requests.every((r) => r.headers.accept === 'application/json; version=9')).toBe(true);
  });

  it('falls back to the advertised version when v9 is rejected (2.14 → v7)', async () => {
    const { mock, client } = await setup(PAPERLESS_2_14);
    const info = await client.connect();
    expect(info.apiVersion).toBe(7);
    expect(info.serverVersion).toBe('2.14.7');
    mock.addDocument({ id: 1 });
    await client.getDocument(1);
    expect(mock.requests.map((r) => r.headers.accept)).toEqual([
      'application/json; version=9', // rejected with 406
      'application/json', // version-less retry reads X-Api-Version
      'application/json; version=7',
    ]);
  });

  it('negotiates only once for concurrent requests', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    for (const id of [1, 2, 3]) mock.addDocument({ id });
    await Promise.all([client.getDocument(1), client.getDocument(2), client.getDocument(3), client.connect()]);
    expect(mock.calls('GET', '/api/ui_settings/')).toHaveLength(1);
  });

  it('caps the version at the highest supported one', async () => {
    const { client } = await setup({ minVersion: 9, maxVersion: 12 });
    expect((await client.connect()).apiVersion).toBe(10);
  });
});

describe('PaperlessClient lists', () => {
  it('paginates by page number without relying on `all` (API v10)', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    for (let id = 1; id <= 7; id++) mock.addDocument({ id, title: `Doc ${id}` });
    const raw = await client.req<Record<string, unknown>>('/documents/', { query: { page_size: 3 } });
    expect(raw).not.toHaveProperty('all');
    expect(raw.count).toBe(7);

    mock.clearRequests();
    const docs = await client.listAll<{ id: number }>('/documents/', { ordering: 'id' }, 3);
    expect(docs.map((d) => d.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(mock.calls('GET', '/api/documents/').map((r) => r.query.page)).toEqual(['1', '2', '3']);
  });

  it('stops when a page is empty even if `next` is set', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    mock.intercept = (r) =>
      r.path === '/api/tags/' ? { status: 200, body: { count: 99, next: 'http://x/api/tags/?page=9', previous: null, results: [] } } : undefined;
    expect(await client.tags()).toEqual([]);
    expect(mock.calls('GET', '/api/tags/')).toHaveLength(1);
  });

  it('filters documents by tags and ids and selects fields', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    mock.addTag('a', 1);
    mock.addTag('b', 2);
    mock.addDocument({ id: 1, tags: [1] });
    mock.addDocument({ id: 2, tags: [2] });
    mock.addDocument({ id: 3, tags: [1, 2] });
    mock.addDocument({ id: 4, tags: [] });
    const byTag = await client.listDocuments({ tagsAny: [1], ordering: 'id' });
    expect(byTag.map((d) => d.id)).toEqual([1, 3]);
    const byId = await client.listDocuments({ ids: [2, 4], fields: ['id', 'content'], ordering: 'id' });
    expect(byId).toEqual([
      { id: 2, content: '' },
      { id: 4, content: '' },
    ]);
    const q = mock.calls('GET', '/api/documents/').map((r) => r.query);
    expect(q[0]).toMatchObject({ tags__id__in: '1', ordering: 'id', fields: 'id,title,created,modified,added,tags,correspondent,document_type' });
    expect(q[1]).toMatchObject({ id__in: '2,4', fields: 'id,content' });
    expect(await client.count('/documents/')).toBe(4);
  });

  it('searches with `text` on API v10 and `title_content` on older versions', async () => {
    const v10 = await setup(PAPERLESS_3);
    v10.mock.addDocument({ id: 1, title: 'Electricity bill' });
    v10.mock.addDocument({ id: 2, title: 'Other' });
    await v10.client.connect();
    const res = await v10.client.searchDocuments({ query: ' electricity ' });
    expect(res.results.map((d) => d.id)).toEqual([1]);
    expect(v10.mock.calls('GET', '/api/documents/')[0].query).toMatchObject({ text: 'electricity', page: '1', page_size: '25' });

    const v9 = await setup(PAPERLESS_2_20);
    v9.mock.addDocument({ id: 1, title: 'Electricity bill' });
    await v9.client.connect();
    await v9.client.searchDocuments({ query: 'electricity' });
    expect(v9.mock.calls('GET', '/api/documents/')[0].query).toMatchObject({ title_content: 'electricity' });
  });
});

describe('PaperlessClient documents', () => {
  it('sends `created` as date on API ≥ 9', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    mock.addDocument({ id: 5, created: '2024-01-01' });
    const updated = await client.updateDocument(5, { title: 'New', created: '2024-02-03' });
    expect(mock.patches(5)[0].body).toEqual({ title: 'New', created: '2024-02-03' });
    expect(updated.created).toBe('2024-02-03');
    expect(mock.docs.get(5)!.title).toBe('New');
  });

  it('sends `created_date` on API < 9', async () => {
    const { mock, client } = await setup(PAPERLESS_2_14);
    mock.addDocument({ id: 5, created: '2024-01-01' });
    const doc = await client.getDocument(5);
    expect(doc.created).toBe('2024-01-01T00:00:00+01:00');
    expect(doc.created_date).toBe('2024-01-01');
    await client.updateDocument(5, { created: '2024-02-03', tags: [] });
    expect(mock.patches(5)[0].body).toEqual({ created_date: '2024-02-03', tags: [] });
    expect(mock.docs.get(5)!.created).toBe('2024-02-03');
  });

  it('loads thumbnails', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    mock.addDocument({ id: 8 });
    const thumb = await client.thumbnail(8);
    expect(thumb.contentType).toBe('image/webp');
    expect(thumb.data.toString()).toBe('THUMB-8');
  });

  it('creates metadata objects without auto-matching', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    const tag = await client.createTag('New tag');
    expect(tag.name).toBe('New tag');
    await client.createCorrespondent('ACME');
    await client.createDocumentType('Invoice');
    await client.createCustomField('Amount', 'monetary', 'EUR');
    await client.createCustomField('Note', 'string', 'EUR');
    expect(mock.calls('POST', '/api/tags/')[0].body).toEqual({ name: 'New tag', matching_algorithm: 0 });
    expect(mock.calls('POST', '/api/correspondents/')[0].body).toEqual({ name: 'ACME', matching_algorithm: 0 });
    expect(mock.calls('POST', '/api/document_types/')[0].body).toEqual({ name: 'Invoice', matching_algorithm: 0 });
    expect(mock.calls('POST', '/api/custom_fields/').map((r) => r.body)).toEqual([
      { name: 'Amount', data_type: 'monetary', extra_data: { default_currency: 'EUR' } },
      { name: 'Note', data_type: 'string' },
    ]);
    const stats = await client.statistics();
    expect(stats.documents_total).toBe(0);
  });
});

describe('PaperlessClient errors', () => {
  it('reports an invalid token (401)', async () => {
    const mock = await new MockPaperless().start();
    servers.push(mock);
    const client = new PaperlessClient({ url: mock.url, token: 'wrong' });
    const err = await client.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaperlessError);
    expect(err).toMatchObject({ status: 401, message: 'Paperless-ngx rejected the API token (401 Unauthorized)' });
  });

  it('reports missing permissions (403) with details', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    mock.intercept = (r) => (r.path === '/api/tags/' ? { status: 403, body: { detail: 'You do not have permission to perform this action.' } } : undefined);
    const err = (await client.tags().catch((e: unknown) => e)) as PaperlessError;
    expect(err).toBeInstanceOf(PaperlessError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('denied access (403)');
    expect(err.message).toContain('You do not have permission');
  });

  it('reports 404 and 400 responses', async () => {
    const { mock, client } = await setup(PAPERLESS_3);
    const notFound = (await client.getDocument(999).catch((e: unknown) => e)) as PaperlessError;
    expect(notFound.status).toBe(404);
    expect(notFound.message).toBe('Not found in Paperless-ngx (404): /api/documents/999/');
    mock.addDocument({ id: 1 });
    const bad = (await client.updateDocument(1, { tags: [12345] }).catch((e: unknown) => e)) as PaperlessError;
    expect(bad.status).toBe(400);
    expect(bad.message).toContain('Paperless-ngx rejected the request (400)');
    expect(bad.message).toContain('Invalid pk');
    // PATCH requests are never retried
    expect(mock.patches(1)).toHaveLength(1);
  });

  it('reports an unreachable server', async () => {
    const mock = await new MockPaperless().start();
    const url = mock.url;
    await mock.close();
    const client = new PaperlessClient({ url, token: 'x', timeoutMs: 2000 });
    const err = (await client.connect().catch((e: unknown) => e)) as PaperlessError;
    expect(err).toBeInstanceOf(PaperlessError);
    expect(err.status).toBe(0);
    expect(err.message).toContain(`Cannot reach Paperless-ngx at ${url}`);
  });
});

describe('documentUrl', () => {
  it('builds links to the Paperless UI', () => {
    expect(documentUrl('https://paperless.example.com/', 12)).toBe('https://paperless.example.com/documents/12/details');
  });
});
