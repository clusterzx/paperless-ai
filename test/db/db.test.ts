import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { importLegacyDatabase, migrate, openDatabase, type Db } from '../../src/server/db/database.js';
import { createRepos } from '../../src/server/db/repos.js';
import { AppContext } from '../../src/server/context.js';
import { verifyPassword } from '../../src/server/auth.js';
import { makeTempDir } from '../helpers/appHarness.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function memoryDb(): Db {
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  return db;
}

function tempDir(): string {
  const d = makeTempDir('paperless-ai-db-');
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Create a documents.db with the schema used by Paperless-AI ≤ 3.x. */
function createLegacyDb(file: string): void {
  const legacy = new BetterSqlite3(file);
  legacy.exec(`
    CREATE TABLE processed_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER UNIQUE,
      title TEXT,
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE openai_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      promptTokens INTEGER,
      completionTokens INTEGER,
      totalTokens INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE history_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      tags TEXT,
      title TEXT,
      correspondent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE original_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER,
      title TEXT,
      tags TEXT,
      correspondent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const pd = legacy.prepare('INSERT INTO processed_documents (document_id, title, processed_at) VALUES (?, ?, ?)');
  pd.run(10, 'Electricity bill', '2024-05-01 10:00:00');
  pd.run(11, 'Insurance policy', '2024-05-02 11:30:00');
  pd.run(12, null, 'garbage date');
  const m = legacy.prepare('INSERT INTO openai_metrics (document_id, promptTokens, completionTokens, totalTokens, created_at) VALUES (?, ?, ?, ?, ?)');
  m.run(10, 1000, 100, 1100, '2024-05-01 10:00:00');
  m.run(11, 2000, 200, 2200, '2024-05-02 11:30:00');
  const o = legacy.prepare('INSERT INTO original_documents (document_id, title, tags, correspondent) VALUES (?, ?, ?, ?)');
  o.run(10, 'scan_001.pdf', '[1, 2]', '7');
  o.run(10, 'later duplicate', '[]', null);
  o.run(11, 'scan_002.pdf', 'not json', null);
  const h = legacy.prepare('INSERT INTO history_documents (document_id, tags, title, correspondent, created_at) VALUES (?, ?, ?, ?, ?)');
  h.run(10, '[1, 2, 5]', 'Electricity bill', 'City Utilities', '2024-05-01 10:00:00');
  h.run(11, '["3"]', 'Insurance policy', 'Allianz', '2024-05-02 11:30:00');
  h.run(13, '[]', 'No original', null, '2024-05-03 09:00:00');
  const u = legacy.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
  u.run('olduser', bcrypt.hashSync('old-password', 4));
  u.run('', 'x');
  legacy.close();
}

describe('migrations', () => {
  it('creates the schema and records applied migrations', () => {
    const db = memoryDb();
    const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version);
    expect(versions).toEqual([1, 2]);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table')`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['users', 'documents', 'history', 'usage', 'kv', 'rag_documents', 'rag_chunks', 'rag_fts']) expect(tables).toContain(t);
  });

  it('is idempotent', () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect((db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c).toBe(2);
  });

  it('persists to a file and reopens without re-running migrations', () => {
    const file = path.join(tempDir(), 'sub', 'test.db');
    const db = openDatabase(file);
    createRepos(db).kv.set('hello', { a: 1 });
    db.close();
    const again = openDatabase(file);
    cleanup.push(() => again.close());
    expect(createRepos(again).kv.get('hello')).toEqual({ a: 1 });
  });
});

