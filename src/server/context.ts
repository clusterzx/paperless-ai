/**
 * Application context: owns configuration, database and lazily (re)created
 * service clients. Clients are rebuilt automatically when the relevant part
 * of the configuration changes – no restart required after saving settings.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config/schema.js';
import { ConfigStore } from './config/store.js';
import { importLegacyDatabase, openDatabase, type Db } from './db/database.js';
import { createRepos, type NewUsage, type Repos } from './db/repos.js';
import { moveRagIndex, openIndexDatabase } from './db/indexDatabase.js';
import { moveConfigRulesToWorkflows } from './workflows/promptRules.js';
import { PaperlessClient } from './paperless/client.js';
import { MetadataCache } from './backend/metadata.js';
import { PaperlessBackend } from './backend/paperless.js';
import { LocalBackend } from './archive/backend.js';
import type { DocumentBackend } from './backend/types.js';
import { BackendView } from './backend/view.js';
import { SYSTEM_SCOPE, type AccessScope } from './access/scope.js';
import { DocumentEvents } from './events.js';
import { activeModel, aiConfigProblem, createLlmClient, withModel } from './ai/factory.js';
import type { CompletionResult, LlmClient, Usage } from './ai/types.js';
import { logger } from './logger.js';

/**
 * The version of Paperless-AI. Kept in package.json only (`npm version x.y.z --no-git-tag-version`),
 * so the app, the image and the release cannot disagree; the release workflow checks the tag against it.
 */
