/**
 * The workflow engine (docs/standalone/workflows.md §7): turns document events, schedules, dates
 * and manual requests into runs, works through the queue (durable in `workflow_runs`), evaluates
 * the conditions and runs the actions. `analysis.before` is not here – it runs synchronously in
 * the processing job (analysis.ts).
 */
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { AppContext } from '../context.js';
import type { DocumentEvent } from '../events.js';
import type { ArchiveDocument, DocumentFilter } from '../backend/types.js';
import type { PromptRow } from '../db/promptsRepo.js';
import { isAdmin, roleIn, type AccessScope } from '../access/scope.js';
import { userScope } from '../access/context.js';
import { evaluateGroup, type RunSubject } from './evaluate.js';
import { runActions, workflowScope, type ActionHooks } from './actions.js';
import type { QueuedRun } from './storage.js';
import type { PromptRuleOverrides } from '../../shared/promptRules.js';
import type { DryRunResult, RunStep, Trigger, Workflow, WorkflowDefinition } from '../../shared/workflows.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

/** The address webhook actions get in a dry run – never contacted. */
const DRY_RUN_URL = 'https://dry-run.invalid/';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid address)';
  }
}

const log = logger.child({ module: 'workflows' });

/** Chains of workflow runs (A changes the document, B reacts …) end at this depth. */
export const MAX_CHAIN_DEPTH = 3;
/** Runs of one workflow for one document per hour. */
export const MAX_RUNS_PER_HOUR = 10;
/** A new document waits at most this long for its `document.added` workflows before the analysis. */
const SETTLE_TIMEOUT_MS = 60_000;

/** What the engine needs from the processing engine (queue an analysis or OCR). */
export interface ProcessingHooks {
  enqueue(documentId: number, opts: { source: 'workflow'; force: boolean; ocr?: boolean; analysis?: { prompt: PromptRow | null; overrides: PromptRuleOverrides; workflow: string } }): boolean;
}

