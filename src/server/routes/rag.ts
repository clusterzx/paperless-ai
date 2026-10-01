import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ChatStreamEvent, RagSource } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { HttpProblem, sendEventStream } from '../http/helpers.js';

const filters = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
    correspondent: z.string().max(200).optional(),
    documentType: z.string().max(200).optional(),
  })
  .optional();

const chatTurn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(50_000) });

export const ragRoutes =
  ({ ctx, rag }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    const requireEnabled = () => {
      if (!rag.enabled) throw new HttpProblem(409, 'The document chat (RAG) is disabled in the settings');
    };

    app.get('/api/rag/status', async () => rag.status());

    app.post('/api/rag/sync', async () => {
      requireEnabled();
      void rag.sync();
      return rag.status();
    });

    app.post('/api/rag/rebuild', { config: { auth: 'session' } }, async () => {
      requireEnabled();
      await rag.rebuild();
      return rag.status();
    });

    app.get('/api/rag/filters', async () => ({
      correspondents: rag.store.distinctValues('correspondent').sort((a, b) => a.localeCompare(b)),
      documentTypes: rag.store.distinctValues('document_type').sort((a, b) => a.localeCompare(b)),
    }));

    app.post(
      '/api/rag/search',
      { schema: { body: z.object({ query: z.string().min(1).max(2000), filters, limit: z.number().int().min(1).max(50).optional() }) } },
      async (req): Promise<{ sources: RagSource[]; mode: string; tookMs: number }> => {
        requireEnabled();
        const result = await rag.search(req.body.query, { filters: req.body.filters, limit: req.body.limit ?? 20 });
        return { sources: rag.toSources(result), mode: result.mode, tookMs: result.tookMs };
      },
    );

    app.post(
      '/api/rag/chat',
      { schema: { body: z.object({ question: z.string().min(1).max(20_000), history: z.array(chatTurn).max(50).default([]), filters }) } },
      async (req, reply) => {
        requireEnabled();
        ctx.llm(); // fail fast (before streaming) if the AI provider is not configured
        await sendEventStream<ChatStreamEvent>(req, reply, (signal) => rag.chat(req.body.question, req.body.history, { filters: req.body.filters, signal }));
      },
    );

    // Legacy, non-streaming endpoint of Paperless-AI ≤ 3.x
    app.post(
      '/api/rag/ask',
      { schema: { hide: true, body: z.object({ question: z.string().min(1).max(20_000) }).passthrough() } },
      async (req) => {
        requireEnabled();
        let answer = '';
        let sources: RagSource[] = [];
        for await (const e of rag.chat(req.body.question, [])) {
          if (e.type === 'delta') answer += e.text;
          else if (e.type === 'sources') sources = e.sources;
        }
        return {
          answer,
          sources: sources.map((s) => ({ title: s.title, snippet: s.snippet, correspondent: s.correspondent, date: s.created, doc_id: s.documentId })),
        };
      },
    );
  };
