/**
 * Metadata management (tags, correspondents, document types, custom fields), saved views of the
 * document list and the live event stream of the UI.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { LiveEvent, MetadataItem, SavedView } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { badRequest, notFound, sendEventStream } from '../http/helpers.js';
import { canEdit, canRead, readableLibraries, userIdOf, type AccessScope } from '../access/scope.js';
import { CUSTOM_FIELD_TYPES } from '../config/schema.js';
import type { ArchiveDocument, ChangeOrigin, CustomFieldType, DocumentFilter, DocumentPatch, MetadataKind } from '../backend/types.js';
import type { DocumentEvent } from '../events.js';
import { documentFilterParams, documentSort } from '../http/documentQuery.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'metadata' });

const KINDS: Record<string, MetadataKind> = { tags: 'tag', correspondents: 'correspondent', 'document-types': 'documentType', 'custom-fields': 'customField' };
const id = z.object({ id: z.coerce.number().int().positive() });

export const metadataRoutes =
  ({ ctx, engine }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    /** Metadata namespaces the caller can read (Paperless-ngx: one; built-in archive: the readable libraries). */
    const scopesOf = async (scope: AccessScope, library?: number) => {
      const all = await ctx.backend(scope).metadataScopes();
      return all.filter((lib) => (library === undefined || lib === library) && (lib === null || canRead(scope, lib)));
    };

    const list = async (scope: AccessScope, kind: MetadataKind, library?: number): Promise<MetadataItem[]> => {
      const out: MetadataItem[] = [];
      for (const lib of await scopesOf(scope, library)) {
        const snap = await ctx.metadata(lib).snapshot();
        const items = kind === 'tag' ? snap.tags : kind === 'correspondent' ? snap.correspondents : kind === 'documentType' ? snap.documentTypes : snap.customFields;
        for (const i of items as (MetadataItem & { data_type?: string; extra_data?: Record<string, unknown> | null; text_color?: string })[]) {
          out.push({
            id: i.id,
            name: i.name,
            library_id: lib,
            document_count: i.document_count ?? 0,
            ...(kind === 'tag' ? { color: i.color ?? null, parent: (i as { parent?: number | null }).parent ?? null } : {}),
            ...(kind === 'customField' ? { data_type: i.data_type, extra: i.extra_data ?? null } : {}),
          });
        }
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    };

    /** The namespace of an existing metadata object; checks the caller may change it. */
    const namespaceFor = (scope: AccessScope, kind: MetadataKind, objectId: number): number | null => {
      const lib = ctx.archive().metadataLibrary(kind, objectId);
      if (lib !== null && !canEdit(scope, lib)) throw notFound('Not found');
      return lib;
    };

    for (const [path, kind] of Object.entries(KINDS)) {
      app.get(
        `/api/${path}`,
        { schema: { description: `All ${path.replace('-', ' ')} the caller can see, with document counts.`, querystring: z.object({ library: z.coerce.number().int().positive().optional() }) } },
        async (req) => list(req.access!, kind, req.query.library),
      );

      app.post(
        `/api/${path}`,
        {
          schema: {
            body: z.object({
              name: z.string().trim().min(1).max(128),
              libraryId: z.number().int().positive().optional(),
              color: z.string().max(20).optional(),
              dataType: z.enum([...CUSTOM_FIELD_TYPES, 'documentlink'] as [string, ...string[]]).optional(),
              currency: z.string().max(3).optional(),
            }),
          },
        },
        async (req): Promise<MetadataItem> => {
          const scopes = await scopesOf(req.access!);
          const lib = req.body.libraryId ?? scopes[0] ?? null;
          if (lib !== null && !canEdit(req.access!, lib)) throw notFound('Library not found');
          if (lib !== null && !scopes.includes(lib)) throw notFound('Library not found');
          const meta = ctx.metadata(lib);
          const res =
            kind === 'tag'
              ? await meta.resolveTag(req.body.name, true)
              : kind === 'correspondent'
                ? await meta.resolveCorrespondent(req.body.name, true)
                : kind === 'documentType'
                  ? await meta.resolveDocumentType(req.body.name, true)
                  : await meta.resolveCustomField(req.body.name, true, (req.body.dataType ?? 'string') as CustomFieldType, req.body.currency);
          if (res.id == null) throw badRequest('Could not create it');
          if (!res.created) throw badRequest(`"${res.name}" exists already`);
          if (kind === 'tag' && req.body.color) await ctx.backend(req.access!).updateMetadata(kind, res.id, { color: req.body.color });
          meta.invalidate();
          return (await list(req.access!, kind, lib ?? undefined)).find((i) => i.id === res.id) ?? { id: res.id, name: res.name, document_count: 0, library_id: lib };
        },
      );

      app.patch(
        `/api/${path}/:id`,
        {
          schema: {
            params: id,
            body: z.object({
              name: z.string().trim().min(1).max(128).optional(),
              color: z.string().max(20).nullable().optional(),
              parent: z.number().int().positive().nullable().optional(),
              selectOptions: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
            }),
          },
        },
        async (req) => {
          const lib = namespaceFor(req.access!, kind, req.params.id);
          await ctx.backend(req.access!).updateMetadata(kind, req.params.id, req.body);
          ctx.metadata(lib).invalidate();
          return { ok: true };
        },
      );

      app.delete(`/api/${path}/:id`, { schema: { params: id } }, async (req) => {
        const lib = namespaceFor(req.access!, kind, req.params.id);
        await ctx.backend(req.access!).deleteMetadata(kind, req.params.id);
        ctx.metadata(lib).invalidate();
        return { ok: true };
      });

      app.post(
        `/api/${path}/merge`,
        {
          schema: {
            description: 'Merge several objects into one: documents get the target instead, the others are deleted.',
            body: z.object({ sourceIds: z.array(z.number().int().positive()).min(1).max(100), targetId: z.number().int().positive() }),
          },
        },
        async (req) => {
          const scope = req.access!;
          const { targetId } = req.body;
          const sources = req.body.sourceIds.filter((s) => s !== targetId);
          const lib = namespaceFor(scope, kind, targetId);
          for (const s of sources) if (namespaceFor(scope, kind, s) !== lib) throw badRequest('Only objects of the same library can be merged');
          const backend = ctx.backend(scope);
          const filter: DocumentFilter =
            kind === 'tag' ? { tagsAny: sources } : kind === 'correspondent' ? { correspondents: sources } : kind === 'documentType' ? { documentTypes: sources } : {};
          const origin: ChangeOrigin = { actor: 'user', actorId: userIdOf(scope), ref: `merge:${randomUUID()}` };
          let changed = 0;
          const docs: ArchiveDocument[] = [];
          if (kind === 'customField') {
            for (const s of sources) {
              let cursor: string | null = null;
              do {
                const page = await backend.queryDocuments({ filter: { customFields: [{ field: s, op: 'exists' }] }, limit: 250, cursor, sort: 'added' });
                docs.push(...page.results);
                cursor = page.nextCursor;
              } while (cursor);
            }
          } else {
            let cursor: string | null = null;
            do {
              const page = await backend.queryDocuments({ filter, limit: 250, cursor, sort: 'added' });
              docs.push(...page.results);
              cursor = page.nextCursor;
            } while (cursor);
          }
          for (const listed of docs) {
            const doc = await backend.getDocument(listed.id);
            const patch: DocumentPatch = {};
            if (kind === 'tag') patch.tags = [...new Set([...(doc.tags ?? []).filter((t) => !sources.includes(t)), targetId])];
            if (kind === 'correspondent') patch.correspondent = targetId;
            if (kind === 'documentType') patch.document_type = targetId;
            if (kind === 'customField') {
              const fields = doc.custom_fields ?? [];
              const target = fields.find((f) => f.field === targetId);
              const source = fields.find((f) => sources.includes(f.field) && f.value !== null);
              patch.custom_fields = [
                ...fields.filter((f) => f.field !== targetId && !sources.includes(f.field)),
                { field: targetId, value: target?.value ?? source?.value ?? null },
              ];
            }
            await backend.updateDocument(doc.id, patch, origin);
            ctx.events.emit({ type: 'document.updated', id: doc.id, fields: Object.keys(patch), origin, libraryId: doc.library_id ?? null });
            changed++;
          }
          for (const s of sources) await backend.deleteMetadata(kind, s);
          ctx.metadata(lib).invalidate();
          log.info(`Merged ${sources.length} ${kind}(s) into ${targetId}: ${changed} document(s) changed`);
          return { ok: true, documents: changed };
        },
      );
    }

    // ---------------------------------------------------------------- saved views

    const viewDto = (v: ReturnType<typeof ctx.repos.savedViews.list>[number], userId: number): SavedView => ({
      id: v.id,
      name: v.name,
      libraryId: v.library_id,
      filter: v.filter as SavedView['filter'],
      columns: v.columns,
      inNavigation: v.in_navigation,
      shared: v.library_id !== null,
      own: v.user_id === userId,
    });
    const viewBody = z.object({
      name: z.string().trim().min(1).max(100),
      filter: documentFilterParams.extend({ sort: documentSort.optional() }),
      columns: z.array(z.string().max(40)).max(30).default([]),
      inNavigation: z.boolean().default(false),
      libraryId: z.number().int().positive().nullable().optional(),
    });
    const ownView = (viewId: number, userId: number) => {
      const v = ctx.repos.savedViews.get(viewId);
      if (!v || v.user_id !== userId) throw notFound('View not found');
      return v;
    };

    app.get('/api/saved-views', async (req): Promise<SavedView[]> => {
      const userId = userIdOf(req.access!);
      if (userId === null) return [];
      return ctx.repos.savedViews.list(userId, readableLibraries(req.access!)).map((v) => viewDto(v, userId));
    });

    app.post('/api/saved-views', { schema: { body: viewBody } }, async (req): Promise<SavedView> => {
      const userId = userIdOf(req.access!);
      if (userId === null) throw badRequest('Only users have saved views');
      if (req.body.libraryId && !canRead(req.access!, req.body.libraryId)) throw notFound('Library not found');
      const viewId = ctx.repos.savedViews.save(userId, { ...req.body, inNavigation: req.body.inNavigation });
      return viewDto(ctx.repos.savedViews.get(viewId)!, userId);
    });

    app.patch('/api/saved-views/:id', { schema: { params: id, body: viewBody.partial() } }, async (req): Promise<SavedView> => {
      const userId = userIdOf(req.access!) ?? -1;
      const v = ownView(req.params.id, userId);
      ctx.repos.savedViews.save(userId, {
        id: v.id,
        name: req.body.name ?? v.name,
        filter: req.body.filter ?? v.filter,
        columns: req.body.columns ?? v.columns,
        inNavigation: req.body.inNavigation ?? v.in_navigation,
        libraryId: req.body.libraryId !== undefined ? req.body.libraryId : v.library_id,
        position: v.position,
      });
      return viewDto(ctx.repos.savedViews.get(v.id)!, userId);
    });

    app.delete('/api/saved-views/:id', { schema: { params: id } }, async (req) => {
      ownView(req.params.id, userIdOf(req.access!) ?? -1);
      ctx.repos.savedViews.delete(req.params.id);
      return { ok: true };
    });

    // ---------------------------------------------------------------- live events

    app.get('/api/events', { schema: { description: 'Server-sent events: documents added, changed, deleted, processed (only readable documents).' } }, async (req, reply) => {
      const scope = req.access!;
      await sendEventStream<LiveEvent>(req, reply, (signal) => liveEvents(signal));

      async function* liveEvents(signal: AbortSignal): AsyncGenerator<LiveEvent> {
        const queue: LiveEvent[] = [];
        let wake: (() => void) | null = null;
        const push = (e: LiveEvent) => {
          queue.push(e);
          if (queue.length > 500) queue.shift();
          wake?.();
        };
        const offDocs = ctx.events.on((e: DocumentEvent) => {
          if (e.libraryId != null && !canRead(scope, e.libraryId)) return;
          push({ type: e.type, id: e.id });
        });
        const onJob = (documentId: number, outcome: string) => push({ type: 'processing', documentId, outcome });
        engine.on('job', onJob);
        const offIntake = ctx.events.onIntake((e) => {
          if (e.libraryId != null && !canRead(scope, e.libraryId)) return;
          push({ type: 'intake', intakeId: e.intakeId, status: e.status, documentId: e.documentId ?? null, filename: e.filename ?? null });
        });
        try {
          while (!signal.aborted) {
            if (!queue.length) await new Promise<void>((r) => ((wake = r), signal.addEventListener('abort', () => r(), { once: true })));
            wake = null;
            while (queue.length) yield queue.shift()!;
          }
        } finally {
          offDocs();
          engine.off('job', onJob);
          offIntake();
        }
      }
    });
  };