describe('legacy documents.db import', () => {
  it('imports users, processed documents, history and token usage once', async () => {
    const dir = tempDir();
    const legacyFile = path.join(dir, 'documents.db');
    createLegacyDb(legacyFile);
    const before = fs.readFileSync(legacyFile);

    const ctx = new AppContext({ dataDir: dir, env: {} });
    cleanup.push(() => ctx.close());
    const { repos } = ctx;

    // users (hash kept, so the old password keeps working)
    expect(repos.users.count()).toBe(1);
    const user = repos.users.byUsername('OLDUSER')!;
    expect(user.username).toBe('olduser');
    expect(await verifyPassword('old-password', user.password_hash)).toBe(true);

    // processing state
    const states = repos.documents.all();
    expect([...states.keys()].sort()).toEqual([10, 11, 12]);
    expect(repos.documents.get(10)).toMatchObject({ status: 'processed', title: 'Electricity bill', attempts: 1, processed_at: Date.parse('2024-05-01T10:00:00Z') });
    expect(repos.documents.get(12)!.processed_at).toBeGreaterThan(0);

    // history with undo information from original_documents (first entry wins)
    const history = repos.history.list({ sort: 'documentId', order: 'asc' });
    expect(history.total).toBe(3);
    const [h10, h11, h13] = history.items;
    expect(h10).toMatchObject({
      documentId: 10,
      source: 'legacy',
      title: 'Electricity bill',
      correspondent: 'City Utilities',
      tags: [1, 2, 5],
      before: { title: 'scan_001.pdf', tags: [1, 2], correspondent: 7 },
      canRevert: true,
      createdAt: Date.parse('2024-05-01T10:00:00Z'),
    });
    expect(h11).toMatchObject({ documentId: 11, tags: [3], before: { title: 'scan_002.pdf', tags: [], correspondent: null } });
    expect(h13).toMatchObject({ documentId: 13, before: {}, canRevert: false });

    // usage
    const usage = repos.usage.stats();
    expect(usage).toMatchObject({ calls: 2, promptTokens: 3000, completionTokens: 300, totalTokens: 3300, analyses: 2 });

    expect(repos.kv.get<{ users: number; documents: number; history: number; usage: number }>('legacy_import')).toMatchObject({
      users: 1,
      documents: 3,
      history: 3,
      usage: 2,
    });
    // the legacy file is untouched
    expect(fs.readFileSync(legacyFile).equals(before)).toBe(true);

    // a second import is a no-op
    expect(importLegacyDatabase(ctx.db, legacyFile)).toBe(false);
    expect(repos.history.list({}).total).toBe(3);
  });

  it('copes with missing tables and unreadable files', () => {
    const dir = tempDir();
    const partial = path.join(dir, 'partial.db');
    const legacy = new BetterSqlite3(partial);
    legacy.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, created_at DATETIME)');
    legacy.prepare('INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)').run('a', 'hash', '2023-01-01 00:00:00');
    legacy.close();
    const db = memoryDb();
    expect(importLegacyDatabase(db, partial)).toBe(true);
    expect(createRepos(db).users.count()).toBe(1);

    const broken = path.join(dir, 'broken.db');
    fs.writeFileSync(broken, 'this is not a sqlite database at all, just text');
    const db2 = memoryDb();
    expect(importLegacyDatabase(db2, broken)).toBe(false);
    expect(importLegacyDatabase(db2, path.join(dir, 'missing.db'))).toBe(false);
    expect(createRepos(db2).kv.get('legacy_import')).toBeUndefined();
  });
});

