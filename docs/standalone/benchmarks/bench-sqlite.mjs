// 200k synthetic documents in SQLite: list views, filters, permissions, FTS5, inserts.
// Usage: node bench-sqlite.mjs [documents=200000] [wordsPerDocument=400]   (Node ≥ 22.13, built-in node:sqlite)
// The database is written to $BENCH_DIR or the OS temp directory (~1.5 GB) and deleted afterwards.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const N = Number(process.argv[2] ?? 200_000);
const WORDS_PER_DOC = Number(process.argv[3] ?? 400);
const file = path.join(process.env.BENCH_DIR ?? os.tmpdir(), 'paperless-ai-bench.db');
for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });

// ---------------------------------------------------------------- synthetic data
let seed = 42;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
const syl = ['be', 'ver', 'rech', 'nung', 'kun', 'di', 'gung', 'ver', 'si', 'che', 'rung', 'an', 'trag', 'steu', 'er', 'bei', 'trag', 'kon', 'to', 'lei', 'stung', 'zah', 'lung', 'frist', 'ver', 'trag', 'miet', 'strom', 'gas', 'auf', 'nah', 'me', 'ab', 'schluss', 'ein', 'gang', 'aus', 'zug', 'bank', 'post', 'amt', 'kas', 'se', 'ge', 'halt', 'lohn', 'ar', 'zt', 'kli', 'nik'];
const VOCAB = 60_000;
const vocab = new Set();
while (vocab.size < VOCAB) {
  const n = 2 + Math.floor(rand() * 3);
  let w = '';
  for (let i = 0; i < n; i++) w += syl[Math.floor(rand() * syl.length)];
  vocab.add(w + (vocab.size % 7 === 0 ? String(vocab.size % 97) : ''));
}
const words = [...vocab];
const cum = new Float64Array(VOCAB);
let acc = 0;
for (let r = 0; r < VOCAB; r++) cum[r] = acc += 1 / Math.pow(r + 1, 1.07);
function zipf(arr, c) {
  const x = rand() * c[c.length - 1];
  let lo = 0, hi = c.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (c[m] < x) lo = m + 1;
    else hi = m;
  }
  return arr ? arr[lo] : lo;
}
function zipfCum(n, s) {
  const c = new Float64Array(n);
  let a = 0;
  for (let r = 0; r < n; r++) c[r] = a += 1 / Math.pow(r + 1, s);
  return c;
}
const corrCum = zipfCum(3000, 1.0);
const typeCum = zipfCum(40, 1.0);
const tagCum = zipfCum(300, 0.9);

// ---------------------------------------------------------------- schema
const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;
  PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA mmap_size = 268435456;

  CREATE TABLE lib_documents (
    id INTEGER PRIMARY KEY, library_id INTEGER NOT NULL, title TEXT NOT NULL, created TEXT NOT NULL,
    added INTEGER NOT NULL, modified INTEGER NOT NULL, correspondent_id INTEGER, document_type_id INTEGER,
    deleted_at INTEGER
  );
  CREATE TABLE lib_document_content (document_id INTEGER PRIMARY KEY, content TEXT NOT NULL);
  CREATE TABLE lib_document_tags (tag_id INTEGER NOT NULL, document_id INTEGER NOT NULL, PRIMARY KEY (tag_id, document_id)) WITHOUT ROWID;
  CREATE TABLE lib_cf_values (document_id INTEGER NOT NULL, field_id INTEGER NOT NULL, value_num REAL, value_text TEXT, value_date TEXT,
    PRIMARY KEY (document_id, field_id)) WITHOUT ROWID;
  CREATE VIRTUAL TABLE lib_fts USING fts5(title, content, content = '', contentless_delete = 1,
    tokenize = 'unicode61 remove_diacritics 2', prefix = '3');
