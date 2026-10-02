/**
 * Application context: owns configuration, database and lazily (re)created
 * service clients. Clients are rebuilt automatically when the relevant part
 * of the configuration changes – no restart required after saving settings.
 */
import path from 'node:path';
import type { AppConfig } from './config/schema.js';
import { ConfigStore } from './config/store.js';
import { importLegacyDatabase, openDatabase, type Db } from './db/database.js';
import { createRepos, type NewUsage, type Repos } from './db/repos.js';
import { PaperlessClient, documentUrl } from './paperless/client.js';
import { PaperlessMetadata } from './paperless/metadata.js';
import { activeModel, aiConfigProblem, createLlmClient } from './ai/factory.js';
import type { CompletionResult, LlmClient, Usage } from './ai/types.js';
import { logger } from './logger.js';

export const VERSION = '4.0.0';

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export interface ContextOptions {
  dataDir: string;
  env?: Record<string, string | undefined>;
  /** Use an in-memory database (tests). */
  memoryDb?: boolean;
}

export class AppContext {
  readonly config: ConfigStore;
  readonly db: Db;
  readonly repos: Repos;
  readonly dataDir: string;
  readonly version = VERSION;

  private paperlessCache: { key: string; client: PaperlessClient; metadata: PaperlessMetadata } | null = null;
  private llmCache: { key: string; client: LlmClient } | null = null;

  constructor(opts: ContextOptions) {
    this.dataDir = opts.dataDir;
    this.config = ConfigStore.load(opts.dataDir, opts.env ?? process.env);
    this.config.ensureSecrets();
    this.db = openDatabase(opts.memoryDb ? ':memory:' : path.join(opts.dataDir, 'paperless-ai.db'));
    this.repos = createRepos(this.db);
    if (!opts.memoryDb) importLegacyDatabase(this.db, path.join(opts.dataDir, 'documents.db'));
    this.config.on('change', (next, prev) => this.onConfigChange(next, prev));
  }

  get cfg(): AppConfig {
    return this.config.current;
  }

  private onConfigChange(next: AppConfig, prev: AppConfig): void {
    if (JSON.stringify(next.paperless) !== JSON.stringify(prev.paperless)) this.paperlessCache = null;
    if (JSON.stringify(next.ai) !== JSON.stringify(prev.ai)) this.llmCache = null;
    logger.child({ module: 'config' }).info('Configuration updated');
  }

  paperlessConfigured(): boolean {
    return Boolean(this.cfg.paperless.url && this.cfg.paperless.token);
  }

  /** Setup finished and both Paperless and the AI provider are configured. */
  isConfigured(): boolean {
    return this.cfg.setupCompleted && this.paperlessConfigured() && aiConfigProblem(this.cfg.ai) === null;
  }

  needsSetup(): boolean {
    return this.repos.users.count() === 0 || !this.cfg.setupCompleted;
  }

  private paperlessEntry() {
    if (!this.paperlessConfigured()) throw new NotConfiguredError('Paperless-ngx is not configured yet');
    const key = `${this.cfg.paperless.url}|${this.cfg.paperless.token}`;
    if (this.paperlessCache?.key !== key) {
      const client = new PaperlessClient({ url: this.cfg.paperless.url, token: this.cfg.paperless.token });
      const metadata = new PaperlessMetadata(client, undefined, { shareCreated: () => this.cfg.processing.shareCreatedObjects });
      this.paperlessCache = { key, client, metadata };
    }
    return this.paperlessCache;
  }

  paperless(): PaperlessClient {
    return this.paperlessEntry().client;
  }

  metadata(): PaperlessMetadata {
    return this.paperlessEntry().metadata;
  }

  llm(): LlmClient {
    const key = JSON.stringify(this.cfg.ai);
    if (this.llmCache?.key !== key) {
      const problem = aiConfigProblem(this.cfg.ai);
      if (problem) throw new NotConfiguredError(problem);
      this.llmCache = { key, client: createLlmClient(this.cfg.ai) };
    }
    return this.llmCache.client;
  }

  aiInfo(): { provider: string; model: string } {
    return { provider: this.cfg.ai.provider, model: activeModel(this.cfg.ai) };
  }

  /** Browser-facing link to a document in Paperless. */
  documentLink(id: number): string {
    return documentUrl(this.cfg.paperless.publicUrl || this.cfg.paperless.url, id);
  }

  recordUsage(feature: NewUsage['feature'], result: Pick<CompletionResult, 'usage' | 'model' | 'durationMs'> | { usage: Usage; model: string; durationMs?: number }, documentId?: number | null): void {
    try {
      this.repos.usage.add({
        feature,
        documentId,
        provider: this.cfg.ai.provider,
        model: result.model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        durationMs: result.durationMs,
      });
    } catch (err) {
      logger.warn({ err }, 'Could not record token usage');
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
