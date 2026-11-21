import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type {
  ActivityItem,
  BulkEditInput,
  BulkEditResult,
  ChatStreamEvent,
  ChatTurn,
  DocumentDetail,
  DocumentFacetsResponse,
  DocumentListResponse,
  DocumentSummary,
  DocumentUpdateInput,
  UploadResult,
} from '../../shared/api.js';
import { documentFilterParams, documentSort, parseDocumentFilter, toRow } from '../http/documentQuery.js';
import { hasScope, roleIn, userIdOf, type AccessScope } from '../access/scope.js';
import { badRequest } from '../http/helpers.js';
import { bulkEdit, documentActivity, receiveUploads, sendFile } from './documentOps.js';
import type { Principal } from '../auth.js';
import type { Services } from '../http/app.js';
import { sendEventStream } from '../http/helpers.js';
import { analyzeContent } from '../processing/analyzer.js';
import { describePlan, planAnalysis } from '../workflows/analysis.js';
import { configSchema, type AppConfig, type DeepPartial } from '../config/schema.js';
import { deepMerge } from '../config/store.js';
import { applyPlannedUpdate, planManualUpdate } from '../processing/applier.js';
import { datePart } from '../processing/dates.js';
import type { ArchiveDocument } from '../backend/types.js';
import { documentChat } from '../rag/documentChat.js';

const chatTurn = z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(50_000) });

