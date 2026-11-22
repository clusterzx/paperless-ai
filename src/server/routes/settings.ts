import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../http/app.js';
import { badRequest } from '../http/helpers.js';
import { configSchema, type AppConfig, type DeepPartial } from '../config/schema.js';
import { deepMerge } from '../config/store.js';
import { normalizePaperlessUrl } from '../config/legacy.js';
import { DEFAULT_SYSTEM_PROMPT } from '../config/defaults.js';
import { newApiKey } from '../auth.js';
import { audit } from '../access/context.js';
import { validateCron } from '../processing/engine.js';
import { watchFolderProblemFor } from '../archive/folder.js';
import { clearExternalApiCache, fetchExternalData } from '../processing/externalApi.js';
import { localEmbeddingsAvailable } from '../rag/localEmbedder.js';
import { cudaProviderInstalled } from '../ocr/pipeline.js';
import { logger } from '../logger.js';
import { describeError } from '../util/http.js';
import { storedPaperlessToken, testAiConnection, testPaperlessConnection, withoutMaskedSecrets } from './connectionTests.js';
import { describeOidcError, discover, oidcUsable, passwordLoginAllowed } from '../oidc.js';

const log = logger.child({ module: 'settings' });

export const settingsRoutes =
  ({ ctx, ocr }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    app.get('/api/settings', { config: { auth: 'session' } }, async () => ({
      config: ctx.config.redacted(),
      locked: ctx.config.lockedPaths,
      defaults: { systemPrompt: DEFAULT_SYSTEM_PROMPT },
      localEmbeddings: await localEmbeddingsAvailable(),
      ocr: { available: await ocr.isAvailable(), cudaAvailable: cudaProviderInstalled() },
    }));

    app.put(
      '/api/settings',
      {
        config: { auth: 'session' },
        schema: { body: z.object({ config: z.record(z.string(), z.unknown()), force: z.boolean().optional() }) },
      },
      async (req, reply) => {
        const patch = withoutMaskedSecrets(req.body.config) as DeepPartial<AppConfig>;
        if (patch.paperless?.url !== undefined) patch.paperless.url = normalizePaperlessUrl(patch.paperless.url);
        if (patch.paperless?.publicUrl) patch.paperless.publicUrl = normalizePaperlessUrl(patch.paperless.publicUrl);
        // Secrets/setup state are never changed through this endpoint.
        delete (patch as Record<string, unknown>).security;
        delete (patch as Record<string, unknown>).setupCompleted;
        delete (patch as Record<string, unknown>).version;

        const next = configSchema.parse(deepMerge(structuredClone(ctx.cfg), patch));
        const cronProblem = validateCron(next.processing.scanInterval);
        if (cronProblem) throw badRequest(`Invalid scan interval: ${cronProblem}`);
        const consumeDir = next.archive.builtin.consumeDir.trim();
        if (consumeDir && consumeDir !== ctx.cfg.archive.builtin.consumeDir.trim()) {
          const problem = watchFolderProblemFor(consumeDir, ctx.dataDir, next);
          if (problem) throw badRequest(`Watch folder: ${problem}`);
        }
        if (next.externalApi.enabled) {
          for (const [label, value] of [
            ['headers', next.externalApi.headers],
            ['body', next.externalApi.body],
          ] as const) {
            try {
              if (value.trim()) JSON.parse(value);
            } catch {
              throw badRequest(`External API ${label} must be valid JSON`);
            }
          }
        }

        // Switching the password login off must not lock everybody out.
        if (!passwordLoginAllowed(next) && passwordLoginAllowed(ctx.cfg)) {
          const me = req.principal?.kind === 'user' ? ctx.repos.users.byId(req.principal.userId) : undefined;
          if (!me?.oidc_subject) {
            return reply.code(400).send({
              error: 'Link your account with single sign-on first (Settings → Account) – otherwise you could not sign in any more',
              step: 'oidc',
            });
          }
        }
        if (!next.auth.passwordLogin && !oidcUsable(next)) {
          throw badRequest('The password login can only be switched off while single sign-on is set up');
        }

        const warnings: string[] = [];
        const o = next.auth.oidc;
        const prevOidc = ctx.cfg.auth.oidc;
        const oidcChanged = o.issuer !== prevOidc.issuer || o.clientId !== prevOidc.clientId || o.clientSecret !== prevOidc.clientSecret || o.enabled !== prevOidc.enabled;
        // A provider that cannot be reached is only accepted on request – and never as the only way in.
        if (oidcUsable(next) && oidcChanged && (!req.body.force || !passwordLoginAllowed(next))) {
          try {
            await discover(o.issuer, o.clientId, o.clientSecret);
          } catch (err) {
            return reply.code(400).send({
              error: `No OpenID Connect provider found at ${o.issuer}: ${describeOidcError(err)}`,
              step: 'oidc',
              canForce: passwordLoginAllowed(next),
            });
          }
        }
        if (!req.body.force) {
          const prev = ctx.cfg;
          if (next.paperless.url !== prev.paperless.url || next.paperless.token !== prev.paperless.token) {
            const res = await testPaperlessConnection(next.paperless.url, next.paperless.token);
            if (!res.ok) return reply.code(400).send({ error: res.message, step: 'paperless', canForce: true });
          }
          if (JSON.stringify(next.ai) !== JSON.stringify(prev.ai)) {
            const res = await testAiConnection(ctx, next.ai);
            if (!res.ok) return reply.code(400).send({ error: res.message, step: 'ai', canForce: true });
          }
        }

        ctx.config.update(patch);
        clearExternalApiCache();
        log.info('Settings saved');
        audit(ctx, req.access, 'settings.saved', null, { sections: Object.keys(patch) });

        // Create configured custom fields in Paperless right away so problems show up immediately.
        if (ctx.cfg.processing.functions.customFields && ctx.cfg.processing.customFields.length && ctx.archiveConfigured()) {
          const where = ctx.archiveMode() === 'builtin' ? 'the archive' : 'Paperless';
          try {
            for (const lib of await ctx.backend().metadataScopes()) {
              const meta = ctx.metadata(lib);
              await meta.snapshot(true);
              for (const f of ctx.cfg.processing.customFields) {
                // Select fields need options, which are maintained where the archive is.
                const res = await meta.resolveCustomField(f.name, f.type !== 'select', f.type, f.currency);
                if (res.id == null) warnings.push(`Select field "${f.name}" does not exist in ${where} – create it there with its options.`);
              }
            }
          } catch (err) {
            warnings.push(`Custom fields could not be created in ${where}: ${describeError(err)}`);
          }
        }
        return { config: ctx.config.redacted(), locked: ctx.config.lockedPaths, warnings };
      },
    );

    app.post(
      '/api/settings/test-paperless',
      { config: { auth: 'session' }, schema: { body: z.object({ url: z.string(), token: z.string().optional() }) } },
      async (req) => testPaperlessConnection(req.body.url, storedPaperlessToken(ctx, req.body.url, req.body.token, true)),
    );

    app.post('/api/settings/test-ai', { config: { auth: 'session' }, schema: { body: z.object({ ai: z.record(z.string(), z.unknown()) }) } }, async (req) =>
      testAiConnection(ctx, req.body.ai as DeepPartial<AppConfig['ai']>),
    );

    app.post('/api/settings/models', { config: { auth: 'session' }, schema: { body: z.object({ ai: z.record(z.string(), z.unknown()) }) } }, async (req) => {
      const res = await testAiConnection(ctx, req.body.ai as DeepPartial<AppConfig['ai']>, { modelsOnly: true });
      return { models: (res.details?.models as string[] | undefined) ?? [], error: res.ok ? undefined : res.message };
    });

    app.post(
      '/api/settings/test-external-api',
      { config: { auth: 'session' }, schema: { body: z.object({ externalApi: z.record(z.string(), z.unknown()) }) } },
      async (req) => {
        const cfg = configSchema.shape.externalApi.parse({ ...ctx.cfg.externalApi, ...req.body.externalApi, enabled: true });
        try {
          const data = await fetchExternalData(cfg, false);
          if (data === undefined) return { ok: false, message: 'The request failed – see the logs for details' };
          const preview = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
          return { ok: true, message: 'External API responded successfully', details: { preview: preview.slice(0, 5000) } };
        } catch (err) {
          return { ok: false, message: describeError(err) };
        }
      },
    );

    app.get('/api/settings/api-key', { config: { auth: 'session' } }, async () => ({ apiKey: ctx.cfg.security.apiKey }));

    app.post('/api/settings/api-key/regenerate', { config: { auth: 'session' } }, async (req) => {
      audit(ctx, req.access, 'apikey.legacy_regenerated');
      if (ctx.config.lockedPaths['security.apiKey']) throw badRequest('The API key is set via the API_KEY environment variable and cannot be changed here');
      const apiKey = newApiKey();
      ctx.config.update({ security: { apiKey } });
      log.info('API key regenerated');
      return { apiKey };
    });

    // Legacy endpoint of Paperless-AI ≤ 3.x
    app.post('/api/key-regenerate', { config: { auth: 'session' }, schema: { hide: true } }, async () => {
      if (ctx.config.lockedPaths['security.apiKey']) throw badRequest('The API key is set via the API_KEY environment variable and cannot be changed here');
      const apiKey = newApiKey();
      ctx.config.update({ security: { apiKey } });
      return { success: apiKey, apiKey };
    });
  };
