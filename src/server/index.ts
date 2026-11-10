/**
 * Paperless-AI entry point.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppContext } from './context.js';
import { buildApp } from './http/app.js';
import { ProcessingEngine } from './processing/engine.js';
import { RagService } from './rag/service.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'main' });

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  const dataDir = path.resolve(process.env.PAPERLESS_AI_DATA_DIR ?? path.join(process.cwd(), 'data'));
  const port = Number(process.env.PAPERLESS_AI_PORT ?? process.env.PORT ?? 3000);
  const host = process.env.PAPERLESS_AI_HOST ?? '0.0.0.0';

  const ctx = new AppContext({ dataDir });
  log.info(`Paperless-AI ${ctx.version} starting (data directory: ${dataDir})`);

  const engine = new ProcessingEngine(ctx);
  const rag = new RagService(ctx);
  // Keep the search index fresh after documents were changed by the AI.
  engine.on('idle', () => rag.requestSync());

  const staticCandidates = [path.join(root, 'dist', 'public'), path.join(here, '..', 'public')];
  const staticDir = staticCandidates.find((d) => fs.existsSync(path.join(d, 'index.html')));
  const app = await buildApp({ ctx, engine, rag }, { staticDir });

  await app.listen({ port, host });
  log.info(`Web interface available on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (ctx.needsSetup()) log.info('Setup required – open the web interface to configure Paperless-AI');

  engine.start();
  rag.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down…`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    try {
      await app.close();
      await Promise.all([engine.stop(), rag.stop()]);
      ctx.close();
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error({ err: reason }, 'Unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start Paperless-AI');
  process.exit(1);
});