function summary(d: ArchiveDocument): DocumentSummary {
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
  ({ ctx, rag, ocr, engine }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    const detail = (d: ArchiveDocument, scope: AccessScope): DocumentDetail => ({
      ...toRow(d, ctx.repos.documents),
      content: d.content ?? '',
      user_can_change: d.user_can_change,
      modified: d.modified,
      added: d.added,
      url: ctx.documentLink(d.id),
      current_version: d.current_version,
      role: scope.libraries && d.library_id != null ? roleIn(scope, d.library_id) : null,
    });

    app.get('/api/metadata', async (req) => {
      const scopes = await ctx.backend(req.access!).metadataScopes();
      const metas = await Promise.all(scopes.map(async (lib) => ({ lib, meta: await ctx.metadata(lib).snapshot() })));
      const lib = (l: number | null) => (l == null ? {} : { library_id: l });
      return {
        tags: metas.flatMap(({ lib: l, meta }) => meta.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, document_count: t.document_count, ...lib(l) }))),
        correspondents: metas.flatMap(({ lib: l, meta }) => meta.correspondents.map((c) => ({ id: c.id, name: c.name, document_count: c.document_count, ...lib(l) }))),
        documentTypes: metas.flatMap(({ lib: l, meta }) => meta.documentTypes.map((d) => ({ id: d.id, name: d.name, document_count: d.document_count, ...lib(l) }))),
        customFields: metas.flatMap(({ lib: l, meta }) => meta.customFields.map((f) => ({ id: f.id, name: f.name, data_type: f.data_type, ...lib(l) }))),
      };
    });

    app.get(
      '/api/documents',
      {
        schema: {
          description: 'The document list: filters, sort and keyset pagination (cursor). `query`/`page`/`pageSize` are kept for simple pickers.',
          querystring: documentFilterParams.extend({
            query: z.string().max(500).optional(),
            page: z.coerce.number().int().min(1).optional(),
            pageSize: z.coerce.number().int().min(1).max(250).optional(),
            limit: z.coerce.number().int().min(1).max(250).optional(),
            cursor: z.string().max(500).optional(),
            sort: documentSort.optional(),
            count: z.stringbool().optional(),
          }),
        },
      },
      async (req): Promise<DocumentListResponse> => {
        const q = req.query;
        const filter = parseDocumentFilter({ ...q, q: q.q ?? q.query });
        // Without cursor and limit: page-based (the pickers of ≤ 4.4 use page/pageSize).
        const page = q.cursor === undefined && q.limit === undefined ? (q.page ?? 1) : undefined;
        const res = await ctx.backend(req.access!).queryDocuments({
          filter,
          sort: q.sort,
          limit: q.limit ?? q.pageSize ?? 25,
          cursor: q.cursor ?? null,
          page,
          withCount: q.count ?? true,
        });
        const states = ctx.repos.documents;
        return {
          count: res.count,
          ...(page ? { page } : {}),
          results: res.results.map((d) => toRow(d, states, res.snippets?.[d.id])),
          nextCursor: res.nextCursor,
        };
      },
    );

    app.get(
      '/api/documents/facets',
      { schema: { description: 'Number of documents per tag, correspondent and type within the filter.', querystring: documentFilterParams } },
      async (req): Promise<DocumentFacetsResponse> => ctx.backend(req.access!).facets(parseDocumentFilter(req.query)),
    );

    app.get('/api/documents/:id', { schema: { params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req): Promise<DocumentDetail> => {
      const d = await ctx.backend(req.access!).getDocument(req.params.id);
      return detail(d, req.access!);
    });

    app.get('/api/documents/:id/thumb', { schema: { params: z.object({ id: z.coerce.number().int().positive() }), hide: true } }, async (req, reply) => {
      const { data, contentType } = await ctx.backend(req.access!).thumbnail(req.params.id);
      return reply.header('Cache-Control', 'private, max-age=3600').type(contentType).send(data);
    });

    app.patch(
      '/api/documents/:id',
      {
        schema: {
          description: 'Change the metadata of a document. Names of tags, correspondents and types are created when missing.',
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({
            title: z.string().max(512).optional(),
            created: z.string().max(40).nullable().optional(),
            correspondent: z.string().max(256).nullable().optional(),
            documentType: z.string().max(256).nullable().optional(),
            tags: z.array(z.string().max(128)).max(200).optional(),
            customFields: z.array(z.object({ field_name: z.string().max(128), value: z.string().max(10_000) })).max(100).optional(),
            archiveSerialNumber: z.number().int().min(0).nullable().optional(),
            libraryId: z.number().int().positive().optional(),
          }),
        },
      },
      async (req): Promise<{ document: DocumentDetail; notes: string[]; changed: string[] }> => {
        const backend = ctx.backend(req.access!);
        const doc = await backend.getDocument(req.params.id);
        const plan = await planManualUpdate(ctx, doc, req.body as DocumentUpdateInput);
        if (req.body.archiveSerialNumber !== undefined && req.body.archiveSerialNumber !== (doc.archive_serial_number ?? null)) {
          plan.patch.archive_serial_number = req.body.archiveSerialNumber;
        }
        if (req.body.libraryId !== undefined && req.body.libraryId !== doc.library_id) {
          if (!backend.capabilities.libraries) throw badRequest('This archive has no libraries');
          plan.patch.library_id = req.body.libraryId;
        }
        const userId = userIdOf(req.access!);
        const updated = await applyPlannedUpdate(ctx, doc, plan, { source: 'edit', origin: { actor: 'user', actorId: userId }, scope: req.access! });
        return { document: detail(updated, req.access!), notes: plan.notes, changed: Object.keys(plan.patch) };
      },
    );

    app.delete('/api/documents/:id', { schema: { params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req) => {
      const backend = ctx.backend(req.access!);
      const doc = await backend.getDocument(req.params.id);
      const origin = { actor: 'user' as const, actorId: userIdOf(req.access!) };
      await backend.deleteDocument(doc.id, origin);
      ctx.events.emit({ type: 'document.deleted', id: doc.id, origin, libraryId: doc.library_id ?? null });
      return { ok: true, trash: backend.capabilities.trash };
    });

    app.post(
      '/api/documents/bulk',
      {
        schema: {
          description: 'Change, delete, analyse or OCR many documents – by id or by filter.',
          body: z.object({
            ids: z.array(z.number().int().positive()).max(10_000).optional(),
            filter: documentFilterParams.optional(),
            action: z.enum(['edit', 'delete', 'analyze', 'ocr', 'restore']),
            edit: z
              .object({
                addTags: z.array(z.string().max(128)).max(100).optional(),
                removeTags: z.array(z.string().max(128)).max(100).optional(),
                correspondent: z.string().max(256).nullable().optional(),
                documentType: z.string().max(256).nullable().optional(),
                customField: z.object({ name: z.string().max(128), value: z.string().max(10_000) }).optional(),
                libraryId: z.number().int().positive().optional(),
              })
              .optional(),
          }),
        },
      },
      async (req): Promise<BulkEditResult> => bulkEdit(ctx, engine, req.access!, req.body as BulkEditInput),
    );

    app.get(
      '/api/documents/:id/file',
      {
        schema: {
          description: 'The document file. Default: the archived PDF if there is one, else the original. `original=true` for the uploaded file.',
          params: z.object({ id: z.coerce.number().int().positive() }),
          querystring: z.object({ original: z.stringbool().default(false), version: z.coerce.number().int().positive().optional(), inline: z.stringbool().default(true) }),
        },
      },
      async (req, reply) => {
        const backend = ctx.backend(req.access!);
        const doc = await backend.getDocument(req.params.id);
        const file = await backend.download(doc.id, { original: req.query.original, version: req.query.version });
        return sendFile(req, reply, file.data, file.contentType, file.filename ?? doc.original_file_name ?? `document-${doc.id}`, req.query.inline);
      },
    );

    app.get(
      '/api/documents/:id/activity',
      { schema: { description: 'What happened to a document: AI analyses, OCR, changes.', params: z.object({ id: z.coerce.number().int().positive() }) } },
      async (req): Promise<ActivityItem[]> => {
        const doc = await ctx.backend(req.access!).getDocument(req.params.id);
        return documentActivity(ctx, doc.id, doc.library_id ?? null);
      },
    );

    app.post(
      '/api/documents/upload',
      { schema: { description: 'Upload one or more files (multipart/form-data, field `file`). Other fields: libraryId, title, created, tags (comma-separated), correspondent, documentType, skipAnalysis, prompt.', consumes: ['multipart/form-data'] } },
      async (req): Promise<{ results: UploadResult[] }> => ({ results: await receiveUploads(ctx, req, 'upload') }),
    );

    // Share target of the installed app (PWA): files shared from other apps land here.
    app.post('/share-target', { config: { auth: 'public' }, schema: { hide: true, consumes: ['multipart/form-data'] } }, async (req, reply) => {
      // A browser navigation: without a session go to the sign-in page instead of an error.
      if (!req.access || !hasScope(req.access, 'upload')) return reply.redirect('/login', 303);
      try {
        const results = await receiveUploads(ctx, req, 'share');
        const ok = results.filter((r) => r.status === 'stored' || r.status === 'forwarded' || r.status === 'duplicate').length;
        return reply.redirect(`/inbox?shared=${ok}&of=${results.length}`, 303);
      } catch (err) {
        return reply.redirect(`/inbox?shareError=${encodeURIComponent(err instanceof Error ? err.message : String(err))}`, 303);
      }
    });

    app.post(
      '/api/documents/:id/analyze',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          // Fastify validates a missing body as null.
          body: z
            .object({
              prompt: z.string().max(50_000).optional(),
              /** Processing settings for this analysis only (prompt wizard test). */
              processing: z.record(z.string(), z.unknown()).optional(),
            })
            .nullish(),
        },
      },
      async (req) => {
        const doc = await ctx.backend(req.access!).getDocument(req.params.id);
        const processing = req.body?.processing
          ? configSchema.parse(deepMerge(structuredClone(ctx.cfg), { processing: req.body.processing } as DeepPartial<AppConfig>)).processing
          : undefined;
        // The manual review analyses like the automatic processing: with the prompt rule that applies.
        const plan = req.body?.prompt || processing ? null : await planAnalysis(ctx, doc, { record: false });
        const result = await analyzeContent(ctx, ocr.storedText(doc) ?? doc.content ?? '', {
          feature: req.body?.prompt || processing ? 'playground' : 'manual',
          documentId: doc.id,
          customPrompt: req.body?.prompt ?? plan?.prompt?.prompt,
          filename: doc.original_file_name,
          processing: processing ?? plan?.processing,
          model: plan?.model ?? undefined,
          libraryId: doc.library_id ?? null,
        });
        return { ...result, rule: describePlan(plan) };
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
            /** Library prompt of the prompt rule the suggestion came from (recorded in the history). */
            promptId: z.number().int().positive().optional(),
          }),
        },
      },
      async (req) => {
        const doc = await ctx.backend(req.access!).getDocument(req.params.id);
        const plan = await planManualUpdate(ctx, doc, req.body);
        const prompt = req.body.promptId ? ctx.repos.prompts.get(req.body.promptId) : undefined;
        const updated = await applyPlannedUpdate(ctx, doc, plan, {
          source: 'manual',
          prompt: prompt ? { id: prompt.id, name: prompt.name } : null,
          origin: { actor: 'user', actorId: userIdOf(req.access!), ref: 'review' },
          scope: req.access!,
        });
        rag.requestSync();
        return { document: summary(updated), notes: plan.notes, changed: Object.keys(plan.patch) };
      },
    );

    // Playground: recent documents with thumbnails, analysed with a custom prompt (nothing is saved).
    app.get(
      '/api/playground/documents',
      { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(48).default(16), query: z.string().max(200).optional() }) } },
      async (req) => {
        const res = await ctx.backend(req.access!).searchDocuments({ pageSize: req.query.limit, query: req.query.query });
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
        await sendEventStream<ChatStreamEvent>(req, reply, (signal) => documentChat(ctx, req.params.id, req.body.message, req.body.history, signal, req.access!));
      },
    );

    // ---------------------------------------------------------------- legacy chat (browser extension of Paperless-AI ≤ 3.x)

    const legacyHistory = new Map<string, { turns: ChatTurn[]; at: number }>();
    const historyKey = (id: number, who: string) => `${who}:${id}`;
    // Conversations expire after an hour; at most 500 are kept (oldest dropped first).
    const remember = (key: string, entry: { turns: ChatTurn[]; at: number }) => {
      const cutoff = Date.now() - 3600_000;
      for (const [k, v] of legacyHistory) if (v.at < cutoff) legacyHistory.delete(k);
      legacyHistory.delete(key);
      legacyHistory.set(key, entry);
      while (legacyHistory.size > 500) legacyHistory.delete(legacyHistory.keys().next().value!);
    };
    const who = (p: Principal | null) => (p?.kind === 'user' ? `u${p.userId}` : 'key');

    app.get('/chat/init/:id', { schema: { hide: true, params: z.object({ id: z.coerce.number().int().positive() }) } }, async (req) => {
      const doc = await ctx.backend(req.access!).getDocument(req.params.id);
      remember(historyKey(doc.id, who(req.principal)), { turns: [], at: Date.now() });
      return { documentTitle: doc.title, initialized: true };
    });
    app.get('/chat/init', { schema: { hide: true, querystring: z.object({ documentId: z.coerce.number().int().positive() }) } }, async (req) => {
      const doc = await ctx.backend(req.access!).getDocument(req.query.documentId);
      remember(historyKey(doc.id, who(req.principal)), { turns: [], at: Date.now() });
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
          (signal) => documentChat(ctx, req.body.documentId, req.body.message, entry.turns, signal, req.access!),
          (e) => {
            if (e.type === 'delta') {
              answer += e.text;
              return `data: ${JSON.stringify({ content: e.text })}\n\n`;
            }
            if (e.type === 'done') {
              entry.turns.push({ role: 'user', content: req.body.message }, { role: 'assistant', content: answer });
              entry.turns.splice(0, Math.max(0, entry.turns.length - 20));
              entry.at = Date.now();
              remember(key, entry);
              return 'data: [DONE]\n\n';
            }
            return '';
          },
          (message) => `data: ${JSON.stringify({ error: message })}\n\n`,
        );
      },
    );
  };
