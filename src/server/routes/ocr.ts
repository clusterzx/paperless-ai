import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OcrDocumentItem, OcrDocumentText, OcrFilter, OcrListResponse, OcrStatus } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { HttpProblem } from '../http/helpers.js';
import { resultInfo } from '../db/ocrRepo.js';
import { assessText } from '../ocr/quality.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'ocr' });

const FILTERS = ['all', 'needs', 'missing', 'poor', 'fair', 'good', 'done', 'failed'] as const satisfies readonly OcrFilter[];
/** Upper limit of documents queued by one request. */
const MAX_BATCH = 5000;

export const ocrRoutes =
  ({ ctx, engine, ocr }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    /** Requested OCR runs that are not finished – including the one being read right now. */
    const pendingJobs = () => {
      const jobs = engine.ocrJobs();
      return jobs.queued.size + jobs.running.size;
    };
    const status = (): OcrStatus => {
      const s = ocr.status(0);
      // The document being read is shown as `active`; everything else waits or is being analysed.
      const pending = pendingJobs() - (s.active && engine.ocrJobs().running.has(s.active.documentId) ? 1 : 0);
      return { ...s, queue: Math.max(0, pending) };
    };

    const requireOcr = async () => {
      if (!ctx.cfg.ocr.enabled) throw new HttpProblem(409, 'OCR is disabled – enable it in Settings → OCR');
      if (!(await ocr.isAvailable())) {
        throw new HttpProblem(409, 'OCR is not available in this installation (onnxruntime-node, sharp or @hyzyla/pdfium missing)');
      }
    };

    app.get('/api/ocr/status', async (): Promise<OcrStatus> => {
      await ocr.isAvailable();
      return status();
    });

    app.get(
      '/api/ocr/documents',
      {
        schema: {
          querystring: z.object({
            filter: z.enum(FILTERS).default('all'),
            search: z.string().max(200).optional(),
            page: z.coerce.number().int().min(1).default(1),
            pageSize: z.coerce.number().int().min(1).max(200).default(50),
            sort: z.enum(['score', 'id', 'title', 'ocr']).default('score'),
            order: z.enum(['asc', 'desc']).optional(),
          }),
        },
      },
      async (req): Promise<OcrListResponse> => {
        ocr.assessIfStale();
        const list = ctx.repos.ocr.list(req.query);
        const jobs = engine.ocrJobs();
        const active = ocr.status(0).active;
        const items: OcrDocumentItem[] = list.items.map((a) => ({
          id: a.id,
          title: a.title,
          url: ctx.documentLink(a.id),
          created: a.created,
          pages: a.pages,
          quality: a.quality,
          ocr: resultInfo(a.result),
          job:
            active?.documentId === a.id
              ? { state: 'running', reading: true, page: active.page, pages: active.pages }
              : jobs.running.has(a.id)
                ? { state: 'running' }
                : jobs.queued.has(a.id)
                  ? { state: 'queued' }
                  : null,
        }));
        return { items, total: list.total, page: list.page, pageSize: list.pageSize, counts: ctx.repos.ocr.counts() };
      },
    );

    app.post(
      '/api/ocr/assess',
      { schema: { body: z.object({ full: z.boolean().optional() }).nullish() } },
      async (req, reply) => {
        if (!ctx.isConfigured()) throw new HttpProblem(409, 'Paperless-AI is not configured yet');
        void ocr.assessArchive({ full: req.body?.full });
        return reply.code(202).send(status());
      },
    );

    app.post(
      '/api/ocr/run',
      {
        schema: {
          description: 'Read documents with OCR. Afterwards they run through the AI analysis (title, tags, correspondent, …).',
          body: z.object({ ids: z.array(z.number().int().positive()).max(MAX_BATCH).optional(), filter: z.enum(FILTERS).optional() }),
        },
      },
      async (req) => {
        await requireOcr();
        const ids = req.body.ids ?? (req.body.filter ? ctx.repos.ocr.ids(req.body.filter, MAX_BATCH) : []);
        let queued = 0;
        for (const id of ids) {
          engine.enqueue(id, { source: 'ocr', force: true, ocr: true });
          const jobs = engine.ocrJobs();
          if (jobs.queued.has(id) || jobs.running.has(id)) queued++;
        }
        if (queued) log.info(`OCR requested for ${queued} document(s)`);
        return { queued, ...status() };
      },
    );

    app.get(
      '/api/ocr/documents/:id',
      { schema: { params: z.object({ id: z.coerce.number().int().positive() }) } },
      async (req): Promise<OcrDocumentText> => {
        const doc = await ctx.paperless().getDocument(req.params.id);
        const result = ctx.repos.ocr.result(doc.id);
        const ocrText = result?.status === 'done' ? result.text : null;
        // Saved in Paperless: the text before the OCR is the one kept for undo.
        const inPaperless = Boolean(result?.status === 'done' && result.written_back && !result.reverted_at);
        const originalText = inPaperless ? (result?.previous_text ?? '') : (doc.content ?? '');
        const pages = doc.page_count ?? result?.total_pages ?? null;
        return {
          id: doc.id,
          title: doc.title,
          originalText,
          originalQuality: assessText(originalText, pages, ctx.cfg.ocr.poorBelow),
          ocrText,
          ocrQuality: ocrText !== null ? assessText(ocrText, pages, ctx.cfg.ocr.poorBelow) : null,
          inPaperless,
          ocr: resultInfo(result),
        };
      },
    );

    app.post(
      '/api/ocr/documents/:id/apply',
      {
        schema: {
          description: 'Save the OCR text in Paperless although it did not score better than the existing text; the document is analysed again.',
          params: z.object({ id: z.coerce.number().int().positive() }),
        },
      },
      async (req) => {
        await ocr.apply(req.params.id);
        engine.enqueue(req.params.id, { source: 'ocr', force: true });
        return { ok: true };
      },
    );

    app.post(
      '/api/ocr/documents/:id/revert',
      { schema: { params: z.object({ id: z.coerce.number().int().positive() }) } },
      async (req) => {
        await ocr.revert(req.params.id);
        return { ok: true };
      },
    );
  };
