import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ChatStreamEvent, ChatTurn, DocumentDetail, DocumentSummary } from '../../shared/api.js';
import type { Principal } from '../auth.js';
import type { Services } from '../http/app.js';
import { sendEventStream } from '../http/helpers.js';
import { analyzeContent } from '../processing/analyzer.js';
import { applyPlannedUpdate, planManualUpdate } from '../processing/applier.js';
import { datePart } from '../processing/dates.js';
import type { PaperlessDocument } from '../paperless/types.js';
import { documentChat } from '../rag/documentChat.js';

const chatTurn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(50_000) });

function summary(d: PaperlessDocument): DocumentSummary {
  return {
    id: d.id,
    title: d.title,
    created: datePart(d.created_date ?? d.created),
    correspondent: d.correspondent ?? null,
    document_type: d.document_type ?? null,
    tags: d.tags ?? [],
  };
}

export const documentRoutes =
  ({ ctx, rag }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get('/api/metadata', async () => {
      const meta = await ctx.metadata().snapshot();
      return {
        tags: meta.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, document_count: t.document_count })),
        correspondents: meta.correspondents.map((c) => ({ id: c.id, name: c.name, document_count: c.document_count })),
        documentTypes: meta.documentTypes.map((d) => ({ id: d.id, name: d.name, document_count: d.document_count })),
        customFields: meta.customFields.map((f) => ({ id: f.id, name: f.name, data_type: f.data_type })),
      };
    });

    app.get(
      '/api/documents',
      {
        schema: {
          querystring: z.object({
            query: z.string().max(500).optional(),
            page: z.coerce.number().int().min(1).default(1),
            pageSize: z.coerce.number().int().min(1).max(100).default(25),
          }),
        },
      },
      async (req) => {
        const res = await ctx.paperless().searchDocuments({ query: req.query.query, page: req.query.page, pageSize: req.query.pageSize });
        const states = ctx.repos.documents;
        return {
          count: res.count,
          page: req.query.page,
          results: res.results.map((d) => ({ ...summary(d), status: states.get(d.id)?.status ?? null })),
        };
      },
    );

    app.get('/api/documents/:id', { schema: { params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req): Promise<DocumentDetail> => {
      const d = await ctx.paperless().getDocument(req.params.id);
      return {
        ...summary(d),
        content: d.content ?? '',
        original_file_name: d.original_file_name ?? null,
        custom_fields: d.custom_fields ?? [],
        user_can_change: d.user_can_change,
        modified: d.modified,
        added: d.added,
        url: ctx.documentLink(d.id),
      };
    });

    app.get('/api/documents/:id/thumb', { schema: { params: z.object({ id: z.coerce.number().int().positive() }), hide: true } }, async (req, reply) => {
      const { data, contentType } = await ctx.paperless().thumbnail(req.params.id);
      return reply.header('Cache-Control', 'private, max-age=3600').type(contentType).send(data);
    });

    app.post(
      '/api/documents/:id/analyze',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          // Fastify validates a missing body as null.
          body: z.object({ prompt: z.string().max(50_000).optional() }).nullish(),
        },
      },
      async (req) => {
        const doc = await ctx.paperless().getDocument(req.params.id);
        return analyzeContent(ctx, doc.content ?? '', {
          feature: req.body?.prompt ? 'playground' : 'manual',
          documentId: doc.id,
          customPrompt: req.body?.prompt,
          filename: doc.original_file_name,
        });
      },
    );

    app.post(
      '/api/documents/:id/apply',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({
            title: z.string().max(512).optional(),
            correspondent: z.string().max(256).nullable().optional(),
            documentType: z.string().max(256).nullable().optional(),
            tags: z.array(z.string().max(128)).max(200).optional(),
            created: z.string().max(40).nullable().optional(),
            customFields: z.array(z.object({ field_name: z.string(), value: z.string() })).optional(),
          }),
        },
      },
      async (req) => {
        const doc = await ctx.paperless().getDocument(req.params.id);
        const plan = await planManualUpdate(ctx, doc, req.body);
        const updated = await applyPlannedUpdate(ctx, doc, plan, { source: 'manual' });
        rag.requestSync();
        return { document: summary(updated), notes: plan.notes, changed: Object.keys(plan.patch) };
      },
    );

    // Playground: recent documents with thumbnails, analysed with a custom prompt (nothing is saved).
    app.get(
      '/api/playground/documents',
      { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(48).default(16), query: z.string().max(200).optional() }) } },
      async (req) => {
        const res = await ctx.paperless().searchDocuments({ pageSize: req.query.limit, query: req.query.query });
        return res.results.map(summary);
      },
    );

    // ---------------------------------------------------------------- document chat

    app.post(
      '/api/chat/document/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({ message: z.string().min(1).max(20_000), history: z.array(chatTurn).max(50).default([]) }),
        },
      },
      async (req, reply) => {
        await sendEventStream<ChatStreamEvent>(req, reply, (signal) => documentChat(ctx, req.params.id, req.body.message, req.body.history, signal));
      },
    );

    // ---------------------------------------------------------------- legacy chat (browser extension of Paperless-AI ≤ 3.x)

    const legacyHistory = new Map<string, { turns: ChatTurn[]; at: number }>();
    const historyKey = (id: number, who: string) => `${who}:${id}`;
    const prune = () => {
      const cutoff = Date.now() - 3600_000;
      for (const [k, v] of legacyHistory) if (v.at < cutoff) legacyHistory.delete(k);
    };
    const who = (p: Principal | null) => (p?.kind === 'user' ? `u${p.userId}` : 'key');

    app.get('/chat/init/:id', { schema: { hide: true, params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req) => {
      prune();
      const doc = await ctx.paperless().getDocument(req.params.id);
      legacyHistory.set(historyKey(doc.id, who(req.principal)), { turns: [], at: Date.now() });
      return { documentTitle: doc.title, initialized: true };
    });
    app.get('/chat/init', { schema: { hide: true, querystring: z.object({ documentId: z.coerce.number().int().positive() }) } }, async (req) => {
      const doc = await ctx.paperless().getDocument(req.query.documentId);
      legacyHistory.set(historyKey(doc.id, who(req.principal)), { turns: [], at: Date.now() });
      return { documentTitle: doc.title, initialized: true };
    });

    app.post(
      '/chat/message',
      { schema: { hide: true, body: z.object({ documentId: z.coerce.number().int().positive(), message: z.string().min(1).max(20_000) }) } },
      async (req, reply) => {
        const key = historyKey(req.body.documentId, who(req.principal));
        const entry = legacyHistory.get(key) ?? { turns: [], at: Date.now() };
        let answer = '';
        await sendEventStream<ChatStreamEvent>(
          req,
          reply,
          (signal) => documentChat(ctx, req.body.documentId, req.body.message, entry.turns, signal),
          (e) => {
            if (e.type === 'delta') {
              answer += e.text;
              return `data: ${JSON.stringify({ content: e.text })}\n\n`;
            }
            if (e.type === 'done') {
              entry.turns.push({ role: 'user', content: req.body.message }, { role: 'assistant', content: answer });
              entry.turns.splice(0, Math.max(0, entry.turns.length - 20));
              entry.at = Date.now();
              legacyHistory.set(key, entry);
              return 'data: [DONE]\n\n';
            }
            return '';
          },
          (message) => `data: ${JSON.stringify({ error: message })}\n\n`,
        );
      },
    );
  };
