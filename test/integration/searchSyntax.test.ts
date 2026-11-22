/**
 * The search syntax of the document list through the API: names → ids of what the caller sees,
 * what each term was understood as, terms that match nothing, and bulk edits of "all matching".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import type { DocumentListResponse } from '../../src/shared/api.js';

let h: Harness;
afterEach(() => h.close());

describe('search syntax of the document list', () => {
  it('understands title:, text:, tag:, correspondent:, type:, created:, asn: and negation', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const local = h.ctx.archive() as LocalBackend;
    local.ensureDefaultLibrary();
    const add = async (name: string, lines: string[], hints: Record<string, unknown>) =>
      (await local.ingest(SYSTEM_SCOPE, { data: makePdf([lines]), filename: name }, 'upload', { skipAnalysis: true, ...hints })).documentId!;
    const strom = await add('strom.pdf', ['Stromrechnung März', 'Stadtwerke Overath'], { title: 'Stromrechnung März 2024', tags: ['Rechnung', 'Energie'], correspondent: 'Stadtwerke Overath', documentType: 'Rechnung', created: '2024-03-31' });
    const gas = await add('gas.pdf', ['Gasrechnung April', 'Stadtwerke Overath'], { title: 'Gasrechnung April 2024', tags: ['Rechnung', 'Energie', 'Erledigt'], correspondent: 'Stadtwerke Overath', documentType: 'Rechnung', created: '2024-04-30' });
    const kfz = await add('kfz.pdf', ['Beitragsrechnung Kfz-Versicherung'], { title: 'Kfz-Versicherung 2025', tags: ['Versicherung'], correspondent: 'ADAC Versicherung AG', documentType: 'Vertrag', created: '2025-01-15' });
    await h.engine.drain();
    h.ctx.db.prepare('UPDATE lib_documents SET archive_serial_number = 17 WHERE id = ?').run(kfz);

    const search = async (q: string) => {
      const res = (await h.inject({ method: 'GET', url: `/api/documents?q=${encodeURIComponent(q)}&sort=created`, headers: { cookie } })).json() as DocumentListResponse;
      return { ids: res.results.map((d) => d.id), search: res.search ?? [] };
    };
    expect((await search('tag:rechnung -tag:erledigt')).ids).toEqual([strom]);
    expect((await search('correspondent:stadtwerke created:2024-04')).ids).toEqual([gas]);
    expect((await search('from:adac')).ids).toEqual([kfz]); // part of the name
    expect((await search('type:vertrag')).ids).toEqual([kfz]);
    expect((await search('-type:vertrag')).ids).toEqual([strom, gas]);
    expect((await search('title:gasrechnung')).ids).toEqual([gas]);
    expect((await search('text:beitragsrechnung')).ids).toEqual([kfz]);
    expect((await search('rechnung -gas created:2024')).ids).toEqual([strom]);
    expect((await search('created:>2024-12-31')).ids).toEqual([kfz]);
    expect((await search('asn:17')).ids).toEqual([kfz]);

    // What each term was understood as – and a name that does not exist matches nothing.
    const understood = await search('tag:energ correspondent:"stadtwerke overath" created:2024');
    expect(understood.search).toEqual([
      { key: 'tag', value: 'energ', negate: false, matched: ['Energie'] },
      { key: 'correspondent', value: 'stadtwerke overath', negate: false, matched: ['Stadtwerke Overath'] },
      { key: 'created', value: '2024', negate: false, matched: ['2024-01-01 – 2024-12-31'] },
    ]);
    const unknown = await search('tag:urlaub');
    expect(unknown.ids).toEqual([]);
    expect(unknown.search[0]).toMatchObject({ key: 'tag', problem: 'No tag “urlaub”' });
    expect((await search('created:bald')).search[0].problem).toContain('Not a date');

    // Facets and "all matching" in bulk edits use the same interpretation.
    const facets = (await h.inject({ method: 'GET', url: `/api/documents/facets?q=${encodeURIComponent('tag:rechnung')}`, headers: { cookie } })).json() as { total: number };
    expect(facets.total).toBe(2);
    const bulk = await h.inject({ method: 'POST', url: '/api/documents/bulk', headers: { cookie }, payload: { filter: { q: 'tag:rechnung -tag:erledigt' }, action: 'edit', edit: { addTags: ['Geprüft'] } } });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect((await search('tag:geprüft')).ids).toEqual([strom]);
  });

  it('says what Paperless-ngx cannot do', async () => {
    h = await createHarness();
    const cookie = await h.login();
    h.paperless.addDocument({ id: 1, title: 'Stromrechnung', content: 'Strom Rechnung Stadtwerke' });
    h.paperless.addDocument({ id: 2, title: 'Gasrechnung', content: 'Gas Rechnung Stadtwerke' });
    const res = (await h.inject({ method: 'GET', url: `/api/documents?q=${encodeURIComponent('-title:gas -werbung')}`, headers: { cookie } })).json() as DocumentListResponse;
    expect(res.search?.map((t) => t.problem)).toEqual(['With Paperless-ngx, words can only be left out next to words to search for', 'Leaving out title words needs the built-in archive']);
    const ok = (await h.inject({ method: 'GET', url: `/api/documents?q=${encodeURIComponent('rechnung -gas title:strom')}`, headers: { cookie } })).json() as DocumentListResponse;
    expect(ok.results.map((d) => d.id)).toEqual([1]);
  });
});
