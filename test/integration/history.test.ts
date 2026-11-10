import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysisJson, createHarness, type Harness } from '../helpers/appHarness.js';

let h: Harness;
let auth: Record<string, string>;
let amountId: number;

beforeAll(async () => {
  h = await createHarness({ config: { processing: { customFields: [{ name: 'Amount', type: 'float', description: '' }] } } });
  auth = h.apiKeyHeaders();
  const p = h.paperless;
  p.addTag('Inbox', 1);
  p.addTag('Finance', 2);
  p.addCorrespondent('Bank', 10);
  p.addDocumentType('Statement', 20);
  amountId = p.addCustomField('Amount', 'float', null, 30).id;
  p.addDocument({ id: 1, title: 'scan_a.pdf', content: 'Electricity bill from City Power', tags: [1], created: '2024-01-01', custom_fields: [{ field: 30, value: 1 }] });
  p.addDocument({ id: 2, title: 'scan_b.pdf', content: 'Bank statement for account 123', correspondent: 10, document_type: 20, created: '2024-02-01' });
  p.addDocument({ id: 3, title: 'scan_c.pdf', content: 'Insurance policy document text', created: '2024-03-01' });
  h.llm.reply((req) => {
    if (req.user.includes('Electricity'))
      return analysisJson({
        title: 'Electricity bill',
        correspondent: 'City Power',
        tags: ['Finance', 'Energy'],
        document_type: 'Bill',
        document_date: '2024-01-15',
        custom_fields: [{ field_name: 'Amount', value: '99,90' }],
      });
    if (req.user.includes('Bank')) return analysisJson({ title: 'Bank statement 100% complete', tags: ['Finance'], document_type: 'Statement' });
    return analysisJson({ title: 'Insurance policy', correspondent: 'Allianz', tags: ['Insurance'] });
  });
  await h.inject({ method: 'POST', url: '/api/processing/scan', headers: auth });
  await h.engine.drain();
});
afterAll(() => h.close());

const history = async (query = '') => (await h.inject({ method: 'GET', url: `/api/history${query}`, headers: auth })).json();

describe('history', () => {
  it('lists entries with pagination and resolved tag names', async () => {
    const all = await history('?sort=documentId&order=asc');
    expect(all).toMatchObject({ total: 3, filtered: 3, page: 1, pageSize: 25 });
    expect(all.items.map((i: { documentId: number }) => i.documentId)).toEqual([1, 2, 3]);
    const energy = h.paperless.tagByName('Energy')!;
    expect(all.items[0]).toMatchObject({
      title: 'Electricity bill',
      tags: [1, 2, energy.id],
      tagNames: ['Inbox', 'Finance', 'Energy'],
      after: { title: 'Electricity bill', created: '2024-01-15', custom_fields: [{ field: amountId, value: 99.9 }] },
    });

    const page1 = await history('?pageSize=2&sort=documentId&order=asc');
    const page2 = await history('?pageSize=2&page=2&sort=documentId&order=asc');
    expect(page1.items.map((i: { documentId: number }) => i.documentId)).toEqual([1, 2]);
    expect(page2.items.map((i: { documentId: number }) => i.documentId)).toEqual([3]);
    expect(page2).toMatchObject({ total: 3, filtered: 3, page: 2, pageSize: 2 });
  });

  it('searches and filters', async () => {
    expect((await history('?search=electricity')).items.map((i: { documentId: number }) => i.documentId)).toEqual([1]);
    expect((await history('?search=100%25')).items.map((i: { documentId: number }) => i.documentId)).toEqual([2]);
    expect((await history('?search=allianz')).filtered).toBe(1);
    expect((await history('?search=2')).items.map((i: { documentId: number }) => i.documentId)).toEqual([2]);
    expect((await history('?tag=2')).filtered).toBe(2);
    expect((await history('?correspondent=Bank')).filtered).toBe(1);
    expect((await history('?documentId=3')).items[0].title).toBe('Insurance policy');
    const filters = (await h.inject({ method: 'GET', url: '/api/history/filters', headers: auth })).json();
    expect(filters.correspondents).toEqual(['Allianz', 'Bank', 'City Power']);
    expect(filters.tags.map((t: { name: string }) => t.name)).toContain('Energy');
  });

  it('reverts the AI changes and does not process the document again', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/history/revert', headers: auth, payload: { documentIds: [1, 999] } });
    expect(res.json().results).toEqual([
      { documentId: 1, ok: true },
      { documentId: 999, ok: false, error: 'No undo information stored for document 999' },
    ]);
    expect(h.paperless.docs.get(1)).toMatchObject({
      title: 'scan_a.pdf',
      tags: [1],
      correspondent: null,
      document_type: null,
      created: '2024-01-01',
      custom_fields: [{ field: 30, value: 1 }],
    });
    expect(h.ctx.repos.documents.get(1)).toMatchObject({ status: 'skipped', reason: 'reverted' });

    const visible = await history();
    expect(visible.filtered).toBe(2);
    const withReverted = await history('?includeReverted=true&documentId=1');
    expect(withReverted.items[0]).toMatchObject({ canRevert: false, revertedAt: expect.any(Number) });
    expect((await history('?includeReverted=false')).filtered).toBe(2);

    // a scan does not touch the reverted document again
    h.llm.clearRequests();
    const scan = await h.inject({ method: 'POST', url: '/api/processing/scan', headers: auth });
    expect(scan.json()).toEqual({ queued: 0 });
    // … even after it was modified in Paperless
    h.paperless.editDocument(1, { title: 'Renamed by the user' });
    expect((await h.inject({ method: 'POST', url: '/api/processing/scan', headers: auth })).json()).toEqual({ queued: 0 });
    expect(h.llm.chatRequests()).toHaveLength(0);

    const again = await h.inject({ method: 'POST', url: '/api/history/revert', headers: auth, payload: { documentIds: [1] } });
    expect(again.json().results[0]).toMatchObject({ ok: false });
  });

  it('resets the processing state so documents are processed again', async () => {
    const res = await h.inject({ method: 'POST', url: '/api/history/reset', headers: auth, payload: { documentIds: [3], deleteHistory: true } });
    expect(res.json()).toEqual({ reset: 1 });
    expect((await history('?documentId=3')).filtered).toBe(0);
    const scan = await h.inject({ method: 'POST', url: '/api/processing/scan', headers: auth });
    expect(scan.json()).toEqual({ queued: 1 });
    await h.engine.drain();
    expect((await history('?documentId=3')).filtered).toBe(0); // nothing changed the second time (same suggestion)
    expect(h.ctx.repos.documents.get(3)!.status).toBe('processed');

    const empty = await h.inject({ method: 'POST', url: '/api/history/reset', headers: auth, payload: {} });
    expect(empty.statusCode).toBe(400);
    const all = await h.inject({ method: 'POST', url: '/api/history/reset', headers: auth, payload: { all: true } });
    expect(all.json().reset).toBe(3);
    expect(h.ctx.repos.documents.counts()).toEqual({ processed: 0, failed: 0, skipped: 0 });
    // resetting the state keeps the history (documents 1 and 2; the entry of 3 was deleted above)
    expect((await history()).total).toBe(2);
    await h.inject({ method: 'POST', url: '/api/history/reset', headers: auth, payload: { all: true, deleteHistory: true } });
    expect((await history()).total).toBe(0);
  });
});