export const VERSION: string = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

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
  /** Search index of "Ask your archive" (index.db). */
  readonly indexDb: Db;
  readonly repos: Repos;
  readonly dataDir: string;
  readonly version = VERSION;

  /** Document events (committed changes) – see events.ts. */
  readonly events = new DocumentEvents();
  private backendCache: { key: string; backend: DocumentBackend; metadata: Map<string, MetadataCache> } | null = null;
  private paperlessClientCache: { key: string; client: PaperlessClient } | null = null;
  private llmCache: { key: string; client: LlmClient } | null = null;
  /** Clients for other models of the provider (prompt rules), by model. */
  private readonly modelClients = new Map<string, { key: string; client: LlmClient }>();

  constructor(opts: ContextOptions) {
    this.dataDir = opts.dataDir;
    this.config = ConfigStore.load(opts.dataDir, opts.env ?? process.env);
    this.config.ensureSecrets();
    this.db = openDatabase(opts.memoryDb ? ':memory:' : path.join(opts.dataDir, 'paperless-ai.db'));
    this.indexDb = openIndexDatabase(opts.memoryDb ? ':memory:' : path.join(opts.dataDir, 'index.db'));
    moveRagIndex(this.db, this.indexDb, opts.memoryDb ? null : opts.dataDir);
    this.repos = createRepos(this.db);
    if (!opts.memoryDb) importLegacyDatabase(this.db, path.join(opts.dataDir, 'documents.db'));
    this.config.on('change', (next, prev) => this.onConfigChange(next, prev));
    // Prompt rules of older versions (in config.json) are workflows now.
    moveConfigRulesToWorkflows(this);
  }

  get cfg(): AppConfig {
    return this.config.current;
  }

  private onConfigChange(next: AppConfig, prev: AppConfig): void {
    // Rules written into the configuration (API of ≤ 4.4, scripts) become workflows as well.
    if (next.processing.promptRules.length && next.processing.promptRules !== prev.processing.promptRules) moveConfigRulesToWorkflows(this);
    if (this.backendCache && this.backendCache.key !== this.backendKey(next)) {
      const old = this.backendCache.backend;
      this.backendCache = null;
      void old.close?.().catch((err: unknown) => logger.warn({ err }, 'Closing the previous archive backend failed'));
    }
    if (JSON.stringify(next.ai) !== JSON.stringify(prev.ai)) {
      this.llmCache = null;
      this.modelClients.clear();
    }
    logger.child({ module: 'config' }).info('Configuration updated');
  }

  /** Companion mode: URL and token of Paperless-ngx are set. */
  paperlessConfigured(): boolean {
    return Boolean(this.cfg.paperless.url && this.cfg.paperless.token);
  }

  archiveMode(): 'paperless' | 'builtin' {
    return this.cfg.archive.mode;
  }

  /** The archive backend of the configured mode can be used. */
  archiveConfigured(): boolean {
    return this.archiveMode() === 'builtin' ? true : this.paperlessConfigured();
  }

  /** Setup finished and both the archive and the AI provider are configured. */
  isConfigured(): boolean {
    return this.cfg.setupCompleted && this.archiveConfigured() && aiConfigProblem(this.cfg.ai) === null;
  }

  needsSetup(): boolean {
    return this.repos.users.count() === 0 || !this.cfg.setupCompleted;
  }

  private backendKey(cfg: AppConfig): string {
    if (cfg.archive.mode === 'builtin') return `builtin|${cfg.archive.builtin.storageDir}`;
    return `paperless|${cfg.paperless.url}|${cfg.paperless.token}|${cfg.paperless.publicUrl}`;
  }

  private backendEntry() {
    const key = this.backendKey(this.cfg);
    if (this.backendCache?.key === key) return this.backendCache;
    let backend: DocumentBackend;
    const metadata = new Map<string, MetadataCache>();
    if (this.archiveMode() === 'builtin') {
      backend = new LocalBackend(this);
    } else {
      if (!this.paperlessConfigured()) throw new NotConfiguredError('Paperless-ngx is not configured yet');
      backend = new PaperlessBackend({
        url: this.cfg.paperless.url,
        token: this.cfg.paperless.token,
        publicUrl: this.cfg.paperless.publicUrl,
        metadata: () => this.metadata(null),
      });
    }
    this.backendCache = { key, backend, metadata };
    return this.backendCache;
  }

  /** The archive backend itself (prefer `backend()` – a view bound to an access scope). */
  archive(): DocumentBackend {
    return this.backendEntry().backend;
  }

  /** The archive backend bound to an access scope (system scope for internal work). */
  backend(scope: AccessScope = SYSTEM_SCOPE): BackendView {
    return new BackendView(this.backendEntry().backend, scope);
  }

  /**
   * Metadata cache of a namespace: Paperless-ngx (`null`), or a library of the built-in archive.
   * Without a library the built-in archive uses its default library.
   */
  metadata(libraryId: number | null = null): MetadataCache {
    const entry = this.backendEntry();
    const key = String(libraryId ?? 'default');
    let cache = entry.metadata.get(key);
    if (!cache) {
      cache = new MetadataCache(entry.backend.metadataSource(libraryId), undefined, { shareCreated: () => this.cfg.processing.shareCreatedObjects }, libraryId);
      entry.metadata.set(key, cache);
    }
    return cache;
  }

  /** Forget cached metadata (all namespaces). */
  invalidateMetadata(): void {
    for (const cache of this.backendCache?.metadata.values() ?? []) cache.invalidate();
  }

  /**
   * The Paperless-ngx client of the companion settings – also available in the built-in mode while
   * a Paperless-ngx connection is configured (migration assistant).
   */
  paperless(): PaperlessClient {
    if (!this.paperlessConfigured()) throw new NotConfiguredError('Paperless-ngx is not configured yet');
    if (this.archiveMode() === 'paperless') {
      const backend = this.backendEntry().backend;
      if (backend instanceof PaperlessBackend) return backend.client;
    }
    const key = `${this.cfg.paperless.url}|${this.cfg.paperless.token}`;
    if (this.paperlessClientCache?.key !== key) {
      this.paperlessClientCache = { key, client: new PaperlessClient({ url: this.cfg.paperless.url, token: this.cfg.paperless.token }) };
    }
    return this.paperlessClientCache.client;
  }

  /** The AI client – with another model of the configured provider, if given (prompt rules). */
  llm(model?: string | null): LlmClient {
    if (model && model !== activeModel(this.cfg.ai)) {
      const ai = withModel(this.cfg.ai, model);
      const key = JSON.stringify(ai);
      let entry = this.modelClients.get(model);
      if (entry?.key !== key) {
        const problem = aiConfigProblem(ai);
        if (problem) throw new NotConfiguredError(problem);
        if (this.modelClients.size >= 16) this.modelClients.clear();
        entry = { key, client: createLlmClient(ai) };
        this.modelClients.set(model, entry);
      }
      return entry.client;
    }
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

  /** Browser-facing link to a document (Paperless-ngx UI or the document page of the built-in archive). */
  documentLink(id: number): string {
    return this.archive().documentLink(id);
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
    const backend = this.backendCache?.backend;
    this.backendCache = null;
    void backend?.close?.().catch(() => undefined);
    try {
      this.indexDb.close();
    } catch {
      /* already closed */
    }
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
