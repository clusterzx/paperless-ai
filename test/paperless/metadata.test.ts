import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaperlessClient, PaperlessError } from '../../src/server/paperless/client.js';
import { normalizeName, PaperlessMetadata } from '../../src/server/paperless/metadata.js';
import { MockPaperless } from '../helpers/mockPaperless.js';

let mock: MockPaperless;
let meta: PaperlessMetadata;

beforeEach(async () => {
  mock = await new MockPaperless({ minVersion: 9, maxVersion: 10 }).start();
  mock.addTag('Invoice', 1);
  mock.addTag('Insurance', 2);
  mock.addCorrespondent('ACME Corp', 10);
  mock.addDocumentType('Contract', 20);
  mock.addCustomField('Amount', 'monetary', { default_currency: 'EUR' }, 30);
  meta = new PaperlessMetadata(new PaperlessClient({ url: mock.url, token: mock.token }));
});
afterEach(() => mock.close());

const posts = (collection: string) => mock.calls('POST', `/api/${collection}/`);

describe('normalizeName', () => {
  it('normalises case, whitespace and unicode', () => {
    expect(normalizeName('  ACME   Corp ')).toBe('acme corp');
    expect(normalizeName('Gebühren')).toBe(normalizeName('Gebühren'));
  });
});

describe('PaperlessMetadata', () => {
  it('loads and caches a snapshot', async () => {
    const [a, b] = await Promise.all([meta.snapshot(), meta.snapshot()]);
    expect(a).toBe(b);
    expect(a.tags.map((t) => t.name)).toEqual(['Insurance', 'Invoice']);
    expect(a.customFields[0]).toMatchObject({ id: 30, data_type: 'monetary' });
    await meta.snapshot();
    expect(mock.calls('GET', '/api/tags/')).toHaveLength(1);
    await meta.snapshot(true);
    expect(mock.calls('GET', '/api/tags/')).toHaveLength(2);
    expect(meta.tagName(1)).toBe('Invoice');
    expect(meta.correspondentName(10)).toBe('ACME Corp');
    expect(meta.correspondentName(null)).toBeNull();
    expect(meta.documentTypeName(20)).toBe('Contract');
    expect(meta.documentTypeName(999)).toBeNull();
    expect(meta.customFieldByName('amount')?.id).toBe(30);
  });

  it('expires the cache after the TTL', async () => {
    const shortLived = new PaperlessMetadata(new PaperlessClient({ url: mock.url, token: mock.token }), 0);
    await shortLived.snapshot();
    await shortLived.snapshot();
    expect(mock.calls('GET', '/api/tags/')).toHaveLength(2);
  });

  it('works without permission to read custom fields', async () => {
    mock.intercept = (r) => (r.path === '/api/custom_fields/' ? { status: 403, body: { detail: 'Forbidden' } } : undefined);
    const snap = await meta.snapshot();
    expect(snap.customFields).toEqual([]);
    expect(snap.tags).toHaveLength(2);
  });

  it('resolves names case-insensitively', async () => {
    expect(await meta.resolveTag('  invoice ', true)).toEqual({ id: 1, name: 'Invoice', created: false });
    expect(await meta.resolveCorrespondent('acme   corp', true)).toEqual({ id: 10, name: 'ACME Corp', created: false });
    expect(await meta.resolveDocumentType('CONTRACT', false)).toEqual({ id: 20, name: 'Contract', created: false });
    expect(await meta.resolveCustomField('AMOUNT', false)).toEqual({ id: 30, name: 'Amount', created: false });
    expect(posts('tags')).toHaveLength(0);
  });

  it('does not create when not allowed and ignores empty names', async () => {
    expect(await meta.resolveTag('Unknown', false)).toEqual({ id: null, name: 'Unknown', created: false });
    expect(await meta.resolveTag('   ', true)).toEqual({ id: null, name: '', created: false });
    expect(posts('tags')).toHaveLength(0);
  });

  it('creates missing objects once and remembers them', async () => {
    const res = await meta.resolveTag(' New   Tag ', true);
    expect(res).toMatchObject({ name: 'New Tag', created: true });
    expect(mock.tagByName('New Tag')!.id).toBe(res.id);
    expect(await meta.resolveTag('new tag', true)).toEqual({ id: res.id, name: 'New Tag', created: false });
    expect(posts('tags')).toHaveLength(1);
    const cf = await meta.resolveCustomField('IBAN', true, 'string');
    expect(meta.customField(cf.id!)).toMatchObject({ name: 'IBAN', data_type: 'string' });
  });

  it('shares one request for concurrent creation of the same name', async () => {
    const results = await Promise.all([
      meta.resolveTag('Electricity', true),
      meta.resolveTag('electricity', true),
      meta.resolveTag(' ELECTRICITY ', true),
      meta.resolveCorrespondent('Electricity', true),
    ]);
    expect(new Set(results.slice(0, 3).map((r) => r.id)).size).toBe(1);
    expect(posts('tags')).toHaveLength(1);
    expect(posts('correspondents')).toHaveLength(1);
    expect(mock.tags.size).toBe(3);
  });

  it('recovers when the object was created elsewhere in the meantime (400 unique constraint)', async () => {
    await meta.snapshot();
    const created = mock.addTag('Created By Someone Else');
    const res = await meta.resolveTag('created by someone else', true);
    expect(res).toEqual({ id: created.id, name: 'Created By Someone Else', created: false });
    expect(posts('tags')).toHaveLength(1);
    // the snapshot was refreshed
    expect(mock.calls('GET', '/api/tags/')).toHaveLength(2);
  });

  it('propagates other creation errors', async () => {
    mock.intercept = (r) => (r.method === 'POST' ? { status: 400, body: { name: ['Name too long'] } } : undefined);
    const err = await meta.resolveTag('Boom', true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaperlessError);
    expect((err as PaperlessError).status).toBe(400);
    // a later attempt is not blocked by a stale in-flight promise
    mock.intercept = null;
    expect((await meta.resolveTag('Boom', true)).created).toBe(true);
  });

  it('resolves many tags at once', async () => {
    const res = await meta.resolveTags(['Invoice', 'invoice', 'Brand new', 'Insurance', '', '  '], true);
    expect(res.ids).toHaveLength(3);
    expect(res.ids.slice(0, 1)).toEqual([1]);
    expect(res.created).toEqual(['Brand new']);
    expect(res.missing).toEqual([]);
    const restricted = await meta.resolveTags(['Invoice', 'Nope'], false);
    expect(restricted).toEqual({ ids: [1], missing: ['Nope'], created: [] });
  });
});
