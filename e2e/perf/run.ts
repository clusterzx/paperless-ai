/**
 * Performance test of the built-in archive against the targets of
 * docs/standalone/search-and-scale.md §6: document lists, full text, facets, counts, vector
 * retrieval and the longest event loop block while many queries run at once.
 *
 *   npm run perf -- [--documents 200000] [--dir <data dir>] [--passages 250000] [--dims 768]
 *                   [--runs 15] [--readers <threads>] [--check] [--json <file>]
 *
 * The fixture is created on first use (see fixture.ts) and reused while --documents matches.
 * --check exits with 1 when a p95 is above its target.
 */
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { arg, createArchiveFixture, DEFAULT_DIR, fixtureContext, readFixture } from './fixture.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import type { DocumentFilter, DocumentQuery } from '../../src/server/backend/types.js';
import { SYSTEM_SCOPE, type AccessScope, type LibraryRole } from '../../src/server/access/scope.js';
import { VectorIndex } from '../../src/server/rag/vectorIndex.js';

const documents = Number(arg('documents', '200000'));
const dir = arg('dir', DEFAULT_DIR)!;
const passages = Number(arg('passages', '250000'));
const dims = Number(arg('dims', '768'));
const runs = Number(arg('runs', '15'));
const readers = arg('readers');
if (readers !== undefined) process.env.PAPERLESS_AI_READERS = readers;

type Group = 'list' | 'search' | 'facets' | 'retrieval' | 'info';
const TARGET: Record<Group, number | null> = { list: 50, search: 100, facets: 20, retrieval: 300, info: null };
interface Result {
  group: Group;
  label: string;
  p50: number;
  p95: number;
  detail?: string;
}
const results: Result[] = [];

async function measure(group: Group, label: string, fn: () => Promise<unknown> | unknown, detail?: (last: unknown) => string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 2; i++) last = await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    last = await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const pick = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
  const r: Result = { group, label, p50: pick(0.5), p95: pick(0.95), detail: detail?.(last) };
  results.push(r);
  const target = TARGET[group];
  const flag = target === null ? '      ' : r.p95 <= target ? '  ok  ' : ' SLOW ';
  console.log(`${r.p50.toFixed(1).padStart(8)} ${r.p95.toFixed(1).padStart(8)} ms ${flag} ${label}${r.detail ? `  (${r.detail})` : ''}`);
}

