import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { SessionInfo } from '../../shared/api.js';
import type { Services } from '../http/app.js';
import { badRequest, sendEventStream } from '../http/helpers.js';
import {
  clearSessionCookie,
  hashPassword,
  issueSession,
  setSessionCookie,
  validatePassword,
  verifyPassword,
} from '../auth.js';
import { configSchema, type AppConfig, type DeepPartial } from '../config/schema.js';
import { deepMerge } from '../config/store.js';
import { DEFAULT_SYSTEM_PROMPT } from '../config/defaults.js';
import { localEmbeddingsAvailable } from '../rag/localEmbedder.js';
import { request } from '../util/http.js';
import { logBuffer, logger, type LogEntry } from '../logger.js';
import { testAiConnection, testPaperlessConnection, withoutMaskedSecrets } from './connectionTests.js';

const log = logger.child({ module: 'auth' });
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(`dummy-${Math.random()}`));

export const systemRoutes =
  ({ ctx, rag }: Services): FastifyPluginAsync =>
  async (fastify) => {
    const app = fastify.withTypeProvider<ZodTypeProvider>();

    // ---------------------------------------------------------------- health & session

    app.get('/health', { config: { auth: 'public' }, schema: { hide: true } }, async (_req, reply) => {
      try {
        ctx.db.prepare('SELECT 1').get();
      } catch (err) {
        return reply.code(503).send({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      return { status: ctx.isConfigured() ? 'healthy' : 'not_configured', version: ctx.version };
    });

    app.get('/api/session', { config: { auth: 'public' } }, async (req): Promise<SessionInfo> => {
      const p = req.principal;
      return {
        authenticated: Boolean(p),
        setupRequired: ctx.needsSetup(),
        needsUser: ctx.repos.users.count() === 0,
        user: p?.kind === 'user' ? { id: p.userId, username: p.username } : undefined,
        version: ctx.version,
        features: { rag: ctx.cfg.rag.enabled },
      };
    });

    app.post(
      '/api/auth/login',
      {
        config: { auth: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { body: z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(200) }) },
      },
      async (req, reply) => {
        const user = ctx.repos.users.byUsername(req.body.username.trim());
        // Compare against a dummy hash for unknown users so response times do not reveal valid usernames.
        const ok = await verifyPassword(req.body.password, user?.password_hash ?? (await dummyHash()));
        if (!user || !ok) {
          log.warn(`Failed login attempt for "${req.body.username.slice(0, 50)}" from ${req.ip}`);
          return reply.code(401).send({ error: 'Invalid username or password' });
        }
        // Transparently upgrade legacy hashes (cost 15 was very slow) on login.
        if (/^\$2[aby]\$1[5-9]\$/.test(user.password_hash)) {
          ctx.repos.users.updatePassword(user.id, await hashPassword(req.body.password));
          Object.assign(user, ctx.repos.users.byId(user.id));
        }
        const token = await issueSession(ctx, user);
        setSessionCookie(reply, req, token, ctx.cfg.security.sessionHours);
        log.info(`User "${user.username}" logged in`);
        return { ok: true, user: { id: user.id, username: user.username } };
      },
    );

    app.post('/api/auth/logout', { config: { auth: 'public' } }, async (_req, reply) => {
      clearSessionCookie(reply);
      return { ok: true };
    });

    // ---------------------------------------------------------------- setup wizard

    const setupBody = z.object({
      username: z.string().trim().min(1).max(100).optional(),
      password: z.string().max(200).optional(),
      config: z.record(z.string(), z.unknown()),
      /** Save even if the AI connection test fails. */
      force: z.boolean().optional(),
    });

    app.get('/api/setup/defaults', { config: { auth: 'setup' } }, async () => ({
      config: ctx.config.redacted(),
      locked: ctx.config.lockedPaths,
      defaults: { systemPrompt: DEFAULT_SYSTEM_PROMPT },
      localEmbeddings: await localEmbeddingsAvailable(),
      needsUser: ctx.repos.users.count() === 0,
    }));

    app.post('/api/setup/test-paperless', { config: { auth: 'setup' }, schema: { body: z.object({ url: z.string(), token: z.string() }) } }, async (req) =>
      testPaperlessConnection(req.body.url, req.body.token || ctx.cfg.paperless.token),
    );

    app.post('/api/setup/test-ai', { config: { auth: 'setup' }, schema: { body: z.object({ ai: z.record(z.string(), z.unknown()) }) } }, async (req) =>
      testAiConnection(ctx, req.body.ai as DeepPartial<AppConfig['ai']>),
    );

    app.post('/api/setup/models', { config: { auth: 'setup' }, schema: { body: z.object({ ai: z.record(z.string(), z.unknown()) }) } }, async (req) => {
      const res = await testAiConnection(ctx, req.body.ai as DeepPartial<AppConfig['ai']>, { modelsOnly: true });
      return { models: (res.details?.models as string[] | undefined) ?? [], error: res.ok ? undefined : res.message };
    });

    app.post('/api/setup', { config: { auth: 'setup' }, schema: { body: setupBody } }, async (req, reply) => {
      if (!ctx.needsSetup()) return reply.code(409).send({ error: 'Setup has already been completed' });
      const needsUser = ctx.repos.users.count() === 0;
      if (needsUser) {
        if (!req.body.username) throw badRequest('A username is required');
        const problem = validatePassword(req.body.password ?? '');
        if (problem) throw badRequest(problem);
      }
      const patch = req.body.config as DeepPartial<AppConfig>;
      // Validate the merged configuration before testing anything.
      const merged = configSchema.parse(deepMerge(structuredClone(ctx.cfg), withoutMaskedSecrets(patch)));

      const pl = await testPaperlessConnection(merged.paperless.url, merged.paperless.token);
      if (!pl.ok) return reply.code(400).send({ error: pl.message, step: 'paperless' });
      if (!req.body.force) {
        const ai = await testAiConnection(ctx, merged.ai);
        if (!ai.ok) return reply.code(400).send({ error: ai.message, step: 'ai', canForce: true });
      }

      ctx.config.update({ ...patch, setupCompleted: true });
      let user = req.principal?.kind === 'user' ? ctx.repos.users.byId(req.principal.userId) : undefined;
      if (needsUser) {
        const id = ctx.repos.users.create(req.body.username!, await hashPassword(req.body.password!));
        user = ctx.repos.users.byId(id);
        log.info(`Created user "${req.body.username}"`);
      }
      if (user) setSessionCookie(reply, req, await issueSession(ctx, user), ctx.cfg.security.sessionHours);
      log.info('Setup completed');
      if (ctx.cfg.rag.enabled) rag.requestSync();
      return { ok: true };
    });

    // ---------------------------------------------------------------- account

    app.get('/api/account', { config: { auth: 'session' } }, async (req) => {
      const p = req.principal!;
      const users = ctx.repos.users.list().map((u) => ({ id: u.id, username: u.username, createdAt: u.created_at }));
      return { user: p.kind === 'user' ? { id: p.userId, username: p.username } : null, users };
    });

    app.post(
      '/api/account/password',
      {
        config: { auth: 'session', rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { body: z.object({ currentPassword: z.string(), newPassword: z.string(), username: z.string().trim().min(1).max(100).optional() }) },
      },
      async (req, reply) => {
        const p = req.principal!;
        if (p.kind !== 'user') return reply.code(403).send({ error: 'Not allowed' });
        const user = ctx.repos.users.byId(p.userId);
        if (!user || !(await verifyPassword(req.body.currentPassword, user.password_hash))) {
          return reply.code(400).send({ error: 'The current password is wrong' });
        }
        if (req.body.username && req.body.username !== user.username) {
          if (ctx.repos.users.byUsername(req.body.username)) throw badRequest('This username is already taken');
          ctx.repos.users.rename(user.id, req.body.username);
        }
        if (req.body.newPassword) {
          const problem = validatePassword(req.body.newPassword);
          if (problem) throw badRequest(problem);
          ctx.repos.users.updatePassword(user.id, await hashPassword(req.body.newPassword));
        }
        const fresh = ctx.repos.users.byId(user.id)!;
        setSessionCookie(reply, req, await issueSession(ctx, fresh), ctx.cfg.security.sessionHours);
        log.info(`Account "${fresh.username}" updated`);
        return { ok: true };
      },
    );

    // ---------------------------------------------------------------- logs, usage & diagnostics

    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    app.get(
      '/api/logs',
      {
        schema: {
          querystring: z.object({
            after: z.coerce.number().int().optional(),
            level: z.enum(levels).optional(),
            limit: z.coerce.number().int().min(1).max(2000).default(500),
            search: z.string().max(200).optional(),
          }),
        },
      },
      async (req) => ({ entries: logBuffer.list(req.query) }),
    );

    app.get('/api/logs/stream', { schema: { hide: true } }, async (req, reply) => {
      await sendEventStream<LogEntry>(req, reply, (signal) => {
        const queue: LogEntry[] = [];
        let wake: (() => void) | null = null;
        const onEntry = (e: LogEntry) => {
          queue.push(e);
          wake?.();
        };
        logBuffer.on('entry', onEntry);
        signal.addEventListener('abort', () => {
          logBuffer.off('entry', onEntry);
          wake?.();
        });
        return (async function* () {
          while (!signal.aborted) {
            if (!queue.length) await new Promise<void>((r) => (wake = r));
            wake = null;
            while (queue.length) yield queue.shift()!;
          }
        })();
      });
    });

    app.get('/api/usage', async () => ctx.repos.usage.stats());

    // Update check against the GitHub releases (cached, failures are silent).
    let latest: { at: number; version: string | null; url: string | null } | null = null;
    app.get('/api/update-check', { schema: { hide: true } }, async () => {
      if (!latest || Date.now() - latest.at > 6 * 3600_000) {
        try {
          const res = await request<{ tag_name?: string; html_url?: string }>('https://api.github.com/repos/clusterzx/paperless-ai/releases/latest', {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'paperless-ai' },
            timeoutMs: 8000,
          });
          latest = { at: Date.now(), version: res?.tag_name?.replace(/^v/, '') ?? null, url: res?.html_url ?? null };
        } catch {
          latest = { at: Date.now(), version: null, url: null };
        }
      }
      return { current: ctx.version, latest: latest.version, url: latest.url, updateAvailable: Boolean(latest.version && compareVersions(latest.version, ctx.version) > 0) };
    });

    const debugResources = ['documents', 'tags', 'correspondents', 'document_types', 'custom_fields', 'ui_settings', 'statistics'] as const;
    app.get(
      '/api/debug/paperless/:resource',
      { config: { auth: 'session' }, schema: { params: z.object({ resource: z.enum(debugResources) }) } },
      async (req) => {
        const r = req.params.resource;
        const query = r === 'ui_settings' || r === 'statistics' ? undefined : { page_size: 25, ...(r === 'documents' ? { truncate_content: true } : {}) };
        return ctx.paperless().req(`/${r}/`, { query });
      },
    );
  };

/** Compare dotted version strings numerically (1.10.0 > 1.9.3). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
