/**
 * Contract test suite for DocumentBackend implementations. Every backend (Paperless-ngx via the
 * mock server, the built-in archive) must pass the same tests – see docs/standalone/testing-and-operations.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import { MetadataCache } from '../../src/server/backend/metadata.js';
import { statusOf, type DocumentBackend } from '../../src/server/backend/types.js';

export interface SeedDoc {
  title: string;
  content: string;
  tags?: string[];
  correspondent?: string;
  documentType?: string;
  created: string;
  file?: { data: Buffer; contentType: string; filename: string };
}

export interface ContractFixture {
  backend: DocumentBackend;
  /** Create the documents (and their metadata); returns their ids in order. */
  seed(docs: SeedDoc[]): Promise<number[]>;
  close(): Promise<void>;
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1');

const SEED: SeedDoc[] = [
  { title: 'Electricity bill March', content: 'Stadtwerke electricity invoice for March, amount 84.20 EUR', tags: ['Invoice', 'Energy'], correspondent: 'Stadtwerke', documentType: 'Invoice', created: '2024-03-05' },
  { title: 'Gas bill April', content: 'Stadtwerke gas invoice for April', tags: ['Invoice', 'Energy'], correspondent: 'Stadtwerke', documentType: 'Invoice', created: '2024-04-02' },
  { title: 'Car insurance policy', content: 'Allianz motor insurance policy number 4711', tags: ['Insurance'], correspondent: 'Allianz', documentType: 'Contract', created: '2023-11-20' },
  { title: 'Tax assessment 2023', content: 'Finanzamt tax assessment for the year 2023', tags: ['Tax'], correspondent: 'Finanzamt', created: '2024-06-15' },
  { title: 'Unsorted letter', content: 'A letter without any metadata at all', created: '2022-01-10' },
];