describe('repositories', () => {
  it('tracks processing state and attempts', () => {
    const { documents } = createRepos(memoryDb());
    expect(documents.markFailed(1, 'Doc', 'boom', 'm1')).toBe(1);
    expect(documents.markFailed(1, null, 'boom again', 'm1')).toBe(2);
    expect(documents.get(1)).toMatchObject({ status: 'failed', title: 'Doc', reason: 'boom again', attempts: 2 });
    documents.markProcessed(1, 'Doc done', 'm2');
    expect(documents.get(1)).toMatchObject({ status: 'processed', reason: null, modified: 'm2' });
    // failing again after success restarts counting
    expect(documents.markFailed(1, null, 'x', 'm3')).toBe(1);
    documents.markSkipped(2, 'Empty', 'no content', null);
    expect(documents.counts()).toEqual({ processed: 0, failed: 1, skipped: 1 });
    expect(documents.markFailed(3, null, 'r'.repeat(5000), null)).toBe(1);
    expect(documents.get(3)!.reason).toHaveLength(2000);
    expect(documents.reset([1, 2, 99])).toBe(2);
    expect(documents.resetAll()).toBe(1);
  });

  it('lists history with search, filters, sorting and pagination', () => {
    const { history } = createRepos(memoryDb());
    const add = (documentId: number, title: string, correspondent: string | null, tags: number[], source = 'scan') =>
      history.add({
        documentId,
        source,
        title,
        correspondent,
        documentType: title.split(' ')[0],
        tags,
        before: { title: 'orig' },
        after: { title },
      });
    add(1, 'Invoice 100% paid', 'ACME', [1, 2]);
    add(2, 'Invoice R_17', 'Beta', [2]);
    add(3, 'Contract', 'acme', [3], 'manual');
    add(4, 'Invoice RX17', null, []);

    expect(history.list({}).total).toBe(4);
    expect(history.list({ search: 'invoice' }).filtered).toBe(3);
    expect(history.list({ search: '3' }).items.map((i) => i.documentId)).toEqual([3]);
    // LIKE wildcards in the search are literal characters
    expect(history.list({ search: 'R_17' }).items.map((i) => i.documentId)).toEqual([2]);
    expect(history.list({ search: '100%' }).items.map((i) => i.documentId)).toEqual([1]);
    expect(history.list({ tag: 2 }).items.map((i) => i.documentId).sort()).toEqual([1, 2]);
    expect(history.list({ source: 'manual' }).items.map((i) => i.documentId)).toEqual([3]);
    expect(history.list({ correspondent: 'ACME' }).items.map((i) => i.documentId)).toEqual([1]);
    expect(history.list({ sort: 'title', order: 'asc' }).items.map((i) => i.title)).toEqual(['Contract', 'Invoice 100% paid', 'Invoice R_17', 'Invoice RX17']);
    const page2 = history.list({ page: 2, pageSize: 3, sort: 'documentId', order: 'asc' });
    expect(page2.items.map((i) => i.documentId)).toEqual([4]);
    expect(page2.filtered).toBe(4);
    expect(history.correspondents()).toEqual(['ACME', 'acme', 'Beta']);

    history.markReverted(1);
    expect(history.list({}).filtered).toBe(3);
    expect(history.list({ includeReverted: true }).filtered).toBe(4);
    expect(history.originalForDocument(1)).toBeUndefined();
    expect(history.latestForDocument(2)!.title).toBe('Invoice R_17');
    expect(history.documentTypeStats()).toEqual([
      { name: 'Invoice', count: 2 },
      { name: 'Contract', count: 1 },
    ]);
    expect(history.deleteForDocuments([2, 3])).toBe(2);
    expect(history.deleteAll()).toBe(2);
  });

  it('computes usage statistics', () => {
    const { usage } = createRepos(memoryDb());
    usage.add({ feature: 'process', promptTokens: 900, completionTokens: 50, totalTokens: 950, durationMs: 1000 });
    usage.add({ feature: 'manual', promptTokens: 3000, completionTokens: 100, totalTokens: 3100, durationMs: 3000 });
    usage.add({ feature: 'chat', promptTokens: 10, completionTokens: 10, totalTokens: 20 });
    const s = usage.stats();
    expect(s).toMatchObject({ calls: 3, totalTokens: 4070, analyses: 2, avgTotalTokens: 2025, avgDurationMs: 2000 });
    expect(s.distribution.find((d) => d.range === '0-1k')!.count).toBe(1);
    expect(s.distribution.find((d) => d.range === '2k-4k')!.count).toBe(1);
    expect(s.byFeature.find((f) => f.feature === 'chat')).toEqual({ feature: 'chat', calls: 1, tokens: 20 });
  });

  it('users are case-insensitive unique and password changes bump the token version', () => {
    const { users } = createRepos(memoryDb());
    const id = users.create('Alice', 'h1');
    expect(() => users.create('alice', 'h2')).toThrow();
    users.updatePassword(id, 'h3');
    expect(users.byId(id)).toMatchObject({ password_hash: 'h3', token_version: 1 });
  });
});