let info = readFixture(dir);
if (!info || info.documents !== documents) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Creating the fixture: ${documents.toLocaleString('en')} documents in ${dir} …`);
  info = await createArchiveFixture(dir, { documents });
}

const ctx = fixtureContext(dir);
const backend = ctx.archive() as LocalBackend;
console.log(`\n${documents.toLocaleString('en')} documents, ${info.libraries.length} libraries, ${backend.reader.threads} read worker(s), ${runs} runs each\n`);
console.log('     p50      p95');

const member: AccessScope = {
  principal: { kind: 'user', userId: 999, username: 'member', role: 'member', via: 'session' },
  libraries: new Map<number, LibraryRole>(info.libraries.slice(0, 2).map((l) => [l, 'viewer'])),
  scopes: null,
};
const lib = info.libraries[0];
const [topTag, , , secondTag] = info.tags.get(lib)!;
const rareTag = info.tags.get(lib)!.at(-1)!;
const topCorr = info.correspondents.get(lib)![0];
const words = info.words;
const query = (scope: AccessScope, q: Partial<DocumentQuery> & { filter: DocumentFilter }) => backend.queryDocuments(scope, { limit: 50, sort: '-created', ...q });
const n = (r: unknown) => `${(r as { results: unknown[] }).results.length} results`;

// ---------------------------------------------------------------- lists
await measure('list', 'Newest 50, all libraries', () => query(SYSTEM_SCOPE, { filter: {} }), n);
await measure('list', 'Newest 50, member of 2 libraries', () => query(member, { filter: {} }), n);
let cursor: string | null = null;
for (let i = 0; i < 20; i++) cursor = (await query(SYSTEM_SCOPE, { filter: {}, cursor })).nextCursor;
await measure('list', 'Page 21 (keyset cursor)', () => query(SYSTEM_SCOPE, { filter: {}, cursor }), n);
await measure('info', 'Page 600 by page number (OFFSET, pickers only)', () => query(SYSTEM_SCOPE, { filter: {}, page: 600 }), n);
await measure('list', 'Frequent tag, newest 50', () => query(SYSTEM_SCOPE, { filter: { tagsAll: [topTag] } }), n);
await measure('list', 'Rare tag, newest 50', () => query(SYSTEM_SCOPE, { filter: { tagsAll: [rareTag] } }), n);
await measure('list', 'Two tags AND + correspondent', () => query(SYSTEM_SCOPE, { filter: { tagsAll: [topTag, secondTag], correspondent: topCorr } }), n);
await measure('list', 'Amount ≥ 1500 (custom field)', () => query(SYSTEM_SCOPE, { filter: { customFields: [{ field: info.amountField.get(lib)!, op: 'gte', value: 1500 }] } }), n);
await measure('list', 'Sorted by title', () => query(SYSTEM_SCOPE, { filter: {}, sort: 'title' }), n);
await measure('list', 'Year 2015, member, with count', () => query(member, { filter: { createdYear: 2015 }, withCount: true }), (r) => `count ${(r as { count: number }).count}`);

// ---------------------------------------------------------------- full text
const search = (q: string, filter: DocumentFilter = {}, scope: AccessScope = SYSTEM_SCOPE) => query(scope, { filter: { ...filter, query: q }, sort: 'relevance' });
await measure('search', `Rare word "${words[40_000]}"`, () => search(words[40_000]), n);
await measure('search', `Medium word "${words[3000]}"`, () => search(words[3000]), n);
await measure('search', `Very common word "${words[30]}"`, () => search(words[30]), n);
await measure('search', 'Medium AND very common', () => search(`${words[3000]} ${words[30]}`), n);
await measure('search', `Four-letter prefix "${words[500].slice(0, 4)}"`, () => search(words[500].slice(0, 4)), n);
await measure('search', 'Medium word + tag, member', () => search(words[3000], { tagsAll: [topTag] }, member), n);
await measure('search', 'Medium word, sorted by date', () => query(SYSTEM_SCOPE, { filter: { query: words[3000] } }), n);

// ---------------------------------------------------------------- facets and counts
const facets = (filter: DocumentFilter, scope: AccessScope = SYSTEM_SCOPE) => backend.facets(scope, filter);
await measure('facets', 'Facets, no filter (counters)', () => facets({}), (r) => `total ${(r as { total: number }).total}`);
await measure('facets', 'Facets, no filter, member', () => facets({}, member), (r) => `total ${(r as { total: number }).total}`);
await measure('info', 'Facets, frequent tag', () => facets({ tagsAll: [topTag] }), (r) => `total ${(r as { total: number }).total}`);
await measure('info', 'Facets, rare tag', () => facets({ tagsAll: [rareTag] }), (r) => `total ${(r as { total: number }).total}`);
await measure('info', 'Facets, medium word', () => facets({ query: words[3000] }), (r) => `total ${(r as { total: number }).total}`);
await measure('facets', 'Count, no filter', () => backend.countDocuments(SYSTEM_SCOPE, {}));
await measure('info', 'Count, frequent tag', () => backend.countDocuments(SYSTEM_SCOPE, { tagsAll: [topTag] }));

// ---------------------------------------------------------------- event loop under load
{
  const h = monitorEventLoopDelay({ resolution: 5 });
  const mix = [
    () => query(SYSTEM_SCOPE, { filter: { tagsAll: [topTag] } }),
    () => search(words[30]),
    () => facets({ tagsAll: [topTag] }),
    () => backend.countDocuments(member, { tagsAll: [topTag] }),
    () => query(SYSTEM_SCOPE, { filter: {}, page: 600 }),
  ];
  h.enable();
  const t = performance.now();
  await Promise.all(Array.from({ length: 40 }, (_, i) => mix[i % mix.length]()));
  const wall = performance.now() - t;
  h.disable();
  const maxBlock = h.max / 1e6;
  results.push({ group: 'info', label: 'Longest event loop block, 40 heavy queries at once', p50: maxBlock, p95: maxBlock, detail: `${wall.toFixed(0)} ms wall` });
  const ok = maxBlock <= 50;
  console.log(`${maxBlock.toFixed(1).padStart(8)} ${maxBlock.toFixed(1).padStart(8)} ms ${ok ? '  ok  ' : ' SLOW '} Longest event loop block, 40 heavy queries at once  (${wall.toFixed(0)} ms wall)`);
  if (!ok) results.at(-1)!.group = 'list';
}

// ---------------------------------------------------------------- vectors
if (passages > 0) {
  console.log(`\nVector index: ${passages.toLocaleString('en')} passages × ${dims} dimensions …`);
  const index = new VectorIndex();
  let s = 7;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000) * 2 - 1;
  const BATCH = 10_000;
  for (let done = 0; done < passages; done += BATCH) {
    const items = Array.from({ length: Math.min(BATCH, passages - done) }, (_, i) => {
      const v = new Float32Array(dims);
      for (let d = 0; d < dims; d++) v[d] = r();
      return { id: done + i + 1, documentId: Math.floor((done + i) / 5) + 1, vector: v };
    });
    index.addMany(items);
  }
  console.log(`  memory ${(index.memoryBytes / 2 ** 20).toFixed(0)} MiB`);
  const q = new Float32Array(dims);
  for (let d = 0; d < dims; d++) q[d] = r();
  await measure('retrieval', 'Vector search, top 50', () => index.search(q, 50), (h) => `${(h as unknown[]).length} hits`);
  const allow = new Set(Array.from({ length: Math.floor(passages / 5) }, (_, i) => i + 1).filter((d) => d % 5 < 2));
  await measure('retrieval', 'Vector search, top 50, 40 % of documents allowed', () => index.search(q, 50, allow), (h) => `${(h as unknown[]).length} hits`);
}

await backend.close?.();
ctx.db.close();
ctx.indexDb.close();

const json = arg('json');
if (json) fs.writeFileSync(json, JSON.stringify({ documents, passages, dims, readers: backend.reader.threads, results }, null, 2));
const slow = results.filter((r) => TARGET[r.group] !== null && r.p95 > TARGET[r.group]!);
console.log(slow.length ? `\n${slow.length} operation(s) above target` : '\nAll targets met');
if (arg('check') === 'true' && slow.length) process.exit(1);