export class WorkflowEngine {
  private unsubscribe: (() => void) | null = null;
  private running = 0;
  private stopped = true;
  private readonly crons = new Map<number, Cron>();
  private timers: NodeJS.Timeout[] = [];
  /** document.added runs still to finish, per document (the analysis waits for them). */
  private readonly pending = new Map<number, Set<number>>();
  private readonly waiters = new Map<number, (() => void)[]>();
  /** skip_analysis of document.added workflows, per document. */
  private readonly skips = new Map<number, string>();
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly ctx: AppContext,
    private readonly processing?: ProcessingHooks,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const requeued = this.ctx.repos.workflows.requeueRunning();
    if (requeued) log.info(`${requeued} workflow run(s) interrupted by a restart are queued again`);
    this.unsubscribe = this.ctx.events.on((e) => this.onEvent(e));
    this.reloadSchedules();
    // Dates are checked hourly (idempotent per workflow, document and date); old runs are pruned daily.
    this.timers.push(setInterval(() => void this.checkDates().catch((err) => log.error(`Date workflows failed: ${describeError(err)}`)), 3_600_000).unref());
    this.timers.push(setInterval(() => this.prune(), 86_400_000).unref());
    setTimeout(() => void this.checkDates().catch(() => undefined), 5_000).unref();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const deadline = Date.now() + 10_000;
    while (this.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  prune(): number {
    const c = this.ctx.cfg.workflows;
    return this.ctx.repos.workflows.prune(c.retentionDays, c.failedRetentionDays);
  }

  // ------------------------------------------------------------ events → runs

  private onEvent(e: DocumentEvent): void {
    if (this.stopped) return;
    try {
      switch (e.type) {
        case 'document.added': {
          const c = e.context ?? {};
          this.enqueueFor({ type: 'document.added', channels: undefined }, e.id, e.libraryId ?? null, {
            channel: e.source,
            mailFrom: c.mail_from,
            mailSubject: c.mail_subject,
            folder: c.folder,
            filename: c.filename,
          });
          break;
        }
        case 'document.processed':
          this.enqueueFor({ type: 'document.processed' }, e.id, e.libraryId ?? null, {});
          break;
        case 'document.version_added':
          this.enqueueFor({ type: 'document.version_added' }, e.id, e.libraryId ?? null, {});
          break;
        case 'document.updated': {
          const parent = e.origin.actor === 'workflow' && e.origin.ref?.startsWith('run:') ? Number(e.origin.ref.slice(4)) || null : null;
          this.enqueueFor({ type: 'document.updated', fields: e.fields }, e.id, e.libraryId ?? null, { fields: e.fields }, parent, e.origin.actor === 'workflow' ? (e.origin.actorId ?? null) : null);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      log.error(`Workflows for ${e.type} of document ${e.id} could not be queued: ${describeError(err)}`);
    }
  }

  /** Queue the matching workflows of a trigger for a document. Returns the run ids. */
  enqueueFor(
    trigger: Trigger,
    documentId: number,
    libraryId: number | null,
    payload: Record<string, unknown>,
    parentRunId: number | null = null,
    /** The workflow whose own change caused the event (it is not triggered again). */
    causedBy: number | null = null,
    only?: number[],
    triggerKey?: (wf: Workflow) => string | null,
  ): number[] {
    const repo = this.ctx.repos.workflows;
    let workflows = repo.list({ trigger: trigger.type, enabledOnly: true, libraryIds: libraryId !== null ? [libraryId] : null });
    if (only) workflows = workflows.filter((w) => only.includes(w.id));
    workflows = workflows.filter((w) => this.triggerMatches(w.trigger, trigger, payload) && w.id !== causedBy);
    if (!workflows.length) return [];
    const depth = parentRunId ? repo.depth(parentRunId) : 0;
    const batch = randomUUID();
    const ids: number[] = [];
    const hourAgo = Date.now() - 3_600_000;
    for (const wf of workflows) {
      const base = { workflowId: wf.id, revision: wf.revision, documentId, trigger: trigger.type, parentRunId, payload: { ...payload, batch }, triggerKey: triggerKey?.(wf) ?? null };
      if (depth >= MAX_CHAIN_DEPTH) {
        repo.enqueue({ ...base, status: 'skipped', error: `Chain of workflow runs deeper than ${MAX_CHAIN_DEPTH} – stopped (loop protection)` });
        continue;
      }
      if (trigger.type !== 'manual' && repo.recentRuns(wf.id, documentId, hourAgo) >= MAX_RUNS_PER_HOUR) {
        repo.enqueue({ ...base, status: 'skipped', error: `Rate limit: more than ${MAX_RUNS_PER_HOUR} runs for this document in the last hour` });
        continue;
      }
      const id = repo.enqueue(base);
      if (id === null) continue; // idempotency key used already (schedule, date)
      ids.push(id);
      if (trigger.type === 'document.added') {
        const set = this.pending.get(documentId) ?? new Set<number>();
        set.add(id);
        this.pending.set(documentId, set);
      }
    }
    if (ids.length) queueMicrotask(() => this.pump());
    return ids;
  }

  private triggerMatches(configured: Trigger, actual: Trigger, payload: Record<string, unknown>): boolean {
    if (configured.type === 'document.added' && configured.channels?.length) return configured.channels.includes(payload.channel as never);
    if (configured.type === 'document.updated' && configured.fields?.length) {
      const changed = (payload.fields as string[] | undefined) ?? [];
      return configured.fields.some((f) => changed.includes(f));
    }
    return configured.type === actual.type;
  }

  // ------------------------------------------------------------ the queue

  private pump(): void {
    if (this.stopped) return;
    const limit = this.ctx.cfg.workflows.concurrency;
    while (this.running < limit) {
      const run = this.claim();
      if (!run) break;
      this.running++;
      void this.execute(run)
        .catch((err) => log.error(`Workflow run ${run.id} failed: ${describeError(err)}`))
        .finally(() => {
          this.running--;
          this.done(run);
          this.pump();
          if (!this.running) {
            const w = this.idleWaiters;
            this.idleWaiters = [];
            for (const fn of w) fn();
          }
        });
    }
  }

  private claim(): QueuedRun | null {
    return this.ctx.repos.workflows.claim();
  }

  private done(run: QueuedRun): void {
    if (run.documentId === null) return;
    const set = this.pending.get(run.documentId);
    if (!set?.delete(run.id)) return;
    if (set.size) return;
    this.pending.delete(run.documentId);
    for (const fn of this.waiters.get(run.documentId) ?? []) fn();
    this.waiters.delete(run.documentId);
  }

  /** Wait until the `document.added` workflows of a document finished (bounded). */
  async settle(documentId: number, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
    if (!this.pending.get(documentId)?.size) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.waiters.set(documentId, [...(this.waiters.get(documentId) ?? []), () => (clearTimeout(timer), resolve())]);
    });
  }

  /** skip_analysis of a document.added workflow – taken once by the processing job. */
  takeSkip(documentId: number): string | null {
    const r = this.skips.get(documentId) ?? null;
    this.skips.delete(documentId);
    return r;
  }

  /** Tests: wait until the queue is empty. */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.pump();
      const queued = (this.ctx.db.prepare("SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('queued', 'running') AND dry_run = 0").get() as { c: number }).c;
      if (!queued && !this.running) return;
      if (Date.now() > deadline) throw new Error('Workflow queue did not drain');
      await new Promise<void>((r) => {
        if (!this.running) setTimeout(r, 20);
        else this.idleWaiters.push(r);
      });
    }
  }

  private hooks(): ActionHooks {
    return {
      enqueue: this.processing ? (id, opts) => void this.processing!.enqueue(id, { source: 'workflow', force: true, ...opts }) : undefined,
      skipAnalysis: (id, reason) => this.skips.set(id, reason),
    };
  }

  private async execute(run: QueuedRun): Promise<void> {
    const repo = this.ctx.repos.workflows;
    const wf = repo.get(run.workflowId);
    if (!wf) return repo.finish(run.id, 'skipped', 'The workflow was deleted');
    const def = repo.revision(wf.id, run.revision) ?? wf;
    const steps: RunStep[] = [];
    const persist = () => steps.forEach((s) => repo.addStep(run.id, s));
    try {
      const suspended = this.checkOwner(wf);
      if (suspended) return repo.finish(run.id, 'skipped', suspended);
      if (run.documentId === null) return repo.finish(run.id, 'skipped', 'No document');
      // The batch of an event stops at the first match of a "stop after match" workflow.
      const batch = run.payload.batch as string | undefined;
      let doc: ArchiveDocument;
      try {
        doc = await this.ctx.backend(workflowScope(this.ctx, wf)).getDocument(run.documentId);
      } catch (err) {
        return repo.finish(run.id, 'skipped', `The document is not available to the workflow: ${describeError(err)}`);
      }
      const subject: RunSubject = {
        doc,
        meta: this.ctx.metadata(doc.library_id ?? null),
        intake: {
          channel: (run.payload.channel as string | undefined) ?? undefined,
          mailFrom: run.payload.mailFrom as string | undefined,
          mailSubject: run.payload.mailSubject as string | undefined,
          folder: run.payload.folder as string | undefined,
          filename: run.payload.filename as string | undefined,
        },
      };
      const env = { ctx: this.ctx, subject, steps, tokens: { used: 0 } };
      const matched = await evaluateGroup(def.conditions, env);
      if (!matched) {
        persist();
        return repo.finish(run.id, 'not_matched');
      }
      if (def.stopAfterMatch && batch) {
        this.ctx.db
          .prepare("UPDATE workflow_runs SET status = 'skipped', error = ?, finished_at = ? WHERE status = 'queued' AND document_id = ? AND json_extract(payload, '$.batch') = ?")
          .run(`“${wf.name}” matched before and stops later workflows`, Date.now(), run.documentId, batch);
      }
      await runActions(def.actions, { ...env, workflow: wf, runId: run.id, dryRun: false, hooks: this.hooks(), changes: [] });
      persist();
      repo.finish(run.id, 'succeeded');
      log.info(`Workflow "${wf.name}" ran for document ${doc.id}`);
    } catch (err) {
      persist();
      const message = describeError(err);
      repo.finish(run.id, 'failed', message);
      log.warn(`Workflow "${wf.name}" failed for document ${run.documentId}: ${message}`);
    }
  }

  /**
   * A library workflow runs with the rights of its library. If its creator is no longer an owner
   * (or admin), it is suspended instead of acting with rights nobody holds (access-control.md §6).
   */
  private checkOwner(wf: Workflow): string | null {
    if (wf.libraryId === null || !this.ctx.archive().capabilities.libraries) return null;
    const creator = this.ctx.db.prepare('SELECT created_by FROM workflows WHERE id = ?').get(wf.id) as { created_by: number | null } | undefined;
    const scope = creator?.created_by ? userScope(this.ctx, creator.created_by) : null;
    if (scope && (isAdmin(scope) || roleIn(scope, wf.libraryId) === 'owner')) return null;
    const reason = 'The person who created it is no longer an owner of the library';
    this.ctx.repos.workflows.suspend(wf.id, reason);
    log.warn(`Workflow "${wf.name}" suspended: ${reason}`);
    return `Suspended: ${reason}`;
  }

  // ------------------------------------------------------------ manual, schedule, dates

  /**
   * Manual trigger (button, bulk action, API) – of any workflow, whatever its own trigger. Only
   * documents the caller may read and that belong to the workflow's library.
   */
  async runManually(workflowId: number, documentIds: number[], scope: AccessScope): Promise<{ queued: number[]; skipped: { id: number; error: string }[] }> {
    const wf = this.ctx.repos.workflows.get(workflowId);
    if (!wf) return { queued: [], skipped: [] };
    const queued: number[] = [];
    const skipped: { id: number; error: string }[] = [];
    for (const id of documentIds) {
      try {
        const doc = await this.ctx.backend(scope).getDocument(id);
        if (wf.libraryId !== null && doc.library_id != null && doc.library_id !== wf.libraryId) throw new Error('The document is in another library');
        const runId = this.ctx.repos.workflows.enqueue({ workflowId: wf.id, revision: wf.revision, documentId: doc.id, trigger: 'manual', payload: {} });
        if (runId) queued.push(runId);
      } catch (err) {
        skipped.push({ id, error: describeError(err) });
      }
    }
    if (queued.length) queueMicrotask(() => this.pump());
    return { queued, skipped };
  }

  /** Re-run a finished run with the current revision. */
  rerun(runId: number): number | null {
    const run = this.ctx.repos.workflows.run(runId);
    if (!run) return null;
    const wf = this.ctx.repos.workflows.get(run.workflowId);
    if (!wf) return null;
    const id = this.ctx.repos.workflows.enqueue({ workflowId: wf.id, revision: wf.revision, documentId: run.documentId, trigger: run.trigger, payload: { ...run.payload, batch: undefined } });
    queueMicrotask(() => this.pump());
    return id;
  }

  /** (Re)start the cron jobs of the enabled `schedule` workflows. */
  reloadSchedules(): void {
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
    if (this.stopped) return;
    for (const wf of this.ctx.repos.workflows.list({ trigger: 'schedule', enabledOnly: true })) {
      if (wf.trigger.type !== 'schedule') continue;
      try {
        const cron = new Cron(wf.trigger.cron, { protect: true }, () => void this.fireSchedule(wf.id).catch((err) => log.error(`Scheduled workflow "${wf.name}" failed: ${describeError(err)}`)));
        this.crons.set(wf.id, cron);
      } catch (err) {
        log.warn(`Workflow "${wf.name}": invalid schedule – ${describeError(err)}`);
      }
    }
  }

  /** Run a scheduled workflow now: every document of its filter (capped) gets a run. */
  async fireSchedule(workflowId: number, at = new Date()): Promise<number[]> {
    const wf = this.ctx.repos.workflows.get(workflowId);
    if (!wf || wf.trigger.type !== 'schedule' || !wf.enabled) return [];
    const trigger = wf.trigger;
    const scope = workflowScope(this.ctx, wf);
    const filter: DocumentFilter = {};
    if (trigger.query) filter.query = trigger.query;
    if (trigger.tags?.length) {
      const meta = this.ctx.metadata(wf.libraryId);
      const res = await meta.resolveTags(trigger.tags, false);
      if (res.missing.length) return []; // a tag that does not exist matches nothing
      filter.tagsAll = res.ids;
    }
    const limit = trigger.limit ?? 500;
    const key = at.toISOString().slice(0, 16);
    const ids: number[] = [];
    let cursor: string | null = null;
    let seen = 0;
    do {
      const page = await this.ctx.backend(scope).queryDocuments({ filter, sort: '-created', limit: Math.min(250, limit - seen), cursor });
      for (const d of page.results) ids.push(...this.enqueueFor(trigger, d.id, d.library_id ?? null, {}, null, null, [wf.id], () => `schedule:${key}`));
      seen += page.results.length;
      cursor = page.nextCursor;
    } while (cursor && seen < limit);
    if (ids.length) log.info(`Scheduled workflow "${wf.name}": ${ids.length} document(s)`);
    return ids;
  }

  /** `date.reached`: documents whose date plus the offset is today (once per workflow, document and date). */
  async checkDates(today = new Date().toISOString().slice(0, 10)): Promise<number> {
    let queued = 0;
    for (const wf of this.ctx.repos.workflows.list({ trigger: 'date.reached', enabledOnly: true })) {
      if (wf.trigger.type !== 'date.reached') continue;
      const t = wf.trigger;
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - t.offsetDays);
      const day = d.toISOString().slice(0, 10);
      const scope = workflowScope(this.ctx, wf);
      let docs: { id: number; library_id?: number | null }[];
      if (t.source === 'calendar') {
        const events = this.ctx.repos.calendar.list({ from: day, to: day, libraryIds: scope.libraries ? [...scope.libraries.keys()] : null });
        docs = [...new Set(events.map((e) => e.document_id))].map((id) => ({ id }));
      } else {
        const filter: DocumentFilter = {};
        if (t.source === 'created') {
          filter.createdFrom = day;
          filter.createdTo = day;
        } else {
          const meta = this.ctx.metadata(wf.libraryId);
          await meta.snapshot();
          const field = meta.customFieldByName(t.field ?? '');
          if (!field) continue;
          filter.customFields = [{ field: field.id, op: 'eq', value: day }];
        }
        docs = (await this.ctx.backend(scope).queryDocuments({ filter, limit: 250 })).results;
      }
      for (const doc of docs) queued += this.enqueueFor(t, doc.id, doc.library_id ?? null, { date: day }, null, null, [wf.id], () => `date:${today}`).length;
    }
    return queued;
  }

  // ------------------------------------------------------------ dry run

  /** Evaluate a (saved or unsaved) workflow against a document without writing anything. */
  async dryRun(def: WorkflowDefinition & { id?: number }, documentId: number, scope: AccessScope): Promise<DryRunResult> {
    const doc = await this.ctx.backend(scope).getDocument(documentId);
    const steps: RunStep[] = [];
    const tokens = { used: 0 };
    const subject: RunSubject = { doc, meta: this.ctx.metadata(doc.library_id ?? null), intake: { channel: undefined, filename: doc.original_file_name ?? undefined } };
    const env = { ctx: this.ctx, subject, steps, tokens };
    const matched = await evaluateGroup(def.conditions, env);
    const changes: DryRunResult['changes'] = [];
    if (matched) {
      // A dry run sends nothing: webhook actions get an inert address (the plan shows the real host).
      const actions = def.actions.map((a) => (a.type === 'notify_webhook' ? { ...a, url: DRY_RUN_URL, previewHost: hostOf(a.url), secret: undefined } : a));
      try {
        await runActions(actions, { ...env, workflow: { id: def.id ?? 0, name: def.name, libraryId: def.libraryId, allowedLibraries: def.allowedLibraries }, runId: null, dryRun: true, hooks: {}, changes });
      } catch {
        /* the failing step is in the list */
      }
    }
    return { matched, steps, changes, tokens: tokens.used };
  }
}
