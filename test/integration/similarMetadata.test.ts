/**
 * Tags & metadata → Find duplicates: suggestions by the rules and by the AI, merging with a new
 * name, "not the same" is remembered.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE } from '../../src/server/access/scope.js';
import type { MetadataItem, SimilarMetadataGroup } from '../../src/shared/api.js';

let h: Harness;
afterEach(() => h.close());

describe('similar metadata', () => {
  it('suggests what means the same, merges it under a common name and remembers "not the same"', async () => {
    h = await createHarness({ archive: 'builtin' });
    const cookie = await h.login();
    const local = h.ctx.archive() as LocalBackend;
    local.ensureDefaultLibrary();
    const api = (method: 'GET' | 'POST', url: string, payload?: object) => h.inject({ method, url, headers: { cookie }, payload });
    for (const name of ['ADAC Versicherung', 'ABUniverse', 'Abuniverse Europe', 'Stadtwerke Köln', 'Stadtwerke München', '1&1', '1und1']) {
      expect((await api('POST', '/api/correspondents', { name })).statusCode).toBe(200);
    }
    const doc = (await local.ingest(SYSTEM_SCOPE, { data: makePdf([['Beitragsrechnung der ADAC Versicherung AG']]), filename: 'adac.pdf' }, 'upload', { correspondent: 'ADAC Versicherung AG', skipAnalysis: true })).documentId!;
    await h.engine.drain();
    const items = async () => (await api('GET', '/api/correspondents')).json() as MetadataItem[];
    const idOf = async (name: string) => (await items()).find((i) => i.name === name)!.id;

    const similar = async (path = 'correspondents') => ((await api('GET', `/api/${path}/similar`)).json() as { groups: SimilarMetadataGroup[] }).groups;
    const found = await similar();
    // Most documents first; different Stadtwerke and "1&1"/"1und1" are not thrown together by the rules.
    expect(found.map((g) => [g.suggested, [...g.names].sort(), g.reason])).toEqual([
      ['ADAC Versicherung', ['ADAC Versicherung', 'ADAC Versicherung AG'], 'same'],
      ['ABUniverse', ['ABUniverse', 'Abuniverse Europe'], 'same'],
    ]);

    // Merge: the document gets the one kept.
    const adac = found[0];
    const merged = await api('POST', '/api/correspondents/merge', { targetId: adac.keepId, sourceIds: adac.ids.slice(1) });
    expect(merged.json()).toMatchObject({ documents: 1 });
    expect((await local.getDocument(SYSTEM_SCOPE, doc)).correspondent).toBe(await idOf('ADAC Versicherung'));
    expect((await items()).map((i) => i.name)).not.toContain('ADAC Versicherung AG');

    // Merge under another name; a name that another object keeps is refused.
    const abu = found[1];
    const taken = await api('POST', '/api/correspondents/merge', { targetId: abu.keepId, sourceIds: abu.ids.slice(1), name: 'Stadtwerke Köln' });
    expect(taken.statusCode).toBe(400);
    expect(taken.json().error).toContain('exists already');
    await api('POST', '/api/correspondents/merge', { targetId: abu.keepId, sourceIds: abu.ids.slice(1), name: 'AB Universe' });
    expect((await items()).map((i) => i.name)).toEqual(['1&1', '1und1', 'AB Universe', 'ADAC Versicherung', 'Stadtwerke Köln', 'Stadtwerke München']);
    expect(await similar()).toEqual([]);

    // The AI finds more – only the names are sent; what the rules find is not repeated.
    h.llm.clearRequests();
    h.llm.reply(JSON.stringify({ groups: [{ names: ['1&1', '1und1'], canonical: '1&1' }, { names: ['Stadtwerke Köln', 'nonsense'], canonical: 'x' }] }));
    const ai = await api('POST', '/api/correspondents/similar/ai', {});
    expect(ai.statusCode, ai.body).toBe(200);
    const aiGroups = (ai.json() as { groups: SimilarMetadataGroup[] }).groups;
    expect(aiGroups.map((g) => [g.suggested, g.names, g.reason])).toEqual([['1&1', ['1&1', '1und1'], 'ai']]);
    expect(aiGroups[0].keepId).toBe(await idOf('1&1'));
    const sent = JSON.stringify(h.llm.chatRequests()[0].body);
    expect(sent).toContain('Stadtwerke M');
    expect(sent).not.toContain('Beitragsrechnung'); // no document content
    expect((h.ctx.db.prepare("SELECT COUNT(*) AS c FROM usage WHERE feature = 'metadata'").get() as { c: number }).c).toBe(1);

    // "Not the same" is remembered.
    for (const name of ['Rechnung', 'Rechnungen']) await api('POST', '/api/tags', { name });
    const tags = await similar('tags');
    expect(tags).toHaveLength(1);
    await api('POST', '/api/tags/similar/dismiss', { ids: tags[0].ids });
    expect(await similar('tags')).toEqual([]);
  });
});
