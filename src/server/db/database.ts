import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { logger } from '../logger.js';

export type Db = BetterSqlite3.Database;
const log = logger.child({ module: 'db' });

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) =>
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT NOT NULL,
          token_version INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Processing state per Paperless document
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY,
          title TEXT,
          status TEXT NOT NULL CHECK (status IN ('processed', 'failed', 'skipped')),
          reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          modified TEXT,
          processed_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX documents_status ON documents(status);
        CREATE INDEX documents_processed_at ON documents(processed_at);

        -- Every change the AI applied to a document (enables undo)
        CREATE TABLE history (
          id INTEGER PRIMARY KEY,
          document_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          title TEXT,
          correspondent TEXT,
          document_type TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          before TEXT NOT NULL DEFAULT '{}',
          after TEXT NOT NULL DEFAULT '{}',
          suggestion TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER,
          reverted_at INTEGER
        );
        CREATE INDEX history_document ON history(document_id);
        CREATE INDEX history_created ON history(created_at);

        -- Token usage of every AI call
        CREATE TABLE usage (
          id INTEGER PRIMARY KEY,
          created_at INTEGER NOT NULL,
          feature TEXT NOT NULL,
          document_id INTEGER,
          provider TEXT,
          model TEXT,
          prompt_tokens INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER
        );
        CREATE INDEX usage_created ON usage(created_at);
        CREATE INDEX usage_feature ON usage(feature);

        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `),
  },
  {
    version: 2,
    name: 'rag index',
    up: (db) =>
      db.exec(`
        CREATE TABLE rag_documents (
          id INTEGER PRIMARY KEY,
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

        CREATE TABLE rag_chunks (
          id INTEGER PRIMARY KEY,
          document_id INTEGER NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
          idx INTEGER NOT NULL,
          text TEXT NOT NULL,
          embedding BLOB
        );
        CREATE INDEX rag_chunks_document ON rag_chunks(document_id, idx);

        -- Full text index; rowid = rag_chunks.id. Contentless: text lives in rag_chunks only.
        CREATE VIRTUAL TABLE rag_fts USING fts5(
          meta, body,
          content = '',
          contentless_delete = 1,
          tokenize = 'unicode61 remove_diacritics 2'
        );
      `),
  },
  {
    version: 3,
    name: 'rag pending embeddings index',
    // Finding/counting passages without embedding must not scan the whole (large) chunk table.
    up: (db) => db.exec(`CREATE INDEX rag_chunks_pending ON rag_chunks(id) WHERE embedding IS NULL;`),
  },
];

export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
    })();
    log.info(`Applied database migration ${m.version} (${m.name})`);
  }
}

/** Parse SQLite DATETIME text (UTC, "YYYY-MM-DD HH:MM:SS") into epoch millis. */
function sqliteDate(value: unknown): number {
  if (typeof value !== 'string' || !value) return Date.now();
  const t = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Import data from the database used by Paperless-AI ≤ 3.x (data/documents.db).
 * The legacy file is opened read-only and left untouched.
 */
export function importLegacyDatabase(db: Db, legacyFile: string): boolean {
  if (!fs.existsSync(legacyFile)) return false;
  const done = db.prepare(`SELECT value FROM kv WHERE key = 'legacy_import'`).get() as { value: string } | undefined;
  if (done) return false;

  let legacy: Db | undefined;
  try {
    legacy = new BetterSqlite3(legacyFile, { readonly: true, fileMustExist: true });
    const tables = new Set(
      (legacy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name),
    );
    const all = <T>(sql: string): T[] => (legacy!.prepare(sql).all() as T[]) ?? [];
    const now = Date.now();
    const counts = { users: 0, documents: 0, history: 0, usage: 0 };

    db.transaction(() => {
      if (tables.has('users')) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        );
        for (const u of all<{ username: string; password: string; created_at: string }>('SELECT * FROM users')) {
          if (!u.username || !u.password) continue;
          counts.users += insert.run(u.username, u.password, sqliteDate(u.created_at), now).changes;
        }
      }
      if (tables.has('processed_documents')) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO documents (id, title, status, attempts, processed_at, updated_at) VALUES (?, ?, 'processed', 1, ?, ?)`,
        );
        for (const d of all<{ document_id: number; title: string; processed_at: string }>('SELECT * FROM processed_documents')) {
          counts.documents += insert.run(d.document_id, d.title ?? null, sqliteDate(d.processed_at), now).changes;
        }
      }
      if (tables.has('history_documents')) {
        const originals = new Map<number, { title: string; tags: string; correspondent: string | null }>();
        if (tables.has('original_documents')) {
          for (const o of all<{ document_id: number; title: string; tags: string; correspondent: string | null }>(
            'SELECT * FROM original_documents ORDER BY id ASC',
          )) {
            if (!originals.has(o.document_id)) originals.set(o.document_id, o);
          }
        }
        const insert = db.prepare(
          `INSERT INTO history (document_id, created_at, source, title, correspondent, tags, before, after)
           VALUES (?, ?, 'legacy', ?, ?, ?, ?, ?)`,
        );
        for (const h of all<{ document_id: number; tags: string; title: string; correspondent: string; created_at: string }>(
          'SELECT * FROM history_documents ORDER BY id ASC',
        )) {
          const tags = safeJsonArray(h.tags);
          const orig = originals.get(h.document_id);
          const before = orig
            ? {
                title: orig.title,
                tags: safeJsonArray(orig.tags),
                correspondent: orig.correspondent ? Number(orig.correspondent) || null : null,
              }
            : {};
          insert.run(
            h.document_id,
            sqliteDate(h.created_at),
            h.title ?? null,
            h.correspondent ?? null,
            JSON.stringify(tags),
            JSON.stringify(before),
            JSON.stringify({ title: h.title, tags }),
          );
          counts.history++;
        }
      }
      if (tables.has('openai_metrics')) {
        const insert = db.prepare(
          `INSERT INTO usage (created_at, feature, document_id, prompt_tokens, completion_tokens, total_tokens)
           VALUES (?, 'process', ?, ?, ?, ?)`,
        );
        for (const m of all<{ document_id: number; promptTokens: number; completionTokens: number; totalTokens: number; created_at: string }>(
          'SELECT * FROM openai_metrics',
        )) {
          insert.run(sqliteDate(m.created_at), m.document_id, m.promptTokens ?? 0, m.completionTokens ?? 0, m.totalTokens ?? 0);
          counts.usage++;
        }
      }
      db.prepare(`INSERT INTO kv (key, value) VALUES ('legacy_import', ?)`).run(JSON.stringify({ at: now, ...counts }));
    })();
    log.info(counts, 'Imported data from legacy documents.db');
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to import legacy documents.db (continuing without it)');
    return false;
  } finally {
    legacy?.close();
  }
}

function safeJsonArray(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}
