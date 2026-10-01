import type { Db } from './database.js';
import type { DocumentSnapshot, HistoryItem, HistoryQuery, UsageStats } from '../../shared/api.js';

// ---------------------------------------------------------------- users

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  token_version: number;
  created_at: number;
  updated_at: number;
}

export class UsersRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  }

  list(): Pick<UserRow, 'id' | 'username' | 'created_at'>[] {
    return this.db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all() as UserRow[];
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  byId(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  create(username: string, passwordHash: string): number {
    const now = Date.now();
    return Number(
      this.db
        .prepare('INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(username, passwordHash, now, now).lastInsertRowid,
    );
  }

  /** Changing the password also invalidates all existing sessions of that user. */
  updatePassword(id: number, passwordHash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?')
      .run(passwordHash, Date.now(), id);
  }

  rename(id: number, username: string): void {
    this.db.prepare('UPDATE users SET username = ?, updated_at = ? WHERE id = ?').run(username, Date.now(), id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------- processing state

export type DocumentStatus = 'processed' | 'failed' | 'skipped';

export interface DocumentStateRow {
  id: number;
  title: string | null;
  status: DocumentStatus;
  reason: string | null;
  attempts: number;
  modified: string | null;
  processed_at: number | null;
  updated_at: number;
}

export class DocumentsRepo {
  constructor(private readonly db: Db) {}

  get(id: number): DocumentStateRow | undefined {
    return this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentStateRow | undefined;
  }

  /** All states, used by the scanner to decide what still needs processing. */
  all(): Map<number, Pick<DocumentStateRow, 'status' | 'attempts' | 'modified' | 'reason'>> {
    const rows = this.db.prepare('SELECT id, status, attempts, modified, reason FROM documents').all() as DocumentStateRow[];
    return new Map(rows.map((r) => [r.id, r]));
  }

  markProcessed(id: number, title: string | null, modified: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO documents (id, title, status, reason, attempts, modified, processed_at, updated_at)
         VALUES (@id, @title, 'processed', NULL, 1, @modified, @now, @now)
         ON CONFLICT(id) DO UPDATE SET title = @title, status = 'processed', reason = NULL,
           attempts = attempts + 1, modified = @modified, processed_at = @now, updated_at = @now`,
      )
      .run({ id, title, modified, now });
  }

  markFailed(id: number, title: string | null, reason: string, modified: string | null): number {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO documents (id, title, status, reason, attempts, modified, updated_at)
         VALUES (@id, @title, 'failed', @reason, 1, @modified, @now)
         ON CONFLICT(id) DO UPDATE SET title = COALESCE(@title, title), status = 'failed', reason = @reason,
           attempts = CASE WHEN status = 'failed' THEN attempts + 1 ELSE 1 END, modified = @modified, updated_at = @now`,
      )
      .run({ id, title, reason: reason.slice(0, 2000), modified, now });
    return this.get(id)?.attempts ?? 1;
  }

  markSkipped(id: number, title: string | null, reason: string, modified: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO documents (id, title, status, reason, attempts, modified, updated_at)
         VALUES (@id, @title, 'skipped', @reason, 0, @modified, @now)
         ON CONFLICT(id) DO UPDATE SET title = COALESCE(@title, title), status = 'skipped', reason = @reason,
           modified = @modified, updated_at = @now`,
      )
      .run({ id, title, reason, modified, now });
  }

  /** Forget the processing state so the documents are picked up again by the next scan. */
  reset(ids: number[]): number {
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    return this.db.transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))();
  }

  resetAll(): number {
    return this.db.prepare('DELETE FROM documents').run().changes;
  }

  counts(): Record<DocumentStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM documents GROUP BY status').all() as {
      status: DocumentStatus;
      c: number;
    }[];
    const out: Record<DocumentStatus, number> = { processed: 0, failed: 0, skipped: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  list(status: DocumentStatus, limit = 200): DocumentStateRow[] {
    return this.db
      .prepare('SELECT * FROM documents WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
      .all(status, limit) as DocumentStateRow[];
  }

  lastProcessed(): DocumentStateRow | undefined {
    return this.db
      .prepare(`SELECT * FROM documents WHERE status = 'processed' ORDER BY processed_at DESC LIMIT 1`)
      .get() as DocumentStateRow | undefined;
  }

  processedSince(since: number): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM documents WHERE status = 'processed' AND processed_at >= ?`).get(since) as {
        c: number;
      }
    ).c;
  }

  /** Number of processed documents per day (local time) for the last `days` days. */
  timeline(days: number, tzOffsetMinutes: number): { date: string; count: number }[] {
    const since = Date.now() - days * 86_400_000;
    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', (processed_at / 1000) - (@tz * 60), 'unixepoch') AS date, COUNT(*) AS count
         FROM documents WHERE status = 'processed' AND processed_at >= @since GROUP BY date ORDER BY date`,
      )
      .all({ since, tz: tzOffsetMinutes }) as { date: string; count: number }[];
  }
}

// ---------------------------------------------------------------- history

export interface NewHistoryEntry {
  documentId: number;
  source: string;
  provider?: string;
  model?: string;
  title: string | null;
  correspondent: string | null;
  documentType: string | null;
  tags: number[];
  before: DocumentSnapshot;
  after: Record<string, unknown>;
  suggestion?: unknown;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
}

interface HistoryRow {
  id: number;
  document_id: number;
  created_at: number;
  source: string;
  provider: string | null;
  model: string | null;
  title: string | null;
  correspondent: string | null;
  document_type: string | null;
  tags: string;
  before: string;
  after: string;
  suggestion: string | null;
  total_tokens: number;
  reverted_at: number | null;
}

const HISTORY_SORT: Record<string, string> = {
  createdAt: 'created_at',
  documentId: 'document_id',
  title: 'title COLLATE NOCASE',
  correspondent: 'correspondent COLLATE NOCASE',
};

export class HistoryRepo {
  constructor(private readonly db: Db) {}

  add(e: NewHistoryEntry): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO history (document_id, created_at, source, provider, model, title, correspondent, document_type,
             tags, before, after, suggestion, prompt_tokens, completion_tokens, total_tokens, duration_ms)
           VALUES (@documentId, @createdAt, @source, @provider, @model, @title, @correspondent, @documentType,
             @tags, @before, @after, @suggestion, @promptTokens, @completionTokens, @totalTokens, @durationMs)`,
        )
        .run({
          documentId: e.documentId,
          createdAt: Date.now(),
          source: e.source,
          provider: e.provider ?? null,
          model: e.model ?? null,
          title: e.title,
          correspondent: e.correspondent,
          documentType: e.documentType,
          tags: JSON.stringify(e.tags),
          before: JSON.stringify(e.before),
          after: JSON.stringify(e.after),
          suggestion: e.suggestion === undefined ? null : JSON.stringify(e.suggestion),
          promptTokens: e.promptTokens ?? 0,
          completionTokens: e.completionTokens ?? 0,
          totalTokens: e.totalTokens ?? 0,
          durationMs: e.durationMs ?? null,
        }).lastInsertRowid,
    );
  }

  private toItem(r: HistoryRow): HistoryItem {
    const before = safeJson<DocumentSnapshot>(r.before, {});
    return {
      id: r.id,
      documentId: r.document_id,
      createdAt: r.created_at,
      source: r.source,
      provider: r.provider,
      model: r.model,
      title: r.title,
      correspondent: r.correspondent,
      documentType: r.document_type,
      tags: safeJson<number[]>(r.tags, []),
      totalTokens: r.total_tokens,
      revertedAt: r.reverted_at,
      canRevert: !r.reverted_at && Object.keys(before).length > 0,
      before,
      after: safeJson<Record<string, unknown>>(r.after, {}),
      suggestion: r.suggestion ? safeJson<unknown>(r.suggestion, null) : null,
    };
  }

  get(id: number): HistoryItem | undefined {
    const row = this.db.prepare('SELECT * FROM history WHERE id = ?').get(id) as HistoryRow | undefined;
    return row ? this.toItem(row) : undefined;
  }

  latestForDocument(documentId: number): HistoryItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM history WHERE document_id = ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(documentId) as HistoryRow | undefined;
    return row ? this.toItem(row) : undefined;
  }

  /** Oldest not-reverted snapshot = the state before the AI touched the document for the first time. */
  originalForDocument(documentId: number): HistoryItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM history WHERE document_id = ? AND reverted_at IS NULL AND before != '{}' ORDER BY id ASC LIMIT 1`,
      )
      .get(documentId) as HistoryRow | undefined;
    return row ? this.toItem(row) : undefined;
  }

  markReverted(documentId: number): void {
    this.db.prepare('UPDATE history SET reverted_at = ? WHERE document_id = ? AND reverted_at IS NULL').run(Date.now(), documentId);
  }

  list(q: HistoryQuery): { items: HistoryItem[]; total: number; filtered: number } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.search?.trim()) {
      where.push(
        `(title LIKE @search ESCAPE '\\' OR correspondent LIKE @search ESCAPE '\\' OR document_type LIKE @search ESCAPE '\\' OR CAST(document_id AS TEXT) = @exact)`,
      );
      params.search = `%${q.search.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      params.exact = q.search.trim();
    }
    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(history.tags) WHERE value = @tag)');
      params.tag = q.tag;
    }
    if (q.correspondent) {
      where.push('correspondent = @correspondent');
      params.correspondent = q.correspondent;
    }
    if (q.source) {
      where.push('source = @source');
      params.source = q.source;
    }
    if (q.documentId) {
      where.push('document_id = @documentId');
      params.documentId = q.documentId;
    }
    if (!q.includeReverted) where.push('reverted_at IS NULL');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortCol = HISTORY_SORT[q.sort ?? 'createdAt'] ?? 'created_at';
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const pageSize = Math.min(Math.max(q.pageSize ?? 25, 1), 500);
    const page = Math.max(q.page ?? 1, 1);

    const total = (this.db.prepare('SELECT COUNT(*) AS c FROM history').get() as { c: number }).c;
    const filtered = (this.db.prepare(`SELECT COUNT(*) AS c FROM history ${whereSql}`).get(params) as { c: number }).c;
    const rows = this.db
      .prepare(`SELECT * FROM history ${whereSql} ORDER BY ${sortCol} ${dir}, id ${dir} LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as HistoryRow[];
    return { items: rows.map((r) => this.toItem(r)), total, filtered };
  }

  correspondents(): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT correspondent FROM history WHERE correspondent IS NOT NULL AND correspondent != '' ORDER BY correspondent COLLATE NOCASE`)
        .all() as { correspondent: string }[]
    ).map((r) => r.correspondent);
  }

  deleteForDocuments(ids: number[]): number {
    const stmt = this.db.prepare('DELETE FROM history WHERE document_id = ?');
    return this.db.transaction(() => ids.reduce((n, id) => n + stmt.run(id).changes, 0))();
  }

  deleteAll(): number {
    return this.db.prepare('DELETE FROM history').run().changes;
  }

  /** Document types assigned by the AI (real data instead of the old "first word of title" heuristic). */
  documentTypeStats(limit = 8): { name: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT document_type AS name, COUNT(DISTINCT document_id) AS count FROM history
         WHERE document_type IS NOT NULL AND document_type != '' AND reverted_at IS NULL
         GROUP BY document_type ORDER BY count DESC LIMIT ?`,
      )
      .all(limit) as { name: string; count: number }[];
  }
}

// ---------------------------------------------------------------- usage

export interface NewUsage {
  feature: 'process' | 'manual' | 'playground' | 'chat' | 'rag' | 'test';
  documentId?: number | null;
  provider?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs?: number;
}

export class UsageRepo {
  constructor(private readonly db: Db) {}

  add(u: NewUsage): void {
    this.db
      .prepare(
        `INSERT INTO usage (created_at, feature, document_id, provider, model, prompt_tokens, completion_tokens, total_tokens, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        u.feature,
        u.documentId ?? null,
        u.provider ?? null,
        u.model ?? null,
        u.promptTokens,
        u.completionTokens,
        u.totalTokens,
        u.durationMs ?? null,
      );
  }

  stats(): UsageStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS prompt, COALESCE(SUM(completion_tokens),0) AS completion,
           COALESCE(SUM(total_tokens),0) AS total FROM usage`,
      )
      .get() as { calls: number; prompt: number; completion: number; total: number };
    const proc = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(AVG(prompt_tokens),0) AS p, COALESCE(AVG(completion_tokens),0) AS c,
           COALESCE(AVG(total_tokens),0) AS t, COALESCE(AVG(duration_ms),0) AS d
         FROM usage WHERE feature IN ('process','manual') AND total_tokens > 0`,
      )
      .get() as { n: number; p: number; c: number; t: number; d: number };
    const buckets = this.db
      .prepare(
        `SELECT CASE
             WHEN total_tokens < 1000 THEN '0-1k' WHEN total_tokens < 2000 THEN '1k-2k'
             WHEN total_tokens < 4000 THEN '2k-4k' WHEN total_tokens < 8000 THEN '4k-8k'
             WHEN total_tokens < 16000 THEN '8k-16k' ELSE '16k+' END AS range, COUNT(*) AS count
         FROM usage WHERE feature IN ('process','manual') AND total_tokens > 0 GROUP BY range`,
      )
      .all() as { range: string; count: number }[];
    const order = ['0-1k', '1k-2k', '2k-4k', '4k-8k', '8k-16k', '16k+'];
    const byFeature = this.db
      .prepare(`SELECT feature, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens FROM usage GROUP BY feature`)
      .all() as { feature: string; calls: number; tokens: number }[];
    return {
      calls: totals.calls,
      promptTokens: totals.prompt,
      completionTokens: totals.completion,
      totalTokens: totals.total,
      analyses: proc.n,
      avgPromptTokens: Math.round(proc.p),
      avgCompletionTokens: Math.round(proc.c),
      avgTotalTokens: Math.round(proc.t),
      avgDurationMs: Math.round(proc.d),
      distribution: order.map((range) => ({ range, count: buckets.find((b) => b.range === range)?.count ?? 0 })),
      byFeature,
    };
  }
}

// ---------------------------------------------------------------- key/value

export class KvRepo {
  constructor(private readonly db: Db) {}

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? safeJson<T | undefined>(row.value, undefined) : undefined;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface Repos {
  users: UsersRepo;
  documents: DocumentsRepo;
  history: HistoryRepo;
  usage: UsageRepo;
  kv: KvRepo;
}

export function createRepos(db: Db): Repos {
  return {
    users: new UsersRepo(db),
    documents: new DocumentsRepo(db),
    history: new HistoryRepo(db),
    usage: new UsageRepo(db),
    kv: new KvRepo(db),
  };
}
