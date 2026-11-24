/**
 * index.db: the search index of "Ask your archive" (passages, FTS, embeddings). Kept apart from the
 * core database: it is the largest part, changes all the time and can be rebuilt – the core stays
 * small to back up, vacuum and check (docs/standalone/data-model.md §1).
 */
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Db } from './database.js';
import { metaLine } from '../rag/store.js';
import { isQuantizedBlob, fromBlob, toBlob } from '../rag/vectorIndex.js';
import { logger } from '../logger.js';
import { localDay } from '../../shared/dates.js';

const log = logger.child({ module: 'db' });

const INDEX_MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'rag index',
    sql: `
      CREATE TABLE rag_documents (
        id INTEGER PRIMARY KEY,
        library_id INTEGER,
        modified TEXT,
        content_hash TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        correspondent TEXT,
        document_type TEXT,
        tags TEXT NOT NULL DEFAULT '',
        created TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX rag_documents_created ON rag_documents(created);
      CREATE INDEX rag_documents_library ON rag_documents(library_id) WHERE library_id IS NOT NULL;

      CREATE TABLE rag_chunks (
        id INTEGER PRIMARY KEY,
        document_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX rag_chunks_document ON rag_chunks(document_id, idx);
      CREATE INDEX rag_chunks_pending ON rag_chunks(id) WHERE embedding IS NULL;

      CREATE VIRTUAL TABLE rag_fts USING fts5(
        meta, body,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
];

export function openIndexDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = file === ':memory:' || !fs.existsSync(file);
  const db = new BetterSqlite3(file);
  if (fresh) db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.pragma('journal_size_limit = 67108864');
  if (file !== ':memory:') db.pragma('mmap_size = 268435456');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
  for (const m of INDEX_MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    })();
  }
  return db;
}

function hasTable(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * Move the search index of ≤ 4.4 (rag_* tables in paperless-ai.db) into index.db – once, embeddings
 * converted from float32 to int8 on the way. A copy of the database is written to data/backups/
 * first. Runs before anything uses the index.
 */
export function moveRagIndex(core: Db, index: Db, dataDir: string | null): void {
  if (!hasTable(core, 'rag_documents')) return;
  const docs = (core.prepare('SELECT COUNT(*) AS c FROM rag_documents').get() as { c: number }).c;
  if (docs > 0) {
    if (dataDir) {
      const dir = path.join(dataDir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `pre-index-move-${localDay()}.db`);
      if (!fs.existsSync(target)) core.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      // Keep the last three backups of moves.
      const old = fs.readdirSync(dir).filter((f) => f.startsWith('pre-index-move-')).sort();
      for (const f of old.slice(0, -3)) fs.rmSync(path.join(dir, f), { force: true });
    }
    const started = Date.now();
    log.info(`Moving the search index (${docs} documents) into index.db …`);
    index.transaction(() => {
      index.exec('DELETE FROM rag_fts; DELETE FROM rag_chunks; DELETE FROM rag_documents;');
      const insDoc = index.prepare(
        'INSERT INTO rag_documents (id, modified, content_hash, title, correspondent, document_type, tags, created, chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      type DocRow = { id: number; modified: string | null; content_hash: string; title: string; correspondent: string | null; document_type: string | null; tags: string; created: string | null; chunk_count: number; indexed_at: number };
      const metas = new Map<number, string>();
      for (const d of core.prepare('SELECT * FROM rag_documents').iterate() as Iterable<DocRow>) {
        insDoc.run(d.id, d.modified, d.content_hash, d.title, d.correspondent, d.document_type, d.tags, d.created, d.chunk_count, d.indexed_at);
        metas.set(d.id, metaLine({ title: d.title, correspondent: d.correspondent, documentType: d.document_type, tags: d.tags ? d.tags.split('\u001f') : [], created: d.created }));
      }
      const insChunk = index.prepare('INSERT INTO rag_chunks (id, document_id, idx, text, embedding) VALUES (?, ?, ?, ?, ?)');
      const insFts = index.prepare('INSERT INTO rag_fts (rowid, meta, body) VALUES (?, ?, ?)');
      for (const c of core.prepare('SELECT * FROM rag_chunks').iterate() as Iterable<{ id: number; document_id: number; idx: number; text: string; embedding: Buffer | null }>) {
        const emb = c.embedding && !isQuantizedBlob(c.embedding) ? toBlob(Float32Array.from(fromBlob(c.embedding))) : c.embedding;
        insChunk.run(c.id, c.document_id, c.idx, c.text, emb);
        insFts.run(c.id, metas.get(c.document_id) ?? '', c.text);
      }
    })();
    log.info(`Search index moved in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  core.exec('DROP TABLE IF EXISTS rag_fts; DROP TABLE IF EXISTS rag_chunks; DROP TABLE IF EXISTS rag_documents;');
}
