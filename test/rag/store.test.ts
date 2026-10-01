import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db/database.js';
import { metaLine, RagStore, splitTags, type RagDocumentMeta } from '../../src/server/rag/store.js';
import { buildFtsQuery, queryTerms } from '../../src/server/rag/text.js';

let db: Db;
let store: RagStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new RagStore(db);
});
afterEach(() => db.close());

function meta(id: number, patch: Partial<RagDocumentMeta> = {}): RagDocumentMeta {
  return {
    id,
    modified: `2024-01-0${id}T00:00:00Z`,
    contentHash: `hash${id}`,
    title: `Document ${id}`,
    correspondent: null,
    documentType: null,
    tags: [],
    created: '2024-01-01',
    ...patch,
  };
}

const search = (q: string, limit = 10) => store.ftsSearch(buildFtsQuery(queryTerms(q))!, limit);
const ftsRows = () => (db.prepare('SELECT COUNT(*) AS c FROM rag_fts').get() as { c: number }).c;

describe('RagStore', () => {
  it('stores documents with chunks and full text index', () => {
    const ids = store.upsertDocument(meta(1, { title: 'Electricity bill', correspondent: 'City Utilities', tags: ['Energy', 'Home'] }), [
      'The total amount is 120 EUR.',
      'Payment due in March.',
    ]);
    expect(ids).toHaveLength(2);
    expect(store.stats()).toEqual({ documents: 1, chunks: 2, embedded: 0 });
    expect(ftsRows()).toBe(2);
    expect(search('amount').map((h) => h.id)).toEqual([ids[0]]);
    // metadata is searchable for every chunk
    expect(search('utilities').map((h) => h.id).sort()).toEqual([...ids].sort());
    const indexed = store.indexedDocuments().get(1)!;
    expect(indexed.modified).toBe('2024-01-01T00:00:00Z');
    expect(indexed.meta).toBe('Title: Electricity bill | From: City Utilities | Date: 2024-01-01 | Tags: Energy, Home');
    const chunk = store.chunksWithMeta([ids[1]]).get(ids[1])!;
    expect(chunk).toMatchObject({ documentId: 1, idx: 1, text: 'Payment due in March.', tags: ['Energy', 'Home'], chunkCount: 2 });
  });

  it('re-indexing replaces chunks and FTS rows (contentless delete)', () => {
    const old = store.upsertDocument(meta(1), ['old content about bananas']);
    expect(search('bananas')).toHaveLength(1);
    const fresh = store.upsertDocument(meta(1, { title: 'Renamed' }), ['new content about apples', 'second part']);
    expect(old).toHaveLength(1);
    expect(search('bananas')).toEqual([]);
    expect(search('apples').map((h) => h.id)).toEqual([fresh[0]]);
    expect(store.stats()).toEqual({ documents: 1, chunks: 2, embedded: 0 });
    expect(ftsRows()).toBe(2);
    expect(store.documentChunks(1).map((c) => c.text)).toEqual(['new content about apples', 'second part']);
  });

  it('deletes documents completely', () => {
    store.upsertDocument(meta(1), ['alpha content']);
    const keep = store.upsertDocument(meta(2), ['beta content']);
    const removed = store.deleteDocument(1);
    expect(removed).toHaveLength(1);
    expect(search('alpha')).toEqual([]);
    expect(search('content').map((h) => h.id)).toEqual(keep);
    expect(store.stats().documents).toBe(1);
    expect(ftsRows()).toBe(1);
    store.clear();
    expect(store.stats()).toEqual({ documents: 0, chunks: 0, embedded: 0 });
    expect(ftsRows()).toBe(0);
  });

  it('ranks title matches and frequent terms higher (BM25)', () => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor';
    // documents without the term (BM25 needs a corpus where the term is rare)
    for (let i = 10; i < 20; i++) store.upsertDocument(meta(i), [`${filler} unrelated ${i}`]);
    const [inTitle] = store.upsertDocument(meta(1, { title: 'Insurance policy' }), [`${filler} contract`]);
    const [once] = store.upsertDocument(meta(2), [`${filler} insurance mentioned once`]);
    const [often] = store.upsertDocument(meta(3), [`insurance ${filler} insurance claim insurance`]);
    store.upsertDocument(meta(4), [filler]);
    const hits = search('insurance');
    expect(hits).toHaveLength(3);
    const rank = (id: number) => hits.findIndex((h) => h.id === id);
    // a title match (meta weight 2) beats a single mention in the body; more mentions beat fewer
    expect(rank(inTitle)).toBeLessThan(rank(once));
    expect(rank(often)).toBeLessThan(rank(once));
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
    // prefix search finds inflected words / compounds
    const [compound] = store.upsertDocument(meta(5), ['Versicherungsbedingungen der Hausratversicherung']);
    expect(search('Versicherung').map((h) => h.id)).toEqual([compound]);
    // invalid MATCH syntax never throws
    expect(store.ftsSearch('"unterminated', 5)).toEqual([]);
  });

  it('manages embeddings', () => {
    const ids = store.upsertDocument(meta(1, { title: 'T', correspondent: 'C' }), ['one', 'two']);
    expect(store.countPendingEmbeddings()).toBe(2);
    const pending = store.pendingEmbeddings(10);
    expect(pending.map((p) => p.text)).toEqual(['Title: T | From: C | Date: 2024-01-01\none', 'Title: T | From: C | Date: 2024-01-01\ntwo']);
    store.saveEmbeddings([{ id: ids[0], vector: new Float32Array([1, 2, 3]) }]);
    expect(store.countPendingEmbeddings()).toBe(1);
    expect(store.pendingEmbeddings(10).map((p) => p.id)).toEqual([ids[1]]);
    expect([...store.embeddings(ids).get(ids[0])!]).toEqual([1, 2, 3]);
    expect(store.embeddings(ids).has(ids[1])).toBe(false);
    expect([...store.iterateEmbeddings()].map((e) => [e.id, e.documentId, [...e.vector]])).toEqual([[ids[0], 1, [1, 2, 3]]]);
    expect(store.stats().embedded).toBe(1);
    store.clearEmbeddings();
    expect(store.countPendingEmbeddings()).toBe(2);
  });

  it('filters documents by metadata', () => {
    store.upsertDocument(meta(1, { correspondent: 'ACME', documentType: 'Invoice', created: '2023-05-01' }), ['a']);
    store.upsertDocument(meta(2, { correspondent: 'acme', documentType: 'Contract', created: '2024-02-01' }), ['b']);
    store.upsertDocument(meta(3, { correspondent: 'Other', documentType: 'Invoice', created: '2024-07-01' }), ['c']);
    store.upsertDocument(meta(4, { created: null }), ['d']);
    const ids = (f: Parameters<RagStore['documentsWhere']>[0]) => store.documentsWhere(f).map((d) => d.id);
    expect(ids({ correspondents: ['Acme'] })).toEqual([2, 1]);
    expect(ids({ documentTypes: ['invoice'] })).toEqual([3, 1]);
    expect(ids({ years: [2024] })).toEqual([3, 2]);
    expect(ids({ from: '2024-01-01', to: '2024-03-01' })).toEqual([2]);
    expect(ids({ correspondents: ['ACME'], documentTypes: ['Invoice'] })).toEqual([1]);
    expect(ids({})).toEqual([]);
    expect(store.recentDocuments(2).map((d) => d.id)).toEqual([3, 2]);
    expect(store.distinctValues('correspondent').sort()).toEqual(['ACME', 'Other', 'acme']);
    expect(store.distinctValues('document_type').sort()).toEqual(['Contract', 'Invoice']);
  });
});

describe('metaLine / splitTags', () => {
  it('describes a document', () => {
    expect(metaLine({ title: 'T', correspondent: null, documentType: 'Letter', tags: [], created: null })).toBe('Title: T | Type: Letter');
    expect(splitTags('')).toEqual([]);
    expect(splitTags('a\u001fb')).toEqual(['a', 'b']);
  });
});
