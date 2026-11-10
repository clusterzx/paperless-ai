import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let auth: Record<string, string>;

beforeAll(async () => {
  h = await createHarness();
  auth = h.apiKeyHeaders();
  const p = h.paperless;
  p.addTag('Invoice', 1);
  p.addTag('Old', 2);
  p.addCorrespondent('ACME', 10);
  p.addDocumentType('Letter', 20);
  p.addCustomField('Notes', 'string', null, 30);
  p.addCustomField('Paid', 'boolean', null, 31);
  p.addDocument({ id: 1, title: 'scan.pdf', content: 'Invoice from ACME for consulting services, 500 EUR', tags: [2], document_type: 20, created: '2024-01-01' });
  p.addDocument({ id: 2, title: 'Electricity', content: 'Electricity statement', created: '2024-02-01' });
  p.addDocument({ id: 3, title: 'Empty', content: '' });
});
afterAll(() => h.close());

describe('manual review', () => {
  it('analyses a document without changing it', async () => {
    h.llm.reply(analysisJson({ title: 'ACME consulting invoice', correspondent: 'ACME', tags: ['Invoice', 'Consulting'], document_type: 'Invoice', document_date: '2024-01-20' }));
    const res = await h.inject({ method: 'POST', url: '/api/documents/1/analyze', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      suggestion: {
        title: 'ACME consulting invoice',
        correspondent: 'ACME',
        tags: ['Invoice', 'Consulting'],
        document_type: 'Invoice',
        document_date: '2024-01-20',
        language: 'en',
        custom_fields: [],
      },
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      model: 'test-model',
      provider: 'custom',
      truncated: false,
    });
    expect(h.paperless.patches()).toHaveLength(0);
    expect(h.paperless.calls('POST', /^\/api\/tags\/$/)).toHaveLength(0);
    expect(h.ctx.repos.documents.get(1)).toBeUndefined();
    expect(h.ctx.repos.usage.stats().byFeature).toEqual([{ feature: 'manual', calls: 1, tokens: 120 }]);
  });

  it('analyses with a custom prompt (playground)', async () => {
    h.llm.clearRequests();
    const res = await h.inject({ method: 'POST', url: '/api/documents/1/analyze', headers: auth, payload: { prompt: 'Playground prompt' } });
    expect(res.statusCode).toBe(200);
    const system = (h.llm.chatRequests()[0].body as { messages: { content: string }[] }).messages[0].content;
    expect(system.startsWith('Playground prompt')).toBe(true);
    expect(h.ctx.repos.usage.stats().byFeature.find((f) => f.feature === 'playground')?.calls).toBe(1);
  });

  it('reports documents without text', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/documents/3/analyze', headers: auth, payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('no (or almost no) text content');
  });

  it('applies reviewed values: creates missing tags and replaces the tag list', async () => {
    const res = await h.inject({
      method: 'POST',
      url: '/api/documents/1/apply',
      headers: auth,
      payload: {
        title: 'ACME consulting invoice',
        correspondent: 'ACME Consulting',
        documentType: null,
        tags: ['invoice', 'Brand New', 'Brand new'],
        created: '20.01.2024',
        customFields: [
          { field_name: 'notes', value: 'checked' },
          { field_name: 'Paid', value: 'ja' },
          { field_name: 'Unknown', value: 'x' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const brandNew = h.paperless.tagByName('Brand New')!;
    const corr = h.paperless.correspondentByName('ACME Consulting')!;
    expect(h.paperless.calls('POST', '/api/tags/')).toHaveLength(1);
    expect(h.paperless.calls('POST', '/api/custom_fields/')).toHaveLength(0);
    expect(h.paperless.patches(1)[0].body).toEqual({
      tags: [1, brandNew.id],
      title: 'ACME consulting invoice',
      correspondent: corr.id,
      document_type: null,
      created: '2024-01-20',
      custom_fields: [
        { field: 30, value: 'checked' },
        { field: 31, value: true },
      ],
    });
    const body = res.json();
    expect(body.document).toEqual({ id: 1, title: 'ACME consulting invoice', created: '2024-01-20', correspondent: corr.id, document_type: null, tags: [1, brandNew.id] });
    expect(body.changed.sort()).toEqual(['correspondent', 'created', 'custom_fields', 'document_type', 'tags', 'title']);
    expect(body.notes).toEqual(['Custom field "Unknown" does not exist in Paperless']);

    const entry = h.ctx.repos.history.list({ documentId: 1 }).items[0];
    expect(entry).toMatchObject({ source: 'manual', title: 'ACME consulting invoice', correspondent: 'ACME Consulting', documentType: null, canRevert: true });
    expect(entry.before).toMatchObject({ title: 'scan.pdf', tags: [2], document_type: 20 });
    expect(h.ctx.repos.documents.get(1)!.status).toBe('processed');
  });

  it('applies nothing when nothing changed and reports invalid dates', async () => {
    h.paperless.clearRequests();
    const res = await h.inject({ method: 'POST', url: '/api/documents/2/apply', headers: auth, payload: { title: 'Electricity', created: 'someday' } });
    expect(res.json()).toMatchObject({ changed: [], notes: ['Invalid date "someday" ignored'] });
    expect(h.paperless.patches()).toHaveLength(0);
  });

  it('returns an error from Paperless for unknown documents', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/documents/999/apply', headers: auth, payload: { title: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'paperless_error', error: expect.stringContaining('404') });
  });
});

describe('document browsing', () => {
  it('lists and searches documents with their processing state', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/documents?query=electricity', headers: auth });
    expect(res.json()).toEqual({
      count: 1,
      page: 1,
      // marked as processed by the (no-op) manual apply above
      results: [{ id: 2, title: 'Electricity', created: '2024-02-01', correspondent: null, document_type: null, tags: [], status: 'processed' }],
    });
    const all = await h.inject({ method: 'GET', url: '/api/documents?pageSize=2', headers: auth });
    expect(all.json().count).toBe(3);
    expect(all.json().results).toHaveLength(2);
    const playground = await h.inject({ method: 'GET', url: '/api/playground/documents?limit=1', headers: auth });
    expect(playground.json()).toHaveLength(1);
  });

  it('returns document details and thumbnails', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/documents/2', headers: auth });
    expect(res.json()).toMatchObject({
      id: 2,
      content: 'Electricity statement',
      original_file_name: '2.pdf',
      custom_fields: [],
      user_can_change: true,
      url: `${h.paperless.url}/documents/2/details`,
    });
    const thumb = await h.inject({ method: 'GET', url: '/api/documents/2/thumb', headers: auth });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(thumb.body).toBe('THUMB-2');
  });

  it('lists metadata', async () => {
    const res = await h.inject({ method: 'GET', url: '/api/metadata', headers: auth });
    const body = res.json();
    expect(body.tags.map((t: { name: string }) => t.name)).toContain('Invoice');
    expect(body.customFields).toContainEqual({ id: 30, name: 'Notes', data_type: 'string' });
    const counts = await h.inject({ method: 'GET', url: '/api/metadata/counts', headers: auth });
    expect(counts.json().tags[0]).toMatchObject({ document_count: expect.any(Number) });
  });
});
