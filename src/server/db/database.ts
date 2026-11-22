import { ARCHIVE_SCHEMA, LIB_FTS } from '../archive/schema.js';
import { COUNTER_TRIGGERS, rebuildCounters, SORT_INDEXES } from '../archive/counters.js';
import { WORKFLOW_SCHEMA } from '../workflows/storage.js';
import { MIGRATION_SCHEMA } from '../migration/schema.js';
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
  {
    version: 4,
    name: 'ocr',
    up: (db) =>
      db.exec(`
        -- Heuristic quality of the text Paperless holds for each document
        CREATE TABLE ocr_documents (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          modified TEXT,
          created TEXT,
          pages INTEGER,
          chars INTEGER NOT NULL DEFAULT 0,
          score INTEGER NOT NULL DEFAULT 0,
          level TEXT NOT NULL CHECK (level IN ('missing', 'poor', 'fair', 'good')),
          reasons TEXT NOT NULL DEFAULT '[]',
          assessed_at INTEGER NOT NULL
        );
        CREATE INDEX ocr_documents_level ON ocr_documents(level, score);

        -- Latest PaddleOCR result per document
        CREATE TABLE ocr_results (
          document_id INTEGER PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('done', 'failed')),
          text TEXT,
          -- Text in Paperless before the OCR text replaced it (undo)
          previous_text TEXT,
          chars INTEGER,
          pages INTEGER,
          total_pages INTEGER,
          mean_score REAL,
          provider TEXT,
          duration_ms INTEGER,
          -- Paperless "modified" of the version that was read and after the write-back
          source_modified TEXT,
          written_modified TEXT,
          written_back INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          reverted_at INTEGER
        );
      `),
  },
  {
    version: 5,
    name: 'ocr quality comparison',
    up: (db) =>
      db.exec(`
        -- Text-quality score of the Paperless text before the OCR and of the OCR text
        ALTER TABLE ocr_results ADD COLUMN score_before INTEGER;
        ALTER TABLE ocr_results ADD COLUMN score_after INTEGER;
        -- 1 = the OCR text did not score better: Paperless keeps its text, the AI uses it too
        ALTER TABLE ocr_results ADD COLUMN kept_original INTEGER NOT NULL DEFAULT 0;
      `),
  },
  {
    version: 6,
    name: 'prompt library',
    up: (db) =>
      db.exec(`
        -- Prompts kept for later use, with the use case they were written for
        CREATE TABLE prompts (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          use_case TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          -- answers of the prompt wizard (JSON) when the prompt was made with it
          wizard TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        -- How well a prompt worked with a model
        CREATE TABLE prompt_ratings (
          id INTEGER PRIMARY KEY,
          prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
          provider TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          score INTEGER NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          -- ids of the documents of the test run (JSON array)
          documents TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX prompt_ratings_prompt ON prompt_ratings(prompt_id);
      `),
  },
  {
    version: 7,
    name: 'two-factor authentication',
    up: (db) =>
      db.exec(`
        -- TOTP secret (base32); without totp_enabled_at it is a set-up that was not confirmed yet
        ALTER TABLE users ADD COLUMN totp_secret TEXT;
        ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
        -- last accepted time step: a code cannot be used twice
        ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
        -- single-use recovery codes (scrypt hashes)
        CREATE TABLE recovery_codes (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_hash TEXT NOT NULL,
          used_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
      `),
  },
  {
    version: 8,
    name: 'calendar',
    up: (db) =>
      db.exec(`
        -- Appointments, due dates and deadlines found in documents
        CREATE TABLE calendar_events (
          id INTEGER PRIMARY KEY,
          document_id INTEGER NOT NULL,
          document_title TEXT,
          title TEXT NOT NULL,
          date TEXT NOT NULL,            -- YYYY-MM-DD
          time TEXT,                     -- HH:MM, NULL = all day
          kind TEXT NOT NULL DEFAULT 'other',
          dismissed_at INTEGER,          -- hidden by the user (stays hidden when the document is analysed again)
          created_at INTEGER NOT NULL
        );
        CREATE INDEX calendar_events_date ON calendar_events(date);
        CREATE INDEX calendar_events_document ON calendar_events(document_id);
        -- Documents searched for dates (analysis with the calendar switched on, or the scan)
        CREATE TABLE calendar_scans (
          document_id INTEGER PRIMARY KEY,
          scanned_at INTEGER NOT NULL,
          events INTEGER NOT NULL DEFAULT 0,
          error TEXT
        );
      `),
  },
  {
    version: 9,
    name: 'single sign-on',
    up: (db) =>
      db.exec(`
        -- Identity at the OpenID Connect provider (issuer + subject); accounts created by it have no password
        ALTER TABLE users ADD COLUMN oidc_issuer TEXT;
        ALTER TABLE users ADD COLUMN oidc_subject TEXT;
        CREATE UNIQUE INDEX users_oidc ON users(oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;
      `),
  },
  {
    version: 10,
    name: 'prompt rules',
    up: (db) =>
      db.exec(`
        -- The library prompt a document was processed with (prompt rules); the name stays when the prompt is deleted
        ALTER TABLE history ADD COLUMN prompt_id INTEGER;
        ALTER TABLE history ADD COLUMN prompt_name TEXT;
        CREATE INDEX history_prompt ON history(prompt_id) WHERE prompt_id IS NOT NULL;
      `),
  },
  {
    version: 11,
    name: 'roles, groups, api keys, libraries',
    up: (db) =>
      db.exec(`
        -- Instance roles. Existing accounts could do everything: they become admins.
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
        ALTER TABLE users ADD COLUMN display_name TEXT;
        ALTER TABLE users ADD COLUMN email TEXT;
        ALTER TABLE users ADD COLUMN disabled_at INTEGER;
        UPDATE users SET role = 'admin';

        CREATE TABLE groups (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          -- groups synchronised from the OIDC groups claim are not edited by hand
          oidc_name TEXT UNIQUE,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE group_members (
          group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (group_id, user_id)
        ) WITHOUT ROWID;
        CREATE INDEX group_members_user ON group_members(user_id);

        -- API keys per user: pai_<prefix>_<secret>; only the SHA-256 of the full key is stored.
        CREATE TABLE api_keys (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prefix TEXT NOT NULL,
          hash TEXT NOT NULL,
          scopes TEXT NOT NULL DEFAULT '["read"]',
          library_ids TEXT,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          expires_at INTEGER,
          revoked_at INTEGER
        );
        CREATE UNIQUE INDEX api_keys_prefix ON api_keys(prefix);
        CREATE INDEX api_keys_user ON api_keys(user_id);

        -- Libraries of the built-in archive with their members (users or groups) and roles.
        CREATE TABLE libraries (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          settings TEXT NOT NULL DEFAULT '{}',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE TABLE library_members (
          library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
          principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
          principal_id INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
          PRIMARY KEY (library_id, principal_type, principal_id)
        ) WITHOUT ROWID;
        CREATE INDEX library_members_principal ON library_members(principal_type, principal_id);

        -- Changes that are not document changes (users, roles, memberships, keys, settings).
        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY,
          at INTEGER NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id INTEGER,
          actor_name TEXT,
          action TEXT NOT NULL,
          target TEXT,
          library_id INTEGER,
          details TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX audit_log_at ON audit_log(at);
        CREATE INDEX audit_log_library ON audit_log(library_id, at) WHERE library_id IS NOT NULL;

        -- iCal feed per user: the random token in the URL is the key (looked up by its SHA-256).
        CREATE TABLE calendar_feeds (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          token TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        );

        -- Saved views of the document list (per user, optionally shared with a library).
        CREATE TABLE saved_views (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          library_id INTEGER,
          name TEXT NOT NULL,
          filter TEXT NOT NULL,
          columns TEXT NOT NULL DEFAULT '[]',
          sort TEXT,
          position INTEGER NOT NULL DEFAULT 0,
          in_navigation INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX saved_views_user ON saved_views(user_id, position);

        -- In-app notifications (workflow actions, intake failures, migration …).
        CREATE TABLE notifications (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          at INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          link TEXT,
          read_at INTEGER
        );
        CREATE INDEX notifications_user ON notifications(user_id, read_at, at);
      `),
  },
  {
    version: 12,
    name: 'built-in archive',
    up: (db) => db.exec(ARCHIVE_SCHEMA),
  },
  {
    version: 13,
    name: 'archive counters and sort indexes',
    up: (db) => {
      db.exec(SORT_INDEXES);
      db.exec(COUNTER_TRIGGERS);
      rebuildCounters(db);
      // lib_fts of the first archive schema had only the 3-letter prefix index: recreate it, the
      // archive refills it in the background on its next start (LocalBackend.rebuildFts).
      const fts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'lib_fts'").get() as { sql: string } | undefined;
      if (fts && !fts.sql.includes("prefix = '3 4'")) {
        db.exec(`DROP TABLE lib_fts; ${LIB_FTS};`);
        if (db.prepare('SELECT 1 FROM lib_documents LIMIT 1').get()) db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('archive.fts_rebuild', 'true')").run();
      }
    },
  },
  {
    version: 14,
    name: 'workflows',
    up: (db) => db.exec(WORKFLOW_SCHEMA),
  },
  {
    version: 15,
    name: 'migration from Paperless-ngx',
    up: (db) => db.exec(MIGRATION_SCHEMA),
  },
  {
    version: 16,
    name: 'import from Paperless-ngx with new ids',
    // The id of the imported document in the built-in archive when it differs from the ngx id
    // (an import into an archive with documents of its own); NULL = the same id.
    up: (db) => db.exec('ALTER TABLE migration_items ADD COLUMN local_id INTEGER; CREATE UNIQUE INDEX migration_items_local ON migration_items(local_id) WHERE local_id IS NOT NULL;'),
  },
  {
    version: 17,
    name: 'intake: default library, retry hints, only new e-mails',
    up: (db) =>
      db.exec(`
        -- The library a user's uploads go to when they do not choose one (NULL: the oldest one they can add to).
        ALTER TABLE users ADD COLUMN default_library_id INTEGER;
        -- The hints of an intake attempt (tags, title, mail sender …), so "Try again" keeps them.
        ALTER TABLE lib_intake ADD COLUMN hints TEXT;
        -- 1 = the first check skips the messages already in the folders (only new ones are read).
        ALTER TABLE intake_mail_accounts ADD COLUMN skip_existing INTEGER NOT NULL DEFAULT 0;
        -- Watch folders and mail accounts of libraries deleted before: they kept running.
        DELETE FROM intake_folders WHERE library_id IN (SELECT id FROM libraries WHERE deleted_at IS NOT NULL);
        DELETE FROM intake_mail_accounts WHERE library_id IN (SELECT id FROM libraries WHERE deleted_at IS NOT NULL);
      `),
  },
  {
    version: 18,
    name: 'API keys: delete, metadata and MCP scopes, rate limit',
    up: (db) => {
      // Requests per minute a key may make (NULL: no limit).
      db.exec('ALTER TABLE api_keys ADD COLUMN rate_limit INTEGER');
      // Deleting and managing labels were part of `write`: keys that could write keep them.
      const rows = db.prepare('SELECT id, scopes FROM api_keys').all() as { id: number; scopes: string }[];
      const update = db.prepare('UPDATE api_keys SET scopes = ? WHERE id = ?');
      for (const r of rows) {
        let scopes: string[];
        try {
          scopes = JSON.parse(r.scopes) as string[];
        } catch {
          continue;
        }
        if (!Array.isArray(scopes) || !scopes.includes('write')) continue;
        update.run(JSON.stringify([...new Set([...scopes, 'delete', 'metadata'])]), r.id);
      }
    },
  },
];

export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = file === ':memory:' || !fs.existsSync(file);
  const db = new BetterSqlite3(file);
  // Only possible before the first table exists; older databases switch with a one-time VACUUM.
  if (fresh) db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.pragma('journal_size_limit = 67108864');
  if (file !== ':memory:') db.pragma('mmap_size = 268435456');
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
          // Accounts of ≤ 3.x could do everything: they become admins.
          `INSERT OR IGNORE INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?)`,
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