`);

const insDoc = db.prepare('INSERT INTO lib_documents VALUES (?,?,?,?,?,?,?,?,NULL)');
const insContent = db.prepare('INSERT INTO lib_document_content VALUES (?,?)');
const insTag = db.prepare('INSERT OR IGNORE INTO lib_document_tags VALUES (?,?)');
const insCf = db.prepare('INSERT INTO lib_cf_values VALUES (?,?,?,NULL,NULL)');
const insFts = db.prepare('INSERT INTO lib_fts (rowid, title, content) VALUES (?,?,?)');

function makeDoc(id) {
  const len = Math.max(20, Math.round(WORDS_PER_DOC * (0.2 + rand() * 1.6)));
  const parts = new Array(len);
  for (let i = 0; i < len; i++) parts[i] = zipf(words, cum);
  const content = parts.join(' ');
  const title = parts.slice(0, 4).join(' ');
  const day = new Date(Date.UTC(2005, 0, 1) + Math.floor(rand() * 21 * 365) * 86400000).toISOString().slice(0, 10);
  return { id, library: 1 + Math.floor(rand() * 5), title, content, day, corr: 1 + zipf(null, corrCum), type: 1 + zipf(null, typeCum) };
}

function insert(doc) {
  insDoc.run(doc.id, doc.library, doc.title, doc.day, Date.now(), Date.now(), doc.corr, doc.type);
  insContent.run(doc.id, doc.content);
  const nTags = 1 + Math.floor(rand() * 5);
  for (let t = 0; t < nTags; t++) insTag.run(1 + zipf(null, tagCum), doc.id);
  if (rand() < 0.5) insCf.run(doc.id, 1, Math.round(rand() * 200000) / 100);
  insFts.run(doc.id, doc.title, doc.content);
}

let t0 = performance.now();
db.exec('BEGIN');
for (let id = 1; id <= N; id++) {
  insert(makeDoc(id));
  if (id % 20000 === 0) {
    db.exec('COMMIT; BEGIN');
  }
}
db.exec('COMMIT');
console.log(`Bulk insert of ${N.toLocaleString('en')} documents (incl. FTS): ${((performance.now() - t0) / 1000).toFixed(1)} s`);

t0 = performance.now();
db.exec(`
  CREATE INDEX docs_lib_created ON lib_documents (library_id, created DESC, id DESC) WHERE deleted_at IS NULL;
  CREATE INDEX docs_created ON lib_documents (created DESC, id DESC) WHERE deleted_at IS NULL;
  CREATE INDEX docs_corr ON lib_documents (correspondent_id, created DESC);
  CREATE INDEX docs_type ON lib_documents (document_type_id, created DESC);
  CREATE INDEX doc_tags_doc ON lib_document_tags (document_id, tag_id);
  CREATE INDEX cf_num ON lib_cf_values (field_id, value_num);
  ANALYZE;
`);
console.log(`Indexes + ANALYZE: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

// ---------------------------------------------------------------- queries
function bench(label, sql, params = [], runs = 7) {
  const st = db.prepare(sql);
  let rows = st.all(...params);
  const t = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    rows = st.all(...params);
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((r) => r.detail).join(' | ');
  console.log(`${t[runs >> 1].toFixed(2).padStart(8)} ms  ${String(rows.length).padStart(6)} rows  ${label}`);
  if (process.env.PLAN) console.log(`             plan: ${plan}`);
  return rows;
}

const common = words[30], medium = words[3000], rare = words[40000];
const ftsCount = (w) => db.prepare('SELECT count(*) c FROM lib_fts WHERE lib_fts MATCH ?').get(`"${w}"`).c;
console.log(`\nterm frequency (docs): common=${ftsCount(common)}, medium=${ftsCount(medium)}, rare=${ftsCount(rare)}`);
const topTag = 1, midTag = 80;
console.log(`tag frequency (docs): top=${db.prepare('SELECT count(*) c FROM lib_document_tags WHERE tag_id=?').get(topTag).c}, mid=${db.prepare('SELECT count(*) c FROM lib_document_tags WHERE tag_id=?').get(midTag).c}\n`);

const COLS = 'd.id, d.title, d.created, d.correspondent_id, d.document_type_id';
console.log('--- list views (user may see libraries 1 and 2 = ~40 % of the archive)');
bench('newest 50, one library', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id = 1 AND d.deleted_at IS NULL ORDER BY d.created DESC, d.id DESC LIMIT 50`);
bench('newest 50, library IN (1,2)', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL ORDER BY d.created DESC, d.id DESC LIMIT 50`);
bench('newest 50, all docs (admin)', `SELECT ${COLS} FROM lib_documents d WHERE d.deleted_at IS NULL ORDER BY d.created DESC, d.id DESC LIMIT 50`);
bench('page 600 via OFFSET 30000', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL ORDER BY d.created DESC, d.id DESC LIMIT 50 OFFSET 30000`);
bench('page 600 via keyset', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL AND (d.created, d.id) < ('2012-06-01', 999999) ORDER BY d.created DESC, d.id DESC LIMIT 50`);
bench('count, library IN (1,2)', `SELECT count(*) FROM lib_documents d WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL`);

