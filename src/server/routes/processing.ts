import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DashboardData, HistoryPage } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { badRequest, documentIdFrom } from '../http/helpers.js';
import { revertDocument } from '../processing/applier.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'processing' });

export const processingRoutes =
  ({ ctx, engine, rag }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    // ---------------------------------------------------------------- dashboard

    app.get('/api/dashboard', async (): Promise<DashboardData> => {
      const paperless: DashboardData['paperless'] = { connected: false, documents: 0, tags: 0, correspondents: 0, documentTypes: 0 };
      if (ctx.paperlessConfigured()) {
        try {
          const client = ctx.paperless();
          const info = await client.connect();
          const [documents, meta] = await Promise.all([client.count('/documents/'), ctx.metadata().snapshot()]);
          Object.assign(paperless, {
            connected: true,
            version: info.serverVersion,
            apiVersion: info.apiVersion,
            documents,
            tags: meta.tags.length,
            correspondents: meta.correspondents.length,
            documentTypes: meta.documentTypes.length,
          });
        } catch (err) {
          paperless.error = describeError(err);
        }
      } else paperless.error = 'Not configured';
      return {
        version: ctx.version,
        paperless,
        processing: engine.status(),
        usage: ctx.repos.usage.stats(),
        timeline: ctx.repos.documents.timeline(30, new Date().getTimezoneOffset()),
        documentTypes: ctx.repos.history.documentTypeStats(8),
        ai: ctx.aiInfo(),
        rag: { enabled: ctx.cfg.rag.enabled },
      };
    });

    app.get('/api/metadata/counts', async () => {
      const meta = await ctx.metadata().snapshot();
      const pick = (items: { id: number; name: string; document_count?: number }[]) =>
        items.map((i) => ({ id: i.id, name: i.name, document_count: i.document_count ?? 0 })).sort((a, b) => b.document_count - a.document_count);
      return { tags: pick(meta.tags), correspondents: pick(meta.correspondents), documentTypes: pick(meta.documentTypes) };
    });

    // ---------------------------------------------------------------- processing control

    app.get('/api/processing/status', async () => engine.status());

    app.post('/api/processing/scan', async () => {
      const queued = await engine.scan();
      return { queued };
    });

    app.post('/api/processing/pause', async () => {
      engine.pause();
      return engine.status();
    });

    app.post('/api/processing/resume', async () => {
      engine.resume();
      return engine.status();
    });

    app.post(
      '/api/processing/documents',
      { schema: { body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000), prompt: z.string().max(20_000).optional() }) } },
      async (req) => {
        let queued = 0;
        for (const id of req.body.ids) if (engine.enqueue(id, { source: 'api', force: true, prompt: req.body.prompt })) queued++;
        return { queued };
      },
    );

    app.get(
      '/api/processing/problems',
      { schema: { querystring: z.object({ status: z.enum(['failed', 'skipped']).default('failed') }) } },
      async (req) =>
        ctx.repos.documents.list(req.query.status).map((d) => ({
          documentId: d.id,
          title: d.title,
          status: d.status,
          reason: d.reason,
          attempts: d.attempts,
          updatedAt: d.updated_at,
          url: ctx.documentLink(d.id),
        })),
    );

    app.post(
      '/api/processing/retry',
      { schema: { body: z.object({ ids: z.array(z.number().int().positive()).optional() }).nullish() } },
      async (req) => {
        const ids = req.body?.ids ?? ctx.repos.documents.list('failed', 10_000).map((d) => d.id);
        ctx.repos.documents.reset(ids);
        let queued = 0;
        for (const id of ids) if (engine.enqueue(id, { source: 'api' })) queued++;
        return { queued };
      },
    );

    // ---------------------------------------------------------------- webhook (Paperless workflow)

    const webhookBody = z
      .object({
        url: z.string().optional(),
        doc_url: z.string().optional(),
        document_id: z.union([z.number(), z.string()]).optional(),
        id: z.union([z.number(), z.string()]).optional(),
        prompt: z.string().max(20_000).optional(),
        force: z.boolean().optional(),
      })
      .passthrough();

    app.post(
      '/api/webhook/document',
      {
        schema: {
          description:
            'Queue a document for AI processing. Call it from a Paperless-ngx workflow ("Webhook" action, trigger "Document Added") with the document URL ({doc_url}) or id.',
          body: webhookBody,
        },
      },
      async (req, reply) => {
        const b = req.body;
        const id = documentIdFrom(b.document_id) ?? documentIdFrom(b.id) ?? documentIdFrom(b.url) ?? documentIdFrom(b.doc_url);
        if (!id) throw badRequest('Missing or invalid document reference: send {"url": "<document url>"} or {"document_id": 123}');
        if (!ctx.isConfigured()) return reply.code(409).send({ error: 'Paperless-AI is not configured yet' });
        const accepted = engine.enqueue(id, { source: 'webhook', prompt: b.prompt, force: b.force });
        log.info(`Webhook: document ${id} ${accepted ? 'queued' : 'already queued'}`);
        return reply.code(202).send({ message: 'Document accepted for processing', documentId: id, queued: accepted, queueLength: engine.queueLength });
      },
    );

    // ---------------------------------------------------------------- history

    const historyQuery = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(500).default(25),
      search: z.string().max(200).optional(),
      tag: z.coerce.number().int().optional(),
      correspondent: z.string().max(200).optional(),
      source: z.string().max(50).optional(),
      documentId: z.coerce.number().int().optional(),
      sort: z.enum(['createdAt', 'documentId', 'title', 'correspondent']).default('createdAt'),
      order: z.enum(['asc', 'desc']).default('desc'),
      // stringbool: "false" must not become true (z.coerce.boolean uses Boolean("false") === true).
      includeReverted: z.stringbool().optional(),
    });

    app.get('/api/history', { schema: { querystring: historyQuery } }, async (req): Promise<HistoryPage> => {
      const res = ctx.repos.history.list(req.query);
      let tagName = (id: number) => `#${id}`;
      try {
        const meta = ctx.metadata();
        await meta.snapshot();
        tagName = (id) => meta.tagName(id) ?? `#${id}`;
      } catch {
        /* Paperless unreachable: show ids */
      }
      return {
        items: res.items.map((i) => ({ ...i, tagNames: i.tags.map(tagName), url: ctx.documentLink(i.documentId) })),
        total: res.total,
        filtered: res.filtered,
        page: req.query.page,
        pageSize: req.query.pageSize,
      };
    });

    app.get('/api/history/filters', async () => {
      let tags: { id: number; name: string }[] = [];
      try {
        tags = (await ctx.metadata().snapshot()).tags.map((t) => ({ id: t.id, name: t.name }));
      } catch {
        /* ignore */
      }
      return { tags, correspondents: ctx.repos.history.correspondents() };
    });

    app.post(
      '/api/history/revert',
      { schema: { body: z.object({ documentIds: z.array(z.number().int().positive()).min(1).max(1000) }) } },
      async (req) => {
        const results: { documentId: number; ok: boolean; error?: string }[] = [];
        for (const id of req.body.documentIds) {
          try {
            await revertDocument(ctx, id);
            results.push({ documentId: id, ok: true });
          } catch (err) {
            results.push({ documentId: id, ok: false, error: describeError(err) });
          }
        }
        if (results.some((r) => r.ok)) rag.requestSync();
        return { results };
      },
    );

    app.post(
      '/api/history/reset',
      { schema: { body: z.object({ documentIds: z.array(z.number().int().positive()).max(100_000).optional(), all: z.boolean().optional(), deleteHistory: z.boolean().optional() }) } },
      async (req) => {
        if (req.body.all) {
          const n = ctx.repos.documents.resetAll();
          if (req.body.deleteHistory) ctx.repos.history.deleteAll();
          log.info(`Reset processing state of all ${n} documents`);
          return { reset: n };
        }
        const ids = req.body.documentIds ?? [];
        if (!ids.length) throw badRequest('No documents selected');
        const n = ctx.repos.documents.reset(ids);
        if (req.body.deleteHistory) ctx.repos.history.deleteForDocuments(ids);
        return { reset: n };
      },
    );

    // ---------------------------------------------------------------- legacy endpoints (Paperless-AI ≤ 3.x)

    app.post('/api/scan/now', { schema: { hide: true } }, async (_req, reply) => {
      if (!ctx.isConfigured()) return reply.code(409).send('Setup not completed');
      await engine.scan();
      await engine.drain(5 * 60_000);
      return reply.type('text/plain').send('Task completed');
    });

    app.get('/api/processing-status', { schema: { hide: true } }, async () => {
      const s = engine.status();
      const cur = s.current[0];
      return {
        currentlyProcessing: cur ? { documentId: cur.documentId, title: cur.title, startTime: new Date(cur.startedAt).toISOString(), status: 'processing' } : null,
        lastProcessed: s.lastProcessed
          ? { documentId: s.lastProcessed.documentId, title: s.lastProcessed.title, processed_at: new Date(s.lastProcessed.processedAt).toISOString() }
          : null,
        processedToday: s.processedToday,
        isProcessing: s.running,
      };
    });

    app.post('/api/reset-documents', { schema: { hide: true, body: z.object({ ids: z.array(z.coerce.number().int()) }) } }, async (req) => {
      ctx.repos.documents.reset(req.body.ids);
      return { success: true };
    });

    app.post('/api/reset-all-documents', { schema: { hide: true } }, async () => {
      ctx.repos.documents.resetAll();
      return { success: true };
    });
  };
