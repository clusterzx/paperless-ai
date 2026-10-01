import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { AppContext } from '../context.js';
import { NotConfiguredError } from '../context.js';
import type { ProcessingEngine } from '../processing/engine.js';
import type { RagService } from '../rag/service.js';
import { authenticate } from '../auth.js';
import { PaperlessError } from '../paperless/client.js';
import { AiError } from '../ai/types.js';
import { logger } from '../logger.js';
import { HttpProblem } from './helpers.js';
import { systemRoutes } from '../routes/system.js';
import { settingsRoutes } from '../routes/settings.js';
import { processingRoutes } from '../routes/processing.js';
import { documentRoutes } from '../routes/documents.js';
import { ragRoutes } from '../routes/rag.js';

export interface Services {
  ctx: AppContext;
  engine: ProcessingEngine;
  rag: RagService;
}

/** Who may call a route. */
export type AuthLevel = 'public' | 'user' | 'session' | 'setup';

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: AuthLevel;
  }
}

export interface AppOptions {
  /** Directory with the built web UI (index.html). */
  staticDir?: string;
}

export async function buildApp(services: Services, opts: AppOptions = {}): Promise<FastifyInstance> {
  const { ctx } = services;
  const app = Fastify({
    loggerInstance: logger.child({ module: 'http' }) as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: process.env.TRUST_PROXY !== 'false',
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Paperless-AI API',
        description: 'REST API of Paperless-AI. Authenticate with the `x-api-key` header (Settings → API key) or a session cookie.',
        version: ctx.version,
      },
      components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' } } },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api-docs' });

  // CORS: any origin may call the API with an API key (browser extension), but
  // credentials (cookies) are never shared cross-origin.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Access-Control-Allow-Private-Network');
    reply.header('Access-Control-Allow-Private-Network', 'true');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  app.decorateRequest('principal', null);
  app.addHook('preHandler', async (req, reply) => {
    // API routes require authentication unless they opt out; static assets and docs are public.
    const url = req.routeOptions.url ?? '';
    const level: AuthLevel = req.routeOptions.config?.auth ?? (url.startsWith('/api/') || url.startsWith('/chat/') ? 'user' : 'public');
    req.principal = await authenticate(ctx, req);
    if (level === 'public') return;
    if (level === 'setup') {
      if (ctx.needsSetup() && ctx.repos.users.count() === 0) return;
      if (!req.principal) return reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    if (!req.principal) return reply.code(401).send({ error: 'Authentication required' });
    if (level === 'session' && req.principal.kind !== 'user') {
      return reply.code(403).send({ error: 'This action requires a logged-in user (API keys are not allowed)' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpProblem) return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid input', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.validation) return reply.code(400).send({ error: `Invalid request: ${err.message}` });
    if (err instanceof NotConfiguredError) return reply.code(409).send({ error: err.message, code: 'not_configured' });
    if (err instanceof PaperlessError) {
      // Paperless "not found" is a 404 for our client too; everything else is an upstream problem.
      return reply.code(err.status === 404 ? 404 : 502).send({ error: err.message, code: 'paperless_error' });
    }
    if (err instanceof AiError) return reply.code(502).send({ error: err.message, code: 'ai_error' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    logger.error({ err, module: 'http', url: req.url }, 'Unhandled error');
    return reply.code(500).send({ error: err.message || 'Internal server error' });
  });

  await app.register(systemRoutes(services));
  await app.register(settingsRoutes(services));
  await app.register(processingRoutes(services));
  await app.register(documentRoutes(services));
  await app.register(ragRoutes(services));

  // Web UI (single page app)
  const staticDir = opts.staticDir;
  const indexFile = staticDir ? path.join(staticDir, 'index.html') : null;
  const hasUi = Boolean(indexFile && fs.existsSync(indexFile));
  if (hasUi && staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      index: false,
      wildcard: false,
      maxAge: '7d',
      immutable: true,
      setHeaders: (res, file) => {
        if (file.endsWith('.html')) res.header('Cache-Control', 'no-cache');
      },
    });
  }
  const indexHtml = hasUi ? fs.readFileSync(indexFile!, 'utf8') : null;
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/chat/');
    if (req.method === 'GET' && !isApi && indexHtml) {
      return reply
        .type('text/html; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .header(
          'Content-Security-Policy',
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'",
        )
        .send(indexHtml);
    }
    if (req.method === 'GET' && !isApi && !indexHtml) {
      return reply.type('text/plain').send('Paperless-AI API is running. The web UI has not been built (run "npm run build").');
    }
    return reply.code(404).send({ error: `Route ${req.method} ${req.url.split('?')[0]} not found` });
  });

  return app;
}