export function backendContract(name: string, make: () => Promise<ContractFixture>): void {
  describe(`DocumentBackend contract: ${name}`, () => {
    let fx: ContractFixture;
    let backend: DocumentBackend;
    let ids: number[];
    let meta: MetadataCache;
    const scope = SYSTEM_SCOPE;

    beforeEach(async () => {
      fx = await make();
      backend = fx.backend;
      ids = await fx.seed(SEED);
      const [lib] = await backend.metadataScopes(scope);
      meta = new MetadataCache(backend.metadataSource(lib), 0, {}, lib);
    });
    afterEach(async () => {
      await fx.close();
    });

    const tagId = async (n: string) => (await meta.resolveTag(n, false)).id!;

    it('reports its kind, label and capabilities', async () => {
      expect(['paperless', 'builtin']).toContain(backend.kind);
      expect(backend.label).toBeTruthy();
      expect(backend.capabilities).toHaveProperty('upload');
      const info = await backend.info(scope);
      expect(info.connected).toBe(true);
    });

    it('lists documents with id, title and modified', async () => {
      const docs = await backend.listDocuments(scope, { fields: ['id', 'title', 'modified'], ordering: 'id' });
      expect(docs.map((d) => d.id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
      for (const d of docs) {
        expect(d.title).toBeTruthy();
        expect(typeof d.modified).toBe('string');
      }
    });

    it('filters the list by tags (any / none) and ids', async () => {
      const invoice = await tagId('Invoice');
      const insurance = await tagId('Insurance');
      const any = await backend.listDocuments(scope, { tagsAny: [invoice, insurance], fields: ['id'] });
      expect(any.map((d) => d.id).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
      const none = await backend.listDocuments(scope, { tagsNone: [invoice], fields: ['id'] });
      expect(none.map((d) => d.id).sort()).toEqual([ids[2], ids[3], ids[4]].sort());
      const byId = await backend.listDocuments(scope, { ids: [ids[3]], fields: ['id', 'content'] });
      expect(byId).toHaveLength(1);
      expect(byId[0].content).toContain('Finanzamt');
    });

    it('returns a document with content and metadata ids', async () => {
      const d = await backend.getDocument(scope, ids[0]);
      expect(d.title).toBe('Electricity bill March');
      expect(d.content).toContain('electricity invoice');
      expect(d.tags.sort()).toEqual([await tagId('Invoice'), await tagId('Energy')].sort());
      expect(meta.correspondentName(d.correspondent)).toBe('Stadtwerke');
      expect(meta.documentTypeName(d.document_type)).toBe('Invoice');
      expect((d.created_date ?? d.created)?.slice(0, 10)).toBe('2024-03-05');
    });

    it('answers 404 for unknown documents', async () => {
      const err = await backend.getDocument(scope, 999_999).catch((e: unknown) => e);
      expect(statusOf(err)).toBe(404);
    });

    it('updates fields and changes modified', async () => {
      const before = await backend.getDocument(scope, ids[4]);
      const tax = await tagId('Tax');
      const corr = (await meta.resolveCorrespondent('Allianz', false)).id!;
      const updated = await backend.updateDocument(scope, ids[4], { title: 'Renamed', tags: [tax], correspondent: corr, created: '2021-12-31' }, { actor: 'user', actorId: 1 });
      expect(updated.title).toBe('Renamed');
      expect(updated.modified).not.toBe(before.modified);
      const again = await backend.getDocument(scope, ids[4]);
      expect(again.title).toBe('Renamed');
      expect(again.tags).toEqual([tax]);
      expect(again.correspondent).toBe(corr);
      expect((again.created_date ?? again.created)?.slice(0, 10)).toBe('2021-12-31');
    });

    it('updates the text content', async () => {
      await backend.updateDocument(scope, ids[4], { content: 'New OCR text' }, { actor: 'system', ref: 'ocr' });
      expect((await backend.getDocument(scope, ids[4])).content).toBe('New OCR text');
    });

    it('counts documents with structured filters', async () => {
      expect(await backend.countDocuments(scope)).toBe(5);
      const invoice = await tagId('Invoice');
      const energy = await tagId('Energy');
      expect(await backend.countDocuments(scope, { tagsAll: [invoice, energy] })).toBe(2);
      const stadtwerke = (await meta.resolveCorrespondent('Stadtwerke', false)).id!;
      expect(await backend.countDocuments(scope, { correspondent: stadtwerke, createdYear: 2024, createdMonth: 4 })).toBe(1);
      expect(await backend.countDocuments(scope, { createdYear: 2024 })).toBe(3);
    });

    it('queries with filters, sort and pagination', async () => {
      const invoice = await tagId('Invoice');
      const first = await backend.queryDocuments(scope, { filter: {}, sort: 'title', limit: 2, withCount: true });
      expect(first.results.map((d) => d.title)).toEqual(['Car insurance policy', 'Electricity bill March']);
      expect(first.count).toBe(5);
      expect(first.nextCursor).toBeTruthy();
      const second = await backend.queryDocuments(scope, { filter: {}, sort: 'title', limit: 2, cursor: first.nextCursor });
      expect(second.results.map((d) => d.title)).toEqual(['Gas bill April', 'Tax assessment 2023']);
      const third = await backend.queryDocuments(scope, { filter: {}, sort: 'title', limit: 2, cursor: second.nextCursor });
      expect(third.results.map((d) => d.title)).toEqual(['Unsorted letter']);
      expect(third.nextCursor).toBeNull();

      const filtered = await backend.queryDocuments(scope, { filter: { tagsAny: [invoice], createdFrom: '2024-04-01' }, sort: '-created' });
      expect(filtered.results.map((d) => d.title)).toEqual(['Gas bill April']);
      const noCorrespondent = await backend.queryDocuments(scope, { filter: { correspondent: null }, sort: 'title' });
      expect(noCorrespondent.results.map((d) => d.title)).toEqual(['Unsorted letter']);
    });

    it('finds documents by full text', async () => {
      const res = await backend.queryDocuments(scope, { filter: { query: 'Allianz' } });
      expect(res.results.map((d) => d.id)).toEqual([ids[2]]);
      const page = await backend.searchDocuments(scope, { query: 'tax assessment' });
      expect(page.results.map((d) => d.id)).toContain(ids[3]);
    });

    it('filters by words in the title / the text, words to leave out, excluded correspondents and types (search syntax)', async () => {
      const titles = async (filter: Parameters<DocumentBackend['queryDocuments']>[1]['filter']) =>
        (await backend.queryDocuments(scope, { filter, sort: 'title' })).results.map((d) => d.title);
      expect(await titles({ titleQuery: 'bill' })).toEqual(['Electricity bill March', 'Gas bill April']);
      // "insurance" is in the title of one and the text of the same – "invoice" only in texts
      expect(await titles({ titleQuery: 'invoice' })).toEqual([]);
      expect(await titles({ contentQuery: 'invoice' })).toEqual(['Electricity bill March', 'Gas bill April']);
      expect(await titles({ query: 'Stadtwerke', notQuery: 'gas' })).toEqual(['Electricity bill March']);
      const stadtwerke = (await meta.resolveCorrespondent('Stadtwerke', false)).id!;
      const contract = (await meta.resolveDocumentType('Contract', false)).id!;
      expect(await titles({ correspondentsNone: [stadtwerke] })).toEqual(['Car insurance policy', 'Tax assessment 2023', 'Unsorted letter']);
      expect(await titles({ documentTypesNone: [contract], createdFrom: '2024-01-01' })).toEqual(['Electricity bill March', 'Gas bill April', 'Tax assessment 2023']);
    });

    it('counts facets of a filter', async () => {
      const invoice = await tagId('Invoice');
      const f = await backend.facets(scope, { tagsAny: [invoice] });
      expect(f.total).toBe(2);
      expect(f.tags.find((t) => t.id === invoice)?.count).toBe(2);
      const stadtwerke = (await meta.resolveCorrespondent('Stadtwerke', false)).id!;
      expect(f.correspondents.find((c) => c.id === stadtwerke)?.count).toBe(2);
    });

    it('downloads the original file and a thumbnail', async () => {
      const file = await backend.download(scope, ids[0], { original: true });
      expect(file.data.byteLength).toBeGreaterThan(10);
      expect(file.contentType).toContain('pdf');
      const thumb = await backend.thumbnail(scope, ids[0]);
      expect(thumb.data.byteLength).toBeGreaterThan(0);
    });

    it('deletes documents', async () => {
      await backend.deleteDocument(scope, ids[4], { actor: 'user', actorId: 1 });
      const docs = await backend.listDocuments(scope, { fields: ['id'] });
      expect(docs.map((d) => d.id)).not.toContain(ids[4]);
      expect(statusOf(await backend.getDocument(scope, ids[4]).catch((e: unknown) => e))).toBe(404);
    });

    it('ingests a file', async () => {
      const res = await backend.ingest(scope, { data: PDF, filename: 'scan.pdf', mimeType: 'application/pdf' }, 'upload', { title: 'Scanned letter', tags: ['Inbox'] });
      expect(['stored', 'forwarded']).toContain(res.status);
      const docs = await backend.listDocuments(scope, { fields: ['id', 'title'] });
      expect(docs.map((d) => d.title)).toContain('Scanned letter');
    });

    it('creates metadata once under concurrency and renames / deletes it', async () => {
      const [a, b] = await Promise.all([meta.resolveTag('Brand new', true), meta.resolveTag('brand NEW', true)]);
      expect(a.id).toBe(b.id);
      const tags = await backend.metadataSource(meta.libraryId).tags();
      expect(tags.filter((t) => t.name.toLowerCase() === 'brand new')).toHaveLength(1);

      const energy = await tagId('Energy');
      await backend.updateMetadata(scope, 'tag', energy, { name: 'Utilities' });
      const renamed = (await backend.metadataSource(meta.libraryId).tags()).find((t) => t.id === energy);
      expect(renamed?.name).toBe('Utilities');
      await backend.deleteMetadata(scope, 'tag', energy);
      expect((await backend.metadataSource(meta.libraryId).tags()).some((t) => t.id === energy)).toBe(false);
      expect((await backend.getDocument(scope, ids[0])).tags).not.toContain(energy);
    });
  });
}
