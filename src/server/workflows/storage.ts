/**
 * Storage of workflows, their revisions, runs and run steps (docs/standalone/workflows.md §6), plus
 * the cache of AI answers of conditions.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { RunStatus, RunStep, TriggerType, Workflow, WorkflowDefinition, WorkflowRun } from '../../shared/workflows.js';
import { workflowDefinitionSchema } from './schema.js';

export const WORKFLOW_SCHEMA = `
CREATE TABLE workflows (
  id INTEGER PRIMARY KEY,
  library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger TEXT NOT NULL,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  stop_after_match INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  allowed_libraries TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  suspended_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX workflows_trigger ON workflows(trigger_type, position) WHERE enabled = 1;

CREATE TABLE workflow_revisions (
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  definition TEXT NOT NULL,
  saved_by INTEGER,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, revision)
) WITHOUT ROWID;

CREATE TABLE workflow_runs (
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  document_id INTEGER,
  trigger TEXT NOT NULL,
  trigger_key TEXT,
  parent_run_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'not_matched')),
  dry_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX workflow_runs_once ON workflow_runs(workflow_id, document_id, trigger_key) WHERE trigger_key IS NOT NULL;
CREATE INDEX workflow_runs_document ON workflow_runs(document_id, id);
CREATE INDEX workflow_runs_workflow ON workflow_runs(workflow_id, id);
CREATE INDEX workflow_runs_queue ON workflow_runs(status, queued_at) WHERE status IN ('queued', 'running');
CREATE INDEX workflow_runs_finished ON workflow_runs(finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE workflow_run_steps (
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('condition', 'action')),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  PRIMARY KEY (run_id, idx)
) WITHOUT ROWID;

CREATE TABLE workflow_ai_cache (
  document_id INTEGER NOT NULL,
  modified TEXT NOT NULL,
  question_hash TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, modified, question_hash)
) WITHOUT ROWID;
`;

interface WorkflowRow {
  id: number;
  library_id: number | null;
  name: string;
  enabled: number;
  position: number;
  trigger_type: TriggerType;
  trigger: string;
  conditions: string;
  actions: string;
  stop_after_match: number;
  revision: number;
  allowed_libraries: string;
  created_by: number | null;
  created_by_name?: string | null;
  suspended_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: number;
  workflow_id: number;
  revision: number;
  document_id: number | null;
  trigger: TriggerType;
  trigger_key: string | null;
  parent_run_id: number | null;
  payload: string;
  status: RunStatus;
  dry_run: number;
  error: string | null;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  workflow_name?: string;
}

export interface QueuedRun {
  id: number;
  workflowId: number;
  revision: number;
  documentId: number | null;
  trigger: TriggerType;
  parentRunId: number | null;
  payload: Record<string, unknown>;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function toWorkflow(r: WorkflowRow): Workflow {
  // Stored JSON goes through the schema again (defaults of fields added later).
  const def = workflowDefinitionSchema.safeParse({
    name: r.name,
    enabled: Boolean(r.enabled),
    libraryId: r.library_id,
    trigger: parseJson(r.trigger, { type: 'manual' }),
    conditions: parseJson(r.conditions, { op: 'all', items: [] }),
    actions: parseJson(r.actions, []),
    stopAfterMatch: Boolean(r.stop_after_match),
    allowedLibraries: parseJson(r.allowed_libraries, []),
  });
  const base: WorkflowDefinition = def.success
    ? def.data
    : { name: r.name, enabled: false, libraryId: r.library_id, trigger: { type: 'manual' }, conditions: { op: 'all', items: [] }, actions: [], stopAfterMatch: false, allowedLibraries: [] };
  return {
    ...base,
    id: r.id,
    position: r.position,
    revision: r.revision,
    suspendedReason: def.success ? r.suspended_reason : `The stored definition is not valid any more: ${def.error.issues[0]?.message ?? 'unknown problem'}`,
    createdBy: r.created_by_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SELECT_WORKFLOW = 'SELECT w.*, (SELECT username FROM users WHERE id = w.created_by) AS created_by_name FROM workflows w';

export class WorkflowRepo {
  constructor(private readonly db: Db) {}

  list(opts: { libraryIds?: number[] | null; trigger?: TriggerType; enabledOnly?: boolean } = {}): Workflow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.libraryIds) {
      // Global workflows (NULL) and those of the given libraries.
      where.push('(w.library_id IS NULL OR w.library_id IN (SELECT value FROM json_each(?)))');
      params.push(JSON.stringify(opts.libraryIds));
    }
    if (opts.trigger) {
      where.push('w.trigger_type = ?');
      params.push(opts.trigger);
    }
    if (opts.enabledOnly) where.push('w.enabled = 1 AND w.suspended_reason IS NULL');
    const rows = this.db.prepare(`${SELECT_WORKFLOW} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY w.position, w.id`).all(...params) as WorkflowRow[];
    return rows.map(toWorkflow);
  }

  get(id: number): Workflow | undefined {
    const r = this.db.prepare(`${SELECT_WORKFLOW} WHERE w.id = ?`).get(id) as WorkflowRow | undefined;
    return r ? toWorkflow(r) : undefined;
  }

  /** The definition of a workflow at a revision (runs refer to it). */
  revision(id: number, revision: number): WorkflowDefinition | undefined {
    const r = this.db.prepare('SELECT definition FROM workflow_revisions WHERE workflow_id = ? AND revision = ?').get(id, revision) as { definition: string } | undefined;
    return r ? (JSON.parse(r.definition) as WorkflowDefinition) : undefined;
  }

  create(def: WorkflowDefinition, userId: number | null, position?: number): number {
    return this.db.transaction(() => {
      const pos = position ?? ((this.db.prepare('SELECT MAX(position) AS p FROM workflows').get() as { p: number | null }).p ?? 0) + 1;
      const now = Date.now();
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO workflows (library_id, name, enabled, position, trigger_type, trigger, conditions, actions, stop_after_match, allowed_libraries, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(def.libraryId, def.name, def.enabled ? 1 : 0, pos, def.trigger.type, JSON.stringify(def.trigger), JSON.stringify(def.conditions), JSON.stringify(def.actions), def.stopAfterMatch ? 1 : 0, JSON.stringify(def.allowedLibraries), userId, now, now)
          .lastInsertRowid,
      );
      this.db.prepare('INSERT INTO workflow_revisions (workflow_id, revision, definition, saved_by, saved_at) VALUES (?, 1, ?, ?, ?)').run(id, JSON.stringify(def), userId, now);
      return id;
    })();
  }

  /** Save a new revision. Returns the revision number. */
  update(id: number, def: WorkflowDefinition, userId: number | null): number {
    return this.db.transaction(() => {
      const cur = this.db.prepare('SELECT revision FROM workflows WHERE id = ?').get(id) as { revision: number } | undefined;
      if (!cur) throw new Error('Workflow not found');
      const revision = cur.revision + 1;
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE workflows SET library_id = ?, name = ?, enabled = ?, trigger_type = ?, trigger = ?, conditions = ?, actions = ?, stop_after_match = ?, allowed_libraries = ?,
             revision = ?, suspended_reason = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(def.libraryId, def.name, def.enabled ? 1 : 0, def.trigger.type, JSON.stringify(def.trigger), JSON.stringify(def.conditions), JSON.stringify(def.actions), def.stopAfterMatch ? 1 : 0, JSON.stringify(def.allowedLibraries), revision, now, id);
      this.db.prepare('INSERT INTO workflow_revisions (workflow_id, revision, definition, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)').run(id, revision, JSON.stringify(def), userId, now);
      return revision;
    })();
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db.prepare('UPDATE workflows SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id);
  }

  suspend(id: number, reason: string | null): void {
    this.db.prepare('UPDATE workflows SET suspended_reason = ?, updated_at = ? WHERE id = ?').run(reason, Date.now(), id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  /** New order: the given ids get positions 1..n (others keep theirs, after them). */
  reorder(ids: number[]): void {
    this.db.transaction(() => {
      const st = this.db.prepare('UPDATE workflows SET position = ? WHERE id = ?');
      ids.forEach((id, i) => st.run(i + 1, id));
      const rest = (this.db.prepare(`SELECT id FROM workflows WHERE id NOT IN (SELECT value FROM json_each(?)) ORDER BY position, id`).all(JSON.stringify(ids)) as { id: number }[]).map((r) => r.id);
      rest.forEach((id, i) => st.run(ids.length + i + 1, id));
    })();
  }

  // ------------------------------------------------------------ runs

  /** Insert a queued run. Returns null when the idempotency key was used already. */
  enqueue(run: { workflowId: number; revision: number; documentId: number | null; trigger: TriggerType; triggerKey?: string | null; parentRunId?: number | null; payload?: Record<string, unknown>; status?: RunStatus; error?: string | null }): number | null {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_runs (workflow_id, revision, document_id, trigger, trigger_key, parent_run_id, payload, status, error, queued_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.workflowId,
        run.revision,
        run.documentId,
        run.trigger,
        run.triggerKey ?? null,
        run.parentRunId ?? null,
        JSON.stringify(run.payload ?? {}),
        run.status ?? 'queued',
        run.error ?? null,
        now,
        run.status && run.status !== 'queued' ? now : null,
      );
    return res.changes ? Number(res.lastInsertRowid) : null;
  }

  /** Take the next queued run (marks it running) – of a document without a run in progress, so the runs of a document go in order. */
  claim(): QueuedRun | null {
    return this.db.transaction(() => {
      const r = this.db
        .prepare(
          `SELECT * FROM workflow_runs q WHERE q.status = 'queued' AND q.dry_run = 0
             AND (q.document_id IS NULL OR NOT EXISTS (SELECT 1 FROM workflow_runs x WHERE x.status = 'running' AND x.document_id = q.document_id))
           ORDER BY q.queued_at, q.id LIMIT 1`,
        )
        .get() as RunRow | undefined;
      if (!r) return null;
      this.db.prepare("UPDATE workflow_runs SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), r.id);
      return { id: r.id, workflowId: r.workflow_id, revision: r.revision, documentId: r.document_id, trigger: r.trigger, parentRunId: r.parent_run_id, payload: parseJson(r.payload, {}) };
    })();
  }

  /** Runs left `running` by a crash go back to the queue. */
  requeueRunning(): number {
    return this.db.prepare("UPDATE workflow_runs SET status = 'queued', started_at = NULL WHERE status = 'running' AND dry_run = 0").run().changes;
  }

  finish(id: number, status: RunStatus, error: string | null = null): void {
    this.db.prepare('UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(status, error, Date.now(), id);
  }

  addStep(runId: number, step: RunStep): void {
    this.db
      .prepare('INSERT OR REPLACE INTO workflow_run_steps (run_id, idx, kind, name, status, details, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, step.idx, step.kind, step.name, step.status, JSON.stringify(step.details), step.durationMs);
  }

  steps(runId: number): RunStep[] {
    return (this.db.prepare('SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY idx').all(runId) as {
      idx: number;
      kind: RunStep['kind'];
      name: string;
      status: RunStep['status'];
      details: string;
      duration_ms: number | null;
    }[]).map((s) => ({ idx: s.idx, kind: s.kind, name: s.name, status: s.status, details: parseJson(s.details, {}), durationMs: s.duration_ms }));
  }

  run(id: number): (WorkflowRun & { parentRunId: number | null; payload: Record<string, unknown> }) | undefined {
    const r = this.db.prepare('SELECT r.*, w.name AS workflow_name FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?').get(id) as RunRow | undefined;
    return r ? { ...toRun(r), parentRunId: r.parent_run_id, payload: parseJson(r.payload, {}), steps: this.steps(r.id) } : undefined;
  }

  runs(q: { workflowId?: number; documentId?: number; libraryIds?: number[] | null; status?: RunStatus; limit?: number }): WorkflowRun[] {
    const where: string[] = ['r.dry_run = 0'];
    const params: unknown[] = [];
    if (q.workflowId) {
      where.push('r.workflow_id = ?');
      params.push(q.workflowId);
    }
    if (q.documentId) {
      where.push('r.document_id = ?');
      params.push(q.documentId);
    }
    if (q.status) {
      where.push('r.status = ?');
      params.push(q.status);
    }
    if (q.libraryIds) {
      where.push('(w.library_id IS NULL OR w.library_id IN (SELECT value FROM json_each(?)))');
      params.push(JSON.stringify(q.libraryIds));
    }
    const rows = this.db
      .prepare(`SELECT r.*, w.name AS workflow_name FROM workflow_runs r LEFT JOIN workflows w ON w.id = r.workflow_id WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`)
      .all(...params, q.limit ?? 100) as RunRow[];
    return rows.map(toRun);
  }

  /** Depth of a run in a chain of workflow runs (1 = started by something else). */
  depth(runId: number | null): number {
    let depth = 0;
    let id = runId;
    while (id && depth < 20) {
      depth++;
      id = (this.db.prepare('SELECT parent_run_id AS p FROM workflow_runs WHERE id = ?').get(id) as { p: number | null } | undefined)?.p ?? null;
    }
    return depth;
  }

  /** Runs of a workflow for a document in the last hour (rate limit). */
  recentRuns(workflowId: number, documentId: number, since: number): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS c FROM workflow_runs WHERE workflow_id = ? AND document_id = ? AND queued_at >= ? AND dry_run = 0 AND status NOT IN ('skipped', 'not_matched')")
        .get(workflowId, documentId, since) as { c: number }
    ).c;
  }

  stats(workflowId: number, since: number): { runs: number; failed: number; last: { status: RunStatus; at: number } | null; skippedRate: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, SUM(status = 'failed') AS failed, SUM(status = 'skipped' AND error LIKE 'Rate limit%') AS rate
         FROM workflow_runs WHERE workflow_id = ? AND queued_at >= ? AND dry_run = 0 AND status != 'not_matched'`,
      )
      .get(workflowId, since) as { runs: number; failed: number | null; rate: number | null };
    const last = this.db.prepare("SELECT status, COALESCE(finished_at, queued_at) AS at FROM workflow_runs WHERE workflow_id = ? AND dry_run = 0 AND status != 'not_matched' ORDER BY id DESC LIMIT 1").get(workflowId) as
      | { status: RunStatus; at: number }
      | undefined;
    return { runs: r.runs, failed: r.failed ?? 0, last: last ?? null, skippedRate: r.rate ?? 0 };
  }

  /** Run retention: successful (and not matched) runs after `okDays`, failed ones after `failedDays`. */
  prune(okDays: number, failedDays: number, now = Date.now()): number {
    // Runs whose conditions did not match are only interesting for a short while.
    const unmatched = this.db.prepare("DELETE FROM workflow_runs WHERE status = 'not_matched' AND finished_at < ?").run(now - Math.min(7, okDays) * 86_400_000).changes;
    const ok = this.db.prepare("DELETE FROM workflow_runs WHERE status IN ('succeeded', 'skipped') AND finished_at < ?").run(now - okDays * 86_400_000).changes + unmatched;
    const failed = this.db.prepare("DELETE FROM workflow_runs WHERE status = 'failed' AND finished_at < ?").run(now - failedDays * 86_400_000).changes;
    this.db.prepare('DELETE FROM workflow_ai_cache WHERE created_at < ?').run(now - okDays * 86_400_000);
    return ok + failed;
  }

  // ------------------------------------------------------------ AI answers

  cachedAnswer<T>(documentId: number, modified: string, question: string): T | undefined {
    const r = this.db.prepare('SELECT answer FROM workflow_ai_cache WHERE document_id = ? AND modified = ? AND question_hash = ?').get(documentId, modified, hashOf(question)) as { answer: string } | undefined;
    return r ? (JSON.parse(r.answer) as T) : undefined;
  }

  cacheAnswer(documentId: number, modified: string, question: string, answer: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO workflow_ai_cache (document_id, modified, question_hash, answer, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(documentId, modified, hashOf(question), JSON.stringify(answer), Date.now());
  }
}

function hashOf(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

function toRun(r: RunRow): WorkflowRun {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name ?? `Workflow #${r.workflow_id}`,
    revision: r.revision,
    documentId: r.document_id,
    trigger: r.trigger,
    status: r.status,
    dryRun: Boolean(r.dry_run),
    error: r.error,
    queuedAt: r.queued_at,
    finishedAt: r.finished_at,
  };
}