console.log('--- filters');
bench('tag (very common) + perms, newest 50', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL AND EXISTS (SELECT 1 FROM lib_document_tags t WHERE t.document_id = d.id AND t.tag_id = ?) ORDER BY d.created DESC, d.id DESC LIMIT 50`, [topTag]);
bench('tag (mid) + perms, newest 50', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL AND d.id IN (SELECT document_id FROM lib_document_tags WHERE tag_id = ?) ORDER BY d.created DESC, d.id DESC LIMIT 50`, [midTag]);
bench('2 tags AND + correspondent + perms', `SELECT ${COLS} FROM lib_documents d WHERE d.library_id IN (1,2) AND d.correspondent_id = 1 AND d.id IN (SELECT document_id FROM lib_document_tags WHERE tag_id IN (1, 2) GROUP BY document_id HAVING count(*) = 2) ORDER BY d.created DESC LIMIT 50`);
bench('count, tag (very common) + perms', `SELECT count(*) FROM lib_documents d JOIN lib_document_tags t ON t.document_id = d.id AND t.tag_id = ? WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL`, [topTag]);
bench('custom field amount > 1500, by amount', `SELECT ${COLS}, v.value_num FROM lib_cf_values v JOIN lib_documents d ON d.id = v.document_id WHERE v.field_id = 1 AND v.value_num > 1500 AND d.library_id IN (1,2) ORDER BY v.value_num DESC LIMIT 50`);
bench('facets: doc count per tag (perms)', `SELECT t.tag_id, count(*) n FROM lib_document_tags t JOIN lib_documents d ON d.id = t.document_id WHERE d.library_id IN (1,2) AND d.deleted_at IS NULL GROUP BY t.tag_id`);

console.log('--- full text (FTS5, bm25, top 50, permission filter)');
const fts = (label, q) =>
  bench(label, `SELECT ${COLS}, bm25(lib_fts, 3.0, 1.0) AS rank FROM lib_fts f JOIN lib_documents d ON d.id = f.rowid WHERE lib_fts MATCH ? AND d.library_id IN (1,2) AND d.deleted_at IS NULL ORDER BY rank LIMIT 50`, [q]);
fts(`rare term "${rare}"`, `"${rare}"`);
fts(`medium term "${medium}"`, `"${medium}"`);
fts(`common term "${common}"`, `"${common}"`);
fts('medium AND common', `"${medium}" "${common}"`);
fts('prefix (3 chars) on medium term', `"${medium.slice(0, 3)}"*`);
bench('FTS count for common term', `SELECT count(*) FROM lib_fts WHERE lib_fts MATCH ?`, [`"${common}"`]);

console.log('--- writes');
t0 = performance.now();
db.exec('BEGIN');
for (let i = 1; i <= 1000; i++) insert(makeDoc(N + i));
db.exec('COMMIT');
console.log(`1,000 new documents in one transaction (incl. FTS): ${(performance.now() - t0).toFixed(0)} ms`);
t0 = performance.now();
for (let i = 1; i <= 200; i++) {
  db.exec('BEGIN');
  db.prepare('UPDATE lib_documents SET title = ?, modified = ? WHERE id = ?').run('x' + i, Date.now(), i * 7);
  db.exec('COMMIT');
}
console.log(`200 single-row updates, one transaction each: ${(performance.now() - t0).toFixed(0)} ms`);

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const size = (name) => db.prepare(`SELECT sum(pgsize) s FROM dbstat WHERE name LIKE ?`).get(name)?.s ?? 0;
let dbstat = true;
try { size('x'); } catch { dbstat = false; }
console.log(`\nDB file: ${(fs.statSync(file).size / 2 ** 20).toFixed(0)} MiB`);
if (dbstat) {
  console.log(`  content: ${(size('lib_document_content') / 2 ** 20).toFixed(0)} MiB, fts: ${(size('lib_fts%') / 2 ** 20).toFixed(0)} MiB, documents+indexes: ${((size('lib_documents') + size('docs_%')) / 2 ** 20).toFixed(0)} MiB`);
}
db.close();
for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
