/**
 * Routes of the built-in archive: libraries and their members, intake (inbox), trash, file versions,
 * the change log undo and an upload endpoint compatible with Paperless-ngx's post_document.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DocumentRow } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { badRequest, HttpProblem, notFound } from '../http/helpers.js';
import { canRead, isAdmin, roleIn, userIdOf, type AccessScope } from '../access/scope.js';
import { audit } from '../access/context.js';
import { LocalBackend } from '../archive/backend.js';
import { notSupported, type ChangeOrigin } from '../backend/types.js';
import { toRow } from '../http/documentQuery.js';
import { receiveUploads } from './documentOps.js';
import { diffLines } from '../archive/diff.js';

const id = z.object({ id: z.coerce.number().int().positive() });

export interface LibraryInfo {
  id: number;
  name: string;
  description: string;
  role: 'owner' | 'editor' | 'viewer' | null;
  documents: number;
  settings: Record<string, unknown>;
  createdAt: number;
}

export const archiveRoutes =
  ({ ctx }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    /** The built-in archive, or 409 in companion mode. */
    const local = (what = 'This'): LocalBackend => {
      const b = ctx.archive();
      if (!(b instanceof LocalBackend)) throw notSupported(what);
      return b;
    };
    const origin = (scope: AccessScope, ref?: string): ChangeOrigin => ({ actor: 'user', actorId: userIdOf(scope), ref: ref ?? null });

    // ---------------------------------------------------------------- libraries

    const libraryInfo = (scope: AccessScope): LibraryInfo[] => {
      const counts = new Map(
        (ctx.db.prepare('SELECT library_id AS id, COUNT(*) AS c FROM lib_documents WHERE deleted_at IS NULL GROUP BY library_id').all() as { id: number; c: number }[]).map((r) => [r.id, r.c]),
      );
      return ctx.repos.libraries
        .list()
        .filter((l) => canRead(scope, l.id) || isAdmin(scope))
        .map((l) => ({
          id: l.id,
          name: l.name,
          description: l.description,
          role: scope.libraries ? (scope.libraries.get(l.id) ?? null) : 'owner',
          documents: counts.get(l.id) ?? 0,
          settings: l.settings as Record<string, unknown>,
          createdAt: l.created_at,
        }));
    };

    app.get('/api/libraries', async (req): Promise<LibraryInfo[]> => {
      local('Libraries');
      return libraryInfo(req.access!);
    });

    const settingsSchema = z
      .object({
        trashDays: z.number().int().min(1).max(3650).optional(),
        maxVersions: z.number().int().min(0).max(1000).optional(),
        maxVersionAgeDays: z.number().int().min(0).max(36500).optional(),
        reanalyzeOnNewVersion: z.boolean().optional(),
        allowDuplicates: z.boolean().optional(),
      })
      .optional();

    app.post(
      '/api/libraries',
      { schema: { body: z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).default(''), settings: settingsSchema }) } },
      async (req): Promise<LibraryInfo> => {
        local('Libraries');
        const scope = req.access!;
        const userId = userIdOf(scope);
        if (!isAdmin(scope) && !ctx.cfg.archive.builtin.membersCreateLibraries) throw new HttpProblem(403, 'Only administrators can create libraries');
        const libId = ctx.repos.libraries.create(req.body.name, userId, { trashDays: ctx.cfg.archive.builtin.trashDays, ...(req.body.settings ?? {}) }, req.body.description);
        audit(ctx, scope, 'library.created', `library:${libId}`, { name: req.body.name }, libId);
        // The creator's own scope learns about the new library with the next request.
        return { id: libId, name: req.body.name, description: req.body.description, role: userId ? 'owner' : null, documents: 0, settings: req.body.settings ?? {}, createdAt: Date.now() };
      },
    );

    const ownerOrAdmin = (scope: AccessScope, libId: number) => {
      if (!ctx.repos.libraries.get(libId) || ctx.repos.libraries.get(libId)!.deleted_at) throw notFound('Library not found');
      if (!(roleIn(scope, libId) === 'owner' || isAdmin(scope))) throw new HttpProblem(403, 'Only owners of the library can do this');
    };

    app.patch(
      '/api/libraries/:id',
      { schema: { params: id, body: z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).optional(), settings: settingsSchema }) } },
      async (req) => {
        local('Libraries');
        ownerOrAdmin(req.access!, req.params.id);
        ctx.repos.libraries.update(req.params.id, req.body);
        audit(ctx, req.access, 'library.changed', `library:${req.params.id}`, { name: req.body.name, settings: req.body.settings }, req.params.id);
        return { ok: true };
      },
    );

    app.delete('/api/libraries/:id', { schema: { params: id } }, async (req) => {
      local('Libraries');
      ownerOrAdmin(req.access!, req.params.id);
      const docs = (ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents WHERE library_id = ?').get(req.params.id) as { c: number }).c;
      if (docs) throw badRequest(`The library still has ${docs} document(s) (including the trash) – move or delete them first`);
      if (ctx.repos.libraries.count() <= 1) throw badRequest('The last library cannot be deleted');
      ctx.repos.libraries.markDeleted(req.params.id);
      audit(ctx, req.access, 'library.deleted', `library:${req.params.id}`, {}, req.params.id);
      return { ok: true };
    });

    app.get('/api/libraries/:id/members', { schema: { params: id } }, async (req) => {
      local('Libraries');
      if (!canRead(req.access!, req.params.id) && !isAdmin(req.access!)) throw notFound('Library not found');
      return ctx.repos.libraries.members(req.params.id).map((m) => ({ type: m.principal_type, id: m.principal_id, name: m.name, role: m.role }));
    });

    app.put(
      '/api/libraries/:id/members',
      {
        schema: {
          params: id,
          body: z.object({ members: z.array(z.object({ type: z.enum(['user', 'group']), id: z.number().int().positive(), role: z.enum(['owner', 'editor', 'viewer']) })).max(1000) }),
        },
      },
      async (req) => {
        local('Libraries');
        ownerOrAdmin(req.access!, req.params.id);
        const members = req.body.members.filter((m) => (m.type === 'user' ? ctx.repos.users.byId(m.id) : ctx.repos.groups.get(m.id)));
        if (!members.some((m) => m.role === 'owner')) throw badRequest('A library needs at least one owner');
        ctx.repos.libraries.setMembers(req.params.id, members);
        audit(ctx, req.access, 'library.members_changed', `library:${req.params.id}`, { members: members.map((m) => `${m.type}:${m.id}=${m.role}`) }, req.params.id);
        return { ok: true };
      },
    );

    // ---------------------------------------------------------------- watch folders of a library

    const folderBody = z.object({
      path: z.string().trim().min(1).max(1000),
      subfolders: z.enum(['ignore', 'tags', 'library']).default('tags'),
      after: z.enum(['delete', 'move']).default('delete'),
      tags: z.array(z.string().max(128)).max(50).default([]),
      skipAnalysis: z.boolean().default(false),
      enabled: z.boolean().default(true),
    });
    const folderDto = (r: { id: number; library_id: number; path: string; hints: string; subfolders: string; after: string; enabled: number }) => {
      const hints = JSON.parse(r.hints || '{}') as { tags?: string[]; skipAnalysis?: boolean };
      return { id: r.id, libraryId: r.library_id, path: r.path, subfolders: r.subfolders, after: r.after, tags: hints.tags ?? [], skipAnalysis: Boolean(hints.skipAnalysis), enabled: Boolean(r.enabled) };
    };

    app.get('/api/libraries/:id/intake/folders', { schema: { params: id } }, async (req) => {
      local('Watch folders');
      ownerOrAdmin(req.access!, req.params.id);
      return (ctx.db.prepare('SELECT * FROM intake_folders WHERE library_id = ? ORDER BY path').all(req.params.id) as Parameters<typeof folderDto>[0][]).map(folderDto);
    });

    app.post('/api/libraries/:id/intake/folders', { schema: { params: id, body: folderBody } }, async (req) => {
      const b = local('Watch folders');
      // Folders are paths on the server: only administrators may point the archive at one.
      if (!isAdmin(req.access!)) throw new HttpProblem(403, 'Only administrators can add watch folders');
      ownerOrAdmin(req.access!, req.params.id);
      const hints = JSON.stringify({ ...(req.body.tags.length ? { tags: req.body.tags } : {}), ...(req.body.skipAnalysis ? { skipAnalysis: true } : {}) });
      try {
        ctx.db
          .prepare('INSERT INTO intake_folders (library_id, path, hints, subfolders, after, act_as, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(req.params.id, req.body.path, hints, req.body.subfolders, req.body.after, userIdOf(req.access!), req.body.enabled ? 1 : 0);
      } catch (err) {
        if (err instanceof Error && /UNIQUE/.test(err.message)) throw badRequest('This folder is watched already');
        throw err;
      }
      b.startIntake();
      audit(ctx, req.access, 'library.changed', `library:${req.params.id}`, { watchFolder: req.body.path }, req.params.id);
      return { ok: true };
    });

    app.delete('/api/intake/folders/:id', { schema: { params: id } }, async (req) => {
      local('Watch folders');
      const row = ctx.db.prepare('SELECT library_id FROM intake_folders WHERE id = ?').get(req.params.id) as { library_id: number } | undefined;
      if (!row) throw notFound('Folder not found');
      ownerOrAdmin(req.access!, row.library_id);
      ctx.db.prepare('DELETE FROM intake_folders WHERE id = ?').run(req.params.id);
      return { ok: true };
    });

    // ---------------------------------------------------------------- intake

    app.get(
      '/api/intake',
      { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), status: z.string().max(20).optional() }) } },
      async (req) => {
        local('The inbox');
        const scope = req.access!;
        const libs = scope.libraries ? [...scope.libraries.keys()] : null;
        const rows = ctx.db
          .prepare(
            `SELECT * FROM lib_intake WHERE (? IS NULL OR library_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`,
          )
          .all(libs ? 1 : null, JSON.stringify(libs ?? []), req.query.status ?? null, req.query.status ?? null, req.query.limit) as {
          id: number;
          channel: string;
          filename: string | null;
          status: string;
          document_id: number | null;
          library_id: number | null;
          error: string | null;
          created_at: number;
        }[];
        return rows.map((r) => ({ id: r.id, channel: r.channel, filename: r.filename, status: r.status, documentId: r.document_id, libraryId: r.library_id, error: r.error, createdAt: r.created_at }));
      },
    );

    app.post('/api/intake/:id/retry', { schema: { params: id } }, async (req) => local('The inbox').ingestService.retry(req.access!, req.params.id));

    // Paperless-ngx compatible upload: scanner apps and shortcuts made for Paperless-ngx can upload here.
    const postDocument = async (req: FastifyRequest, reply: FastifyReply) => {
      const b = local('post_document');
      const results = await receiveUploads(ctx, req, 'api', {}, async (fields) => {
        const meta = ctx.metadata(b.targetLibrary(req.access!));
        await meta.snapshot();
        const name = (kind: 'tag' | 'correspondent' | 'documentType', v: string) => {
          const n = Number(v);
          const list = kind === 'tag' ? meta.current.tags : kind === 'correspondent' ? meta.current.correspondents : meta.current.documentTypes;
          return Number.isInteger(n) ? list.find((x) => x.id === n)?.name : v;
        };
        return {
          title: fields.title?.[0],
          created: fields.created?.[0]?.slice(0, 10),
          correspondent: fields.correspondent?.[0] ? name('correspondent', fields.correspondent[0]) : undefined,
          documentType: fields.document_type?.[0] ? name('documentType', fields.document_type[0]) : undefined,
          tags: (fields.tags ?? []).map((t) => name('tag', t)).filter((t): t is string => Boolean(t)),
          archiveSerialNumber: fields.archive_serial_number?.[0] ? Number(fields.archive_serial_number[0]) : undefined,
        };
      }, 'document');
      const r = results[0];
      if (r.status === 'rejected') throw badRequest(r.reason ?? 'The document was not accepted');
      // Paperless-ngx answers with the id of the consumption task as a JSON string.
      return reply.type('application/json').send(JSON.stringify(`intake-${r.intakeId ?? r.documentId}`));
    };
    app.post('/api/documents/post_document/', { schema: { hide: true, consumes: ['multipart/form-data'] } }, postDocument);

    // ---------------------------------------------------------------- trash

    app.get(
      '/api/trash',
      { schema: { querystring: z.object({ limit: z.coerce.number().int().min(1).max(250).default(100) }) } },
      async (req): Promise<(DocumentRow & { deletedAt: number; deletedBy: string | null; purgeAt: number | null })[]> => {
        const b = local('The trash');
        const scope = req.access!;
        const libs = scope.libraries ? [...scope.libraries.keys()] : null;
        const rows = ctx.db
          .prepare(
            `SELECT d.*, (SELECT username FROM users WHERE id = d.deleted_by) AS deleted_by_name FROM lib_documents d
             WHERE d.deleted_at IS NOT NULL AND (? IS NULL OR d.library_id IN (SELECT value FROM json_each(?))) ORDER BY d.deleted_at DESC LIMIT ?`,
          )
          .all(libs ? 1 : null, JSON.stringify(libs ?? []), req.query.limit) as (Parameters<LocalBackend['purgeRow']>[0] & { deleted_by_name: string | null })[];
        const docs = b.toDocuments(rows, scope, false);
        const defaultDays = ctx.cfg.archive.builtin.trashDays;
        return docs.map((d, i) => {
          const days = ctx.repos.libraries.get(rows[i].library_id)?.settings.trashDays ?? defaultDays;
          return { ...toRow(d, ctx.repos.documents), deletedAt: rows[i].deleted_at!, deletedBy: rows[i].deleted_by_name, purgeAt: rows[i].deleted_at! + days * 86_400_000 };
        });
      },
    );

    app.post(
      '/api/trash/purge',
      { schema: { body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(10_000) }) } },
      async (req) => {
        const b = local('The trash');
        let purged = 0;
        const failed: { id: number; error: string }[] = [];
        for (const docId of req.body.ids) {
          try {
            b.purge(req.access!, docId, origin(req.access!, 'trash'));
            ctx.events.emit({ type: 'document.purged', id: docId });
            purged++;
          } catch (err) {
            failed.push({ id: docId, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return { purged, failed };
      },
    );

    // ---------------------------------------------------------------- versions

    app.get('/api/documents/:id/versions', { schema: { params: id } }, async (req) => {
      const b = local('File versions');
      const row = b.readableRow(req.access!, req.params.id);
      return b.versions(req.access!, req.params.id).map((v) => ({
        version: v.version,
        kind: v.kind,
        filename: v.original_filename,
        mimeType: v.mime_type,
        size: v.size,
        pages: v.page_count,
        comment: v.comment,
        createdAt: v.created_at,
        createdBy: v.created_by_name,
        textLength: v.text_length,
        textSource: v.text_source,
        current: v.version === row.current_version,
      }));
    });

    app.post(
      '/api/documents/:id/versions',
      { schema: { params: id, description: 'Upload a new version (multipart field `file`, optional `comment`).', consumes: ['multipart/form-data'] } },
      async (req) => {
        local('File versions');
        const results = await receiveUploads(ctx, req, 'upload', { replaces: req.params.id });
        return { results };
      },
    );

    app.post('/api/documents/:id/versions/:version/activate', { schema: { params: z.object({ id: z.coerce.number().int().positive(), version: z.coerce.number().int().positive() }) } }, async (req) => {
      const b = local('File versions');
      b.activateVersion(req.access!, req.params.id, req.params.version, origin(req.access!));
      const row = b.row(req.params.id)!;
      ctx.events.emit({ type: 'document.updated', id: row.id, fields: ['version'], origin: origin(req.access!), libraryId: row.library_id });
      return { ok: true };
    });

    app.delete('/api/documents/:id/versions/:version', { schema: { params: z.object({ id: z.coerce.number().int().positive(), version: z.coerce.number().int().positive() }) } }, async (req) => {
      const b = local('File versions');
      const row = b.readableRow(req.access!, req.params.id);
      if (roleIn(req.access!, row.library_id) !== 'owner') throw new HttpProblem(403, 'Only owners of the library can delete versions');
      b.removeVersion(row, req.params.version, origin(req.access!));
      return { ok: true };
    });

    app.get(
      '/api/documents/:id/text/diff',
      { schema: { params: id, querystring: z.object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive() }) } },
      async (req) => {
        const b = local('File versions');
        return { lines: diffLines(b.versionText(req.access!, req.params.id, req.query.from), b.versionText(req.access!, req.params.id, req.query.to)) };
      },
    );

    // ---------------------------------------------------------------- change log undo

    app.post(
      '/api/documents/:id/events/:eventId/undo',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive(), eventId: z.coerce.number().int().positive() }),
          body: z.object({ force: z.boolean().optional() }).nullish(),
        },
      },
      async (req) => {
      const b = local('The change log');
      const res = await b.undoEvent(req.access!, req.params.id, req.params.eventId, origin(req.access!, `undo:${req.params.eventId}`), Boolean(req.body?.force));
      ctx.events.emit({ type: 'document.updated', id: req.params.id, fields: res.fields, origin: origin(req.access!), libraryId: res.libraryId });
      return { ok: true, fields: res.fields };
      },
    );

    // ---------------------------------------------------------------- status

    app.get('/api/archive/status', async () => {
      const b = local('Archive status');
      const kv = ctx.repos.kv;
      return {
        storageDir: b.blobs.root,
        storeId: b.blobs.storeId(),
        documents: (ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents WHERE deleted_at IS NULL').get() as { c: number }).c,
        trash: (ctx.db.prepare('SELECT COUNT(*) AS c FROM lib_documents WHERE deleted_at IS NOT NULL').get() as { c: number }).c,
        files: (ctx.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS bytes FROM blobs').get() as { c: number; bytes: number }),
        libraries: ctx.repos.libraries.count(),
        quickCheck: kv.get<string>('archive.quick_check') ?? null,
        quickCheckAt: kv.get<number>('archive.quick_check_at') ?? null,
        corruptFiles: kv.get<string[]>('archive.corrupt_blobs') ?? [],
      };
    });

    app.post('/api/archive/maintenance', async () => local('Archive maintenance').maintenance.run());
  };
