/**
 * Search and scale paths of the built-in archive that only kick in with large archives, triggered
 * here with small thresholds: bounded bm25 ranking, tag strategies, counters, FTS rebuild.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/appHarness.js';
import { makePdf } from '../helpers/pdf.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { SYSTEM_SCOPE, type AccessScope } from '../../src/server/access/scope.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ archive: 'builtin' });
});
afterEach(() => h.close());

const local = () => h.ctx.archive() as LocalBackend;
let n = 0;
async function add(libraryId: number, lines: string[], tags: string[] = []): Promise<number> {
  const r = await local().ingest(SYSTEM_SCOPE, { data: makePdf([[...lines, `unique ${++n}`]]), filename: `d${n}.pdf` }, 'api', { libraryId, tags, skipAnalysis: true, title: `Doc ${n}` });
  return r.documentId!;
}
const scopeOf = (libraryId: number): AccessScope => ({
  principal: { kind: 'user', userId: 99, username: 'm', role: 'member', via: 'session' },
  libraries: new Map([[libraryId, 'viewer']]),
  scopes: null,
});

describe('full text ranking of frequent terms', () => {
  it('ranks only the newest candidates, but falls back when filters leave too few', async () => {
    const main = local().ensureDefaultLibrary();
    const other = h.ctx.repos.libraries.create('Other', null, {});
    // The older documents belong to "Other"; the newest ones (largest ids) to the main library.
    const old = [await add(other, ['Rechnung Wasser']), await add(other, ['Rechnung Gas'])];
    for (let i = 0; i < 6; i++) await add(main, [`Rechnung Strom ${i}`]);
    local().rankCandidates = 3;

    const all = await local().queryDocuments(SYSTEM_SCOPE, { filter: { query: 'Rechnung' }, sort: 'relevance', limit: 2 });
    expect(all.results).toHaveLength(2);
    expect(all.nextCursor).toBeTruthy();

    // All pages use the ranking chosen on the first one: no document twice.
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await local().queryDocuments(SYSTEM_SCOPE, { filter: { query: 'Rechnung' }, sort: 'relevance', limit: 2, cursor });
      seen.push(...page.results.map((d) => d.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(3);

    // None of the newest three matches is in "Other": the unbounded ranking still finds them.
    const member = await local().queryDocuments(scopeOf(other), { filter: { query: 'Rechnung' }, sort: 'relevance', limit: 10 });
    expect(member.results.map((d) => d.id).sort()).toEqual(old.sort());
  });
});

describe('tag filters and counts', () => {
  it('give the same results whichever way the tag is looked up', async () => {
    const lib = local().ensureDefaultLibrary();
    for (let i = 0; i < 8; i++) await add(lib, [`Beleg ${i}`], i % 4 === 0 ? ['Selten', 'Oft'] : ['Oft']);
    const meta = h.ctx.metadata(lib);
    await meta.snapshot(true);
    const rare = (await meta.resolveTag('Selten', false)).id!;
    const often = (await meta.resolveTag('Oft', false)).id!;
    for (const tag of [rare, often]) {
      const list = await local().queryDocuments(SYSTEM_SCOPE, { filter: { tagsAll: [tag] }, withCount: true, limit: 50 });
      const count = await local().countDocuments(SYSTEM_SCOPE, { tagsAll: [tag] });
      const facets = await local().facets(SYSTEM_SCOPE, { tagsAll: [tag] });
      expect(list.count).toBe(tag === rare ? 2 : 8);
      expect(list.results).toHaveLength(list.count!);
      expect(count).toBe(list.count);
      expect(facets.total).toBe(list.count);
      expect(facets.tags.find((t) => t.id === tag)?.count).toBe(list.count);
    }
    // Unfiltered facets come from the counters and match a filtered recount.
    const unfiltered = await local().facets(SYSTEM_SCOPE, {});
    const recount = await local().facets(SYSTEM_SCOPE, { addedFrom: '1900-01-01' });
    expect(unfiltered.total).toBe(8);
    expect(unfiltered.tags.sort((a, b) => a.id - b.id)).toEqual(recount.tags.sort((a, b) => a.id - b.id));
    // Metadata lists use the counters as well.
    expect((await meta.snapshot(true)).tags.find((t) => t.id === often)?.document_count).toBe(8);
  });
});

describe('full text index rebuild', () => {
  it('refills lib_fts from the documents', async () => {
    const lib = local().ensureDefaultLibrary();
    const id = await add(lib, ['Kündigung Mietvertrag Leopoldstraße']);
    h.ctx.db.exec('DELETE FROM lib_fts');
    expect((await local().queryDocuments(SYSTEM_SCOPE, { filter: { query: 'Leopoldstraße' } })).results).toEqual([]);
    h.ctx.repos.kv.set('archive.fts_rebuild', true);
    expect(await local().rebuildFts()).toBe(1);
    expect(h.ctx.repos.kv.get('archive.fts_rebuild')).toBeUndefined();
    expect((await local().queryDocuments(SYSTEM_SCOPE, { filter: { query: 'Leopoldstraße' } })).results.map((d) => d.id)).toEqual([id]);
  });
});
