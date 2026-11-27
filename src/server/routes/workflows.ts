/**
 * Workflows API: list, edit (revisions), order, enable, dry run, manual runs, run log, re-run and
 * undo of a run. Global workflows belong to administrators; library workflows to the owners of the
 * library (docs/standalone/access-control.md §6).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../http/app.js';
import { HttpProblem, notFound } from '../http/helpers.js';
import { canRead, isAdmin, readableLibraries, roleIn, userIdOf, type AccessScope } from '../access/scope.js';
import { audit } from '../access/context.js';
import { workflowDefinitionSchema } from '../workflows/schema.js';
import { lockedRuleWorkflows } from '../workflows/promptRules.js';
import { verifySmtp } from '../workflows/notify.js';
import { LocalBackend } from '../archive/backend.js';
import { BUILTIN_ONLY_ACTIONS, BUILTIN_ONLY_TRIGGERS, type RunStatus, type Workflow, type WorkflowDefinition, type WorkflowRun } from '../../shared/workflows.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'workflows' });
const id = z.object({ id: z.coerce.number().int().positive() });
const WEEK = 7 * 86_400_000;

export const workflowRoutes =
  ({ ctx, workflows }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const repo = ctx.repos.workflows;
    const engine = () => {
      if (!workflows) throw new HttpProblem(503, 'The workflow engine is not running');
      return workflows;
    };

    /** May the caller see this workflow? Global ones: everybody (read-only); library ones: its readers. */
    const visible = (scope: AccessScope, wf: Pick<Workflow, 'libraryId'>) => wf.libraryId === null || isAdmin(scope) || canRead(scope, wf.libraryId);
    /** May the caller change it? Global: admins; library: admins and owners. */
    const editable = (scope: AccessScope, libraryId: number | null) => isAdmin(scope) || (libraryId !== null && roleIn(scope, libraryId) === 'owner');

    /**
     * What a caller who cannot change the workflow sees of it: webhooks without their secret and
     * only the host of their address (an ntfy topic or a Gotify token in it is a credential).
     */
    const shown = (scope: AccessScope, wf: Workflow): Workflow => {
      if (editable(scope, wf.libraryId) || !wf.actions.some((a) => a.type === 'notify_webhook')) return wf;
      const hostOnly = (url: string) => {
        try {
          const u = new URL(url);
          return `${u.protocol}//${u.host}/…`;
        } catch {
          return '…';
        }
      };
      return {
        ...wf,
        actions: wf.actions.map((a) => (a.type === 'notify_webhook' ? { type: a.type, preset: a.preset, url: hostOnly(a.url), ...(a.secret ? { secret: '••••••' } : {}) } : a)),
      };
    };

    const withStats = (wf: Workflow): Workflow => {
      if (wf.id < 0) return wf;
      const s = repo.stats(wf.id, Date.now() - WEEK);
      return { ...wf, stats: { runs7d: s.runs, failed7d: s.failed, lastRun: s.last, rateLimited: s.skippedRate > 0 } };
    };

    const get = (scope: AccessScope, wfId: number): Workflow => {
      const wf = repo.get(wfId);
      if (!wf || !visible(scope, wf)) throw notFound('Workflow not found');
      return wf;
    };

    /** Checks of a definition beyond the schema: rights, mode, targets. */
    const check = (scope: AccessScope, def: WorkflowDefinition) => {
      if (!editable(scope, def.libraryId)) throw new HttpProblem(403, def.libraryId === null ? 'Only administrators can create global workflows' : 'Only owners of the library can change its workflows');
      const builtin = ctx.archive().capabilities.libraries;
      if (!builtin) {
        if (def.libraryId !== null) throw new HttpProblem(400, 'Libraries exist only in the built-in archive');
        if (BUILTIN_ONLY_TRIGGERS.includes(def.trigger.type)) throw new HttpProblem(400, 'This trigger needs the built-in archive');
        if (def.actions.some((a) => BUILTIN_ONLY_ACTIONS.includes(a.type))) throw new HttpProblem(400, 'Moving to another library needs the built-in archive');
      } else if (def.libraryId !== null && !ctx.repos.libraries.get(def.libraryId)) throw new HttpProblem(400, 'Unknown library');
      for (const lib of def.allowedLibraries) {
        if (!editable(scope, lib)) throw new HttpProblem(403, `You are not an owner of library #${lib} – it cannot be a target of the workflow`);
      }
      // Calls to addresses on the network of the server: administrators only.
      if (!isAdmin(scope) && def.actions.some((a) => a.type === 'notify_webhook')) throw new HttpProblem(403, 'Only administrators can add webhooks');
    };

    app.get('/api/workflows', async (req): Promise<Workflow[]> => {
      const scope = req.access!;
      const libs = readableLibraries(scope);
      const list = [...lockedRuleWorkflows(ctx), ...repo.list({ libraryIds: isAdmin(scope) ? null : libs })];
      return list.filter((w) => visible(scope, w)).map((w) => shown(scope, withStats(w)));
    });

    app.get('/api/workflows/:id', { schema: { params: id } }, async (req) => shown(req.access!, withStats(get(req.access!, req.params.id))));

    app.post('/api/workflows', { schema: { body: workflowDefinitionSchema } }, async (req): Promise<Workflow> => {
      check(req.access!, req.body);
      const wfId = repo.create(req.body, userIdOf(req.access!));
      audit(ctx, req.access, 'workflow.created', `workflow:${wfId}`, { name: req.body.name }, req.body.libraryId);
      workflows?.reloadSchedules();
      return repo.get(wfId)!;
    });

    app.put('/api/workflows/:id', { schema: { params: id, body: workflowDefinitionSchema } }, async (req): Promise<Workflow> => {
      const cur = get(req.access!, req.params.id);
      if (!editable(req.access!, cur.libraryId)) throw new HttpProblem(403, 'You cannot change this workflow');
      check(req.access!, req.body);
      repo.update(req.params.id, req.body, userIdOf(req.access!));
      // The new owner takes over a workflow suspended for its old creator.
      ctx.db.prepare('UPDATE workflows SET created_by = COALESCE(?, created_by) WHERE id = ?').run(userIdOf(req.access!), req.params.id);
      audit(ctx, req.access, 'workflow.changed', `workflow:${req.params.id}`, { name: req.body.name }, req.body.libraryId);
      workflows?.reloadSchedules();
      return repo.get(req.params.id)!;
    });

    app.patch('/api/workflows/:id', { schema: { params: id, body: z.object({ enabled: z.boolean() }) } }, async (req) => {
      const cur = get(req.access!, req.params.id);
      if (!editable(req.access!, cur.libraryId)) throw new HttpProblem(403, 'You cannot change this workflow');
      repo.setEnabled(req.params.id, req.body.enabled);
      workflows?.reloadSchedules();
      return { ok: true };
    });

    app.delete('/api/workflows/:id', { schema: { params: id } }, async (req) => {
      const cur = get(req.access!, req.params.id);
      if (!editable(req.access!, cur.libraryId)) throw new HttpProblem(403, 'You cannot delete this workflow');
      repo.delete(req.params.id);
      audit(ctx, req.access, 'workflow.deleted', `workflow:${req.params.id}`, { name: cur.name }, cur.libraryId);
      workflows?.reloadSchedules();
      return { ok: true };
    });

    app.post('/api/workflows/order', { schema: { body: z.object({ ids: z.array(z.number().int().positive()).max(1000) }) } }, async (req) => {
      for (const wfId of req.body.ids) {
        const wf = get(req.access!, wfId);
        if (!editable(req.access!, wf.libraryId)) throw new HttpProblem(403, `You cannot move “${wf.name}”`);
      }
      repo.reorder(req.body.ids);
      return { ok: true };
    });

    // ------------------------------------------------------------ testing and running

    app.post(
      '/api/workflows/dry-run',
      {
        schema: {
          description: 'Evaluate a workflow (saved: `workflowId`, or an unsaved `workflow`) against a document. Nothing is written; AI conditions are really asked.',
          body: z.object({ documentId: z.number().int().positive(), workflowId: z.number().int().optional(), workflow: workflowDefinitionSchema.optional() }),
        },
      },
      async (req) => {
        const def = req.body.workflow ?? (req.body.workflowId !== undefined ? ([...lockedRuleWorkflows(ctx), ...repo.list()].find((w) => w.id === req.body.workflowId) ?? null) : null);
        if (!def) throw new HttpProblem(400, 'Send a workflow or the id of one');
        if (req.body.workflowId !== undefined && req.body.workflowId > 0) get(req.access!, req.body.workflowId);
        // A workflow that is not saved (yet) is tested by the one who may save it.
        if (req.body.workflow && !editable(req.access!, req.body.workflow.libraryId))
          throw new HttpProblem(403, req.body.workflow.libraryId === null ? 'Only administrators can test global workflows' : 'Only owners of the library can test its workflows');
        return engine().dryRun({ ...def, id: req.body.workflowId }, req.body.documentId, req.access!);
      },
    );

    app.post('/api/workflows/:id/run', { schema: { params: id, body: z.object({ documentIds: z.array(z.number().int().positive()).min(1).max(1000) }) } }, async (req) => {
      const wf = get(req.access!, req.params.id);
      // Running acts with the workflow's rights: only who may change the documents of its library.
      if (wf.libraryId !== null ? !['owner', 'editor'].includes(roleIn(req.access!, wf.libraryId) ?? '') && !isAdmin(req.access!) : !isAdmin(req.access!)) {
        throw new HttpProblem(403, 'You cannot run this workflow');
      }
      return engine().runManually(wf.id, req.body.documentIds, req.access!);
    });

    // ------------------------------------------------------------ run log

    const visibleRun = (scope: AccessScope, run: WorkflowRun) => {
      const wf = repo.get(run.workflowId);
      return !wf || visible(scope, wf);
    };

    app.get(
      '/api/workflows/runs',
      {
        schema: {
          querystring: z.object({
            workflowId: z.coerce.number().int().positive().optional(),
            documentId: z.coerce.number().int().positive().optional(),
            status: z.enum(['queued', 'running', 'succeeded', 'failed', 'skipped', 'not_matched']).optional(),
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
        },
      },
      async (req): Promise<WorkflowRun[]> => {
        const scope = req.access!;
        if (req.query.documentId) await ctx.backend(scope).getDocument(req.query.documentId);
        const runs = repo.runs({ ...req.query, status: req.query.status as RunStatus | undefined, libraryIds: isAdmin(scope) ? null : readableLibraries(scope) });
        return runs.filter((r) => visibleRun(scope, r));
      },
    );

    app.get('/api/workflows/runs/:id', { schema: { params: id } }, async (req): Promise<WorkflowRun> => {
      const run = repo.run(req.params.id);
      if (!run || !visibleRun(req.access!, run)) throw notFound('Run not found');
      if (run.documentId) await ctx.backend(req.access!).getDocument(run.documentId);
      const { payload: _payload, parentRunId: _parent, ...rest } = run;
      return rest;
    });

    app.post('/api/workflows/runs/:id/rerun', { schema: { params: id } }, async (req) => {
      const run = repo.run(req.params.id);
      if (!run || !visibleRun(req.access!, run)) throw notFound('Run not found');
      const wf = repo.get(run.workflowId);
      if (!wf || !editable(req.access!, wf.libraryId)) throw new HttpProblem(403, 'You cannot run this workflow');
      const newId = engine().rerun(run.id);
      return { runId: newId };
    });

    app.post(
      '/api/workflows/runs/:id/undo',
      { schema: { params: id, description: 'Undo the changes of a run (built-in archive: its change log entries).', body: z.object({ force: z.boolean().optional() }).nullish() } },
      async (req) => {
        const run = repo.run(req.params.id);
        if (!run || !visibleRun(req.access!, run) || !run.documentId) throw notFound('Run not found');
        const b = ctx.archive();
        if (!(b instanceof LocalBackend)) throw new HttpProblem(409, 'Undo the change in the History (Paperless-ngx keeps no change log of its own)');
        const events = ctx.db
          .prepare('SELECT id FROM lib_document_events WHERE document_id = ? AND ref = ? AND reverted_by IS NULL ORDER BY id DESC')
          .all(run.documentId, `run:${run.id}`) as { id: number }[];
        if (!events.length) throw new HttpProblem(409, 'This run changed nothing that can be undone');
        const fields: string[] = [];
        for (const e of events) {
          const res = await b.undoEvent(req.access!, run.documentId, e.id, { actor: 'user', actorId: userIdOf(req.access!), ref: `undo:run:${run.id}` }, Boolean(req.body?.force));
          fields.push(...res.fields);
          ctx.events.emit({ type: 'document.updated', id: run.documentId, fields: res.fields, origin: { actor: 'user', actorId: userIdOf(req.access!), ref: `undo:run:${run.id}` }, libraryId: res.libraryId });
        }
        return { ok: true, fields: [...new Set(fields)] };
      },
    );

    // ------------------------------------------------------------ notifications (settings)

    app.post('/api/settings/test-smtp', { config: { auth: 'session' } }, async () => {
      try {
        await verifySmtp(ctx);
        return { ok: true };
      } catch (err) {
        log.warn(`SMTP test failed: ${describeError(err)}`);
        throw new HttpProblem(400, `The mail server did not accept the connection: ${describeError(err)}`);
      }
    });
  };
