/**
 * Performance fixture of the built-in archive: N synthetic documents (default 200,000) in five
 * libraries, Zipf-distributed words, correspondents, document types and tags like the benchmark in
 * docs/standalone/benchmarks/bench-sqlite.mjs – written with the real schema (migrations, triggers,
 * FTS columns), so the queries of LocalBackend run unchanged against it.
 *
 *   npm run fixture:archive -- --documents 200000 [--dir <data dir>] [--files]
 *
 * Without --files all documents share one small PDF (blobs are content addressed); with --files each
 * document gets its own generated PDF (≈ 1 KB each).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppContext } from '../../src/server/context.js';
import type { LocalBackend } from '../../src/server/archive/backend.js';
import { makePdf } from '../../test/helpers/pdf.js';

export interface FixtureOptions {
  documents: number;
  wordsPerDocument?: number;
  libraries?: number;
  files?: boolean;
}

export const DEFAULT_DIR = path.join(process.env.BENCH_DIR ?? os.tmpdir(), 'paperless-ai-perf');

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}

/** Context of a fixture directory in built-in mode (no setup, no AI needed for queries). */
export function fixtureContext(dir: string): AppContext {
  return new AppContext({
    dataDir: dir,
    env: { PAPERLESS_AI_ARCHIVE: 'builtin', PAPERLESS_AI_STORAGE_DIR: path.join(dir, 'storage'), LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
  });
}

// ---------------------------------------------------------------- synthetic data (bench-sqlite.mjs)
let seed = 42;
const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;
const SYLLABLES = ['be', 'ver', 'rech', 'nung', 'kun', 'di', 'gung', 'si', 'che', 'rung', 'an', 'trag', 'steu', 'er', 'bei', 'kon', 'to', 'lei', 'stung', 'zah', 'lung', 'frist', 'miet', 'strom', 'gas', 'auf', 'nah', 'me', 'ab', 'schluss', 'ein', 'gang', 'aus', 'zug', 'bank', 'post', 'amt', 'kas', 'se', 'ge', 'halt', 'lohn', 'ar', 'zt', 'kli', 'nik'];

function zipfCum(n: number, s: number): Float64Array {
  const c = new Float64Array(n);
  let a = 0;
  for (let r = 0; r < n; r++) c[r] = a += 1 / Math.pow(r + 1, s);
  return c;
}

function zipf(c: Float64Array): number {
  const x = rand() * c[c.length - 1];
  let lo = 0;
  let hi = c.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (c[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export function vocabulary(size = 60_000): string[] {
  seed = 42;
  const vocab = new Set<string>();
  while (vocab.size < size) {
    const n = 2 + Math.floor(rand() * 3);
    let w = '';
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    vocab.add(w + (vocab.size % 7 === 0 ? String(vocab.size % 97) : ''));
  }
  return [...vocab];
}

export interface FixtureInfo {
  documents: number;
  libraries: number[];
  /** Words by frequency rank (index 0 = most frequent). */
  words: string[];
  /** Tag ids by frequency rank, per library. */
  tags: Map<number, number[]>;
  correspondents: Map<number, number[]>;
  amountField: Map<number, number>;
}

export async function createArchiveFixture(dir: string, opts: FixtureOptions): Promise<FixtureInfo> {
  fs.mkdirSync(dir, { recursive: true });
  const ctx = fixtureContext(dir);
  const backend = ctx.archive() as LocalBackend;
  const db = ctx.db;
  const words = vocabulary();
  seed = 4242;
  const wordCum = zipfCum(words.length, 1.07);
  const libCount = opts.libraries ?? 5;
  const perDoc = opts.wordsPerDocument ?? 400;
  const now = Date.now();

  const libraries = [backend.ensureDefaultLibrary()];
  while (libraries.length < libCount) libraries.push(ctx.repos.libraries.create(`Library ${libraries.length + 1}`, null, {}));

  // Metadata per library: 600 correspondents, 40 types, 60 tags, one amount field.
  const tags = new Map<number, number[]>();
  const correspondents = new Map<number, number[]>();
  const types = new Map<number, number[]>();
  const amountField = new Map<number, number>();
  const names = new Map<string, string>();
  const insertNamed = (table: string, lib: number, name: string) => {
    const id = Number(db.prepare(`INSERT INTO ${table} (library_id, name, name_norm, created_at) VALUES (?, ?, ?, ?)`).run(lib, name, name.toLowerCase(), now).lastInsertRowid);
    names.set(`${table}/${id}`, name);
    return id;
  };
  db.transaction(() => {
    for (const lib of libraries) {
      correspondents.set(lib, Array.from({ length: 600 }, (_, i) => insertNamed('lib_correspondents', lib, `${words[i * 7 + 11]} GmbH ${i}`)));
      types.set(lib, Array.from({ length: 40 }, (_, i) => insertNamed('lib_document_types', lib, `Type ${i} ${words[i * 13 + 5]}`)));
      tags.set(lib, Array.from({ length: 60 }, (_, i) => insertNamed('lib_tags', lib, `tag-${i}-${words[i * 3 + 1]}`)));
      amountField.set(
        lib,
        Number(db.prepare("INSERT INTO lib_custom_fields (library_id, name, name_norm, data_type, created_at) VALUES (?, 'Amount', 'amount', 'monetary', ?)").run(lib, now).lastInsertRowid),
      );
    }
  })();
  const corrCum = zipfCum(600, 1.0);
  const typeCum = zipfCum(40, 1.0);
  const tagCum = zipfCum(60, 0.9);

  const sharedPdf = await backend.blobs.putBytes(makePdf([['Performance fixture']]));
  db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)').run(sharedPdf.sha256, sharedPdf.size, 'application/pdf', now);

  const insDoc = db.prepare(
    `INSERT INTO lib_documents (library_id, title, created, added, modified, correspondent_id, document_type_id, current_version, original_filename, mime_type, page_count, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'application/pdf', 1, 'import')`,
  );
  const insFile = db.prepare(
    "INSERT INTO lib_document_files (document_id, version, kind, blob_sha256, original_filename, mime_type, size, page_count, created_at) VALUES (?, 1, 'original', ?, ?, 'application/pdf', ?, 1, ?)",
  );
  const insText = db.prepare("INSERT INTO lib_document_text (document_id, version, text, source, updated_at) VALUES (?, 1, ?, 'import', ?)");
  const insTag = db.prepare('INSERT OR IGNORE INTO lib_document_tags (tag_id, document_id, library_id, created) VALUES (?, ?, ?, ?)');
  const insField = db.prepare('INSERT INTO lib_custom_field_values (document_id, field_id, value_num) VALUES (?, ?, ?)');
  const insFts = db.prepare('INSERT INTO lib_fts (rowid, title, body, meta) VALUES (?, ?, ?, ?)');
  const insBlob = db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)');

  const started = performance.now();
  const BATCH = 5000;
  for (let done = 0; done < opts.documents; ) {
    const n = Math.min(BATCH, opts.documents - done);
    const files = opts.files ? await Promise.all(Array.from({ length: n }, (_, i) => backend.blobs.putBytes(makePdf([[`Document ${done + i + 1}`]])))) : null;
    db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const lib = libraries[Math.floor(rand() * libraries.length)];
        const len = Math.max(20, Math.round(perDoc * (0.2 + rand() * 1.6)));
        const parts = new Array<string>(len);
        for (let w = 0; w < len; w++) parts[w] = words[zipf(wordCum)];
        const title = parts.slice(0, 4).join(' ');
        const created = new Date(Date.UTC(2005, 0, 1) + Math.floor(rand() * 21 * 365) * 86_400_000).toISOString().slice(0, 10);
        const added = new Date(now - Math.floor(rand() * 5 * 365 * 86_400_000)).toISOString();
        const corr = correspondents.get(lib)![zipf(corrCum)];
        const type = types.get(lib)![zipf(typeCum)];
        const filename = `scan-${done + i + 1}.pdf`;
        const id = Number(insDoc.run(lib, title, created, added, added, corr, type, filename).lastInsertRowid);
        const blob = files ? files[i] : sharedPdf;
        if (files) insBlob.run(blob.sha256, blob.size, 'application/pdf', now);
        insFile.run(id, blob.sha256, filename, blob.size, now);
        const text = parts.join(' ');
        insText.run(id, text, now);
        const docTags = new Set<number>();
        const nTags = 1 + Math.floor(rand() * 5);
        for (let t = 0; t < nTags; t++) docTags.add(tags.get(lib)![zipf(tagCum)]);
        for (const t of docTags) insTag.run(t, id, lib, created);
        if (rand() < 0.5) insField.run(id, amountField.get(lib)!, Math.round(rand() * 200_000) / 100);
        // The meta column like LocalBackend.refreshFts: names of correspondent, type and tags, file name.
        const meta = [names.get(`lib_correspondents/${corr}`), names.get(`lib_document_types/${type}`), ...[...docTags].map((t) => names.get(`lib_tags/${t}`)), filename].join(' · ');
        insFts.run(id, title, text, meta);
      }
    })();
    done += n;
    if (done % 20_000 === 0 || done === opts.documents) {
      process.stdout.write(`\r  ${done.toLocaleString('en')} / ${opts.documents.toLocaleString('en')} documents (${((performance.now() - started) / 1000).toFixed(0)} s)`);
    }
  }
  process.stdout.write('\n');
  db.exec('ANALYZE');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const info: FixtureInfo = { documents: opts.documents, libraries, words, tags, correspondents, amountField };
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ documents: opts.documents, libraries, tags: [...tags], correspondents: [...correspondents], amountField: [...amountField] }));
  await backend.close?.();
  ctx.db.close();
  ctx.indexDb.close();
  return info;
}

/** The info of an existing fixture, or null. */
export function readFixture(dir: string): FixtureInfo | null {
  const file = path.join(dir, 'fixture.json');
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { documents: number; libraries: number[]; tags: [number, number[]][]; correspondents: [number, number[]][]; amountField: [number, number][] };
  return { documents: raw.documents, libraries: raw.libraries, words: vocabulary(), tags: new Map(raw.tags), correspondents: new Map(raw.correspondents), amountField: new Map(raw.amountField) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const documents = Number(arg('documents', '200000'));
  const dir = arg('dir', DEFAULT_DIR)!;
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Creating ${documents.toLocaleString('en')} documents in ${dir} …`);
  const t = performance.now();
  await createArchiveFixture(dir, { documents, files: arg('files') === 'true' });
  console.log(`Done in ${((performance.now() - t) / 1000).toFixed(0)} s`);
}
