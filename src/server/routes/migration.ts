/**
 * Migration assistant (administrators) and exports of the built-in archive.
 */
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../http/app.js';
import { HttpProblem, notFound } from '../http/helpers.js';
import { MigrationService } from '../migration/service.js';
import { exportArchive } from '../migration/export.js';
import { LocalBackend } from '../archive/backend.js';
import { isAdmin, roleIn } from '../access/scope.js';
import { audit } from '../access/context.js';
import type { ExportResult, MigrationPlan } from '../../shared/migration.js';
import { describeError } from '../util/http.js';

const rule = z.object({
  library: z.string().trim().min(1).max(100),
  owner: z.string().max(200).optional(),
  tag: z.string().max(200).optional(),
  storagePath: z.string().max(200).optional(),
  customField: z.object({ name: z.string().max(200), value: z.string().max(500) }).optional(),
});
const strategy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), libraryName: z.string().trim().min(1).max(100) }),
  z.object({ kind: z.literal('owner'), sharedName: z.string().trim().min(1).max(100) }),
  z.object({ kind: z.literal('rules'), rules: z.array(rule).max(100), defaultLibrary: z.string().trim().min(1).max(100) }),
]);
const options = z.object({ archived: z.boolean().default(false), createUsers: z.boolean().default(true), concurrency: z.number().int().min(1).max(16).default(4) }).prefault({});
const exportBody = z.object({ format: z.enum(['ngx', 'plain']), directory: z.string().trim().max(1000).optional(), libraryIds: z.array(z.number().int().positive()).max(1000).optional() });

export const migrationRoutes =
  ({ ctx, engine }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();
    const migration = new MigrationService(ctx);
    fastify.addHook('onClose', async () => migration.close());
    const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof HttpProblem) throw err;
        throw new HttpProblem(409, describeError(err));
      }
    };

    app.get('/api/migration/status', async () => migration.status());
    app.post('/api/migration/analyse', { schema: { description: 'Dry run: what is in Paperless-ngx, what it needs, what cannot be moved.' } }, async () => guard(() => migration.analyse()));
    app.post('/api/migration/plan', { schema: { body: z.object({ strategy, options }) } }, async (req): Promise<MigrationPlan> =>
      guard(async () => {
        const { libraries, users, widened } = await migration.plan(req.body.strategy, req.body.options);
        return { libraries, users, widened };
      }),
    );
    app.post('/api/migration/start', { schema: { body: z.object({ strategy, options }) } }, async (req) =>
      guard(async () => {
        const st = await migration.start(req.body.strategy, req.body.options);
        audit(ctx, req.access, 'migration.started', null, { strategy: req.body.strategy.kind });
        return st;
      }),
    );
    app.post('/api/migration/pause', async () => {
      migration.pause();
      return migration.status();
    });
    app.post('/api/migration/resume', async () => migration.resume());
    app.post('/api/migration/sync', async () => guard(() => migration.sync()));
    app.post('/api/migration/cutover', async (req) =>
      guard(async () => {
        const st = await migration.cutover({ pause: () => engine.pause(), resume: () => engine.resume() });
        audit(ctx, req.access, 'migration.cutover');
        return st;
      }),
    );
    app.post('/api/migration/rollback', async (req) =>
      guard(async () => {
        const r = migration.rollback();
        audit(ctx, req.access, 'migration.rollback', null, r);
        return r;
      }),
    );
    app.post('/api/migration/discard', async (req) =>
      guard(async () => {
        await migration.discard();
        audit(ctx, req.access, 'migration.discarded');
        return migration.status();
      }),
    );

    // ------------------------------------------------------------ exports

    const run = async (libraryIds: number[] | null, body: z.output<typeof exportBody>): Promise<ExportResult> => {
      const b = ctx.archive();
      if (!(b instanceof LocalBackend)) throw new HttpProblem(409, 'Exports are for the built-in archive – Paperless-ngx has its own document_exporter');
      const dir = body.directory || path.join(ctx.dataDir, 'exports', `${body.format}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      return guard(() => exportArchive(ctx, b.blobs, { format: body.format, directory: dir, libraryIds }));
    };
    app.post('/api/archive/export', { schema: { body: exportBody, description: 'Export documents (all or some libraries) into a directory on the server.' } }, async (req) => {
      const res = await run(req.body.libraryIds ?? null, req.body);
      audit(ctx, req.access, 'archive.exported', null, { format: res.format, documents: res.documents, directory: res.directory });
      return res;
    });
    // Owners export their library (into data/exports – they cannot choose a directory on the server).
    app.post('/api/libraries/:id/export', { schema: { params: z.object({ id: z.coerce.number().int().positive() }), body: exportBody.pick({ format: true }) } }, async (req) => {
      if (!ctx.repos.libraries.get(req.params.id)) throw notFound('Library not found');
      if (!(isAdmin(req.access!) || roleIn(req.access!, req.params.id) === 'owner')) throw new HttpProblem(403, 'Only owners of the library can export it');
      const res = await run([req.params.id], { format: req.body.format });
      audit(ctx, req.access, 'library.exported', `library:${req.params.id}`, { format: res.format, documents: res.documents }, req.params.id);
      return res;
    });
  };
