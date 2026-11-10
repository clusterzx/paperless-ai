/**
 * RAG service: keeps a hybrid (BM25 + vector) index of all Paperless documents
 * in sync and answers questions with cited sources.
 *
 * Design goals: no extra service/process, low memory, incremental updates,
 * search keeps working (keyword-only) while embeddings are still computed.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Cron } from 'croner';
import type { ChatStreamEvent, ChatTurn, RagSource, RagStatus } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { AppConfig } from '../config/schema.js';
import { contextBudget, createRemoteEmbeddingClient, embeddingSpec } from '../ai/factory.js';
import { extractJsonObject } from '../ai/json.js';
import { estimateTokens, normalizeContent, truncateToTokens } from '../ai/tokens.js';
import type { ChatMessage, EmbeddingClient, Usage } from '../ai/types.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import { datePart } from '../processing/dates.js';
import { normalizeName } from '../paperless/metadata.js';
import { chunkText } from './chunker.js';
import { archiveFacts } from './facts.js';
import { LocalEmbedder, localEmbeddingsAvailable } from './localEmbedder.js';
import { metaLine, RagStore, type ChunkWithMeta, type RagDocumentMeta } from './store.js';
import { asksForRecency, buildFtsQuery, makeSnippet, mentionedMonths, mentionedYears, queryTerms, stem } from './text.js';
import { VectorIndex } from './vectorIndex.js';

const log = logger.child({ module: 'rag' });

const RRF_K = 60;
const CANDIDATES = 80;
const FETCH_BATCH = 25;
const EMBED_BATCH = 64;
const VECTOR_LOAD_BATCH = 2000;

/** Remove [n] citation markers (and the space before them) from earlier answers. */
const stripCitations = (text: string) => text.replace(/\s*\[\d+\](\[\d+\])*/g, '');

export interface SearchFilters {
  from?: string;
  to?: string;
  correspondent?: string;
  documentType?: string;
}

export interface RetrievedDocument {
  documentId: number;
  score: number;
  chunks: ChunkWithMeta[];
}

export interface SearchResult {
  query: string;
  terms: string[];
  documents: RetrievedDocument[];
  mode: 'hybrid' | 'keyword';
  tookMs: number;
}

export class RagService extends EventEmitter<{ status: [RagStatus] }> {
  readonly store: RagStore;
  private readonly vectors = new VectorIndex();
  private vectorsLoaded = false;
  private vectorsLoading: Promise<void> | null = null;
  private vectorGeneration = 0;
  private embedder: { key: string; client: EmbeddingClient } | null = null;
  private syncing: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private progress: RagStatus['progress'] = null;
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private cron: Cron | null = null;
  private stopped = false;
  private pendingResync = false;

  constructor(private readonly ctx: AppContext) {
    super();
    this.store = new RagStore(ctx.db);
    this.lastSyncAt = ctx.repos.kv.get<number>('rag_last_sync') ?? null;
    ctx.config.on('change', (next, prev) => this.onConfigChange(next, prev));
  }

  private get cfg(): AppConfig {
    return this.ctx.cfg;
  }

  get enabled(): boolean {
    return this.cfg.rag.enabled;
  }

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    this.stopped = false;
    this.schedule();
    // Load the vector index in the background so that the first question does not wait for it.
    if (this.enabled) setImmediate(() => void this.ensureVectors().catch((err: unknown) => log.warn(`Loading the vector index failed: ${describeError(err)}`)));
    if (this.enabled && this.ctx.isConfigured()) {
      setTimeout(() => void this.sync().catch(() => undefined), 10_000).unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cron?.stop();
    this.abort?.abort(new Error('shutdown'));
    await this.syncing?.catch(() => undefined);
    await this.embedder?.client.dispose?.();
    this.embedder = null;
  }

  private schedule(): void {
    this.cron?.stop();
    this.cron = null;
    if (this.stopped || !this.enabled || !this.cfg.rag.autoSync) return;
    // Cheap when nothing changed (one listing request), so every 15 minutes is fine.
    this.cron = new Cron('*/15 * * * *', { protect: true }, () => {
      if (this.ctx.isConfigured()) void this.sync().catch(() => undefined);
    });
  }

  /** Called by the processing engine after documents were changed. */
  requestSync(): void {
    if (!this.enabled || !this.cfg.rag.autoSync || !this.ctx.isConfigured()) return;
    if (this.syncing) this.pendingResync = true;
    else void this.sync().catch(() => undefined);
  }

  private onConfigChange(next: AppConfig, prev: AppConfig): void {
    const embeddingChanged = this.embeddingKey(next) !== this.embeddingKey(prev);
    if (embeddingChanged) {
      this.abort?.abort(new Error('embedding configuration changed'));
      void this.embedder?.client.dispose?.();
      this.embedder = null;
    }
    if (next.rag.enabled !== prev.rag.enabled || next.rag.autoSync !== prev.rag.autoSync) this.schedule();
    if (next.rag.enabled && (embeddingChanged || !prev.rag.enabled || next.paperless.url !== prev.paperless.url)) {
      setTimeout(() => this.requestSync(), 1000).unref();
    }
    this.emitStatus();
  }

  // ------------------------------------------------------------------ embeddings

  private embeddingKey(cfg: AppConfig): string {
    const spec = embeddingSpec(cfg);
    if (spec.provider === 'none') return 'none';
    const base =
      spec.provider === 'ollama' ? cfg.ai.ollama.url : spec.provider === 'custom' ? cfg.ai.custom.baseUrl : spec.provider === 'azure' ? cfg.ai.azure.endpoint : '';
    return `${spec.provider}:${spec.model}@${base}`;
  }

  private async getEmbedder(): Promise<EmbeddingClient | null> {
    const key = this.embeddingKey(this.cfg);
    if (key === 'none') return null;
    if (this.embedder?.key === key) return this.embedder.client;
    const spec = embeddingSpec(this.cfg);
    let client: EmbeddingClient | null;
    if (spec.provider === 'local') {
      if (!(await localEmbeddingsAvailable())) {
        throw new Error('Local embeddings are not available in this installation (@huggingface/transformers missing). Choose another embedding provider or "none".');
      }
      client = new LocalEmbedder(spec.model, path.join(this.ctx.dataDir, 'models'));
    } else {
      client = createRemoteEmbeddingClient(this.cfg);
    }
    if (!client) return null;
    this.embedder = { key, client };
    return client;
  }

  /** Make sure the stored embeddings belong to the configured model and are loaded into memory. */
  private async ensureVectors(): Promise<void> {
    const key = this.embeddingKey(this.cfg);
    const storedKey = this.ctx.repos.kv.get<string>('rag_embedding_key');
    if (storedKey !== key) {
      if (storedKey) log.info(`Embedding model changed (${storedKey} → ${key}) – passages will be re-embedded`);
      this.resetVectors();
      this.store.clearEmbeddings();
      this.ctx.repos.kv.set('rag_embedding_key', key);
      this.vectorsLoaded = true;
      return;
    }
    if (this.vectorsLoaded) return;
    this.vectorsLoading ??= this.loadVectors().finally(() => (this.vectorsLoading = null));
    return this.vectorsLoading;
  }

  /** Forget the in-memory vectors (an unfinished load is abandoned). */
  private resetVectors(): void {
    this.vectorGeneration++;
    this.vectorsLoading = null;
    this.vectorsLoaded = false;
    this.vectors.clear();
  }

  /**
   * Load the stored vectors page by page and yield to the event loop in between – large archives
   * (hundreds of thousands of passages) must not block other requests while loading.
   */
  private async loadVectors(): Promise<void> {
    const generation = ++this.vectorGeneration;
    const started = Date.now();
    this.vectors.clear();
    let afterId = 0;
    for (;;) {
      const rows = this.store.embeddingsAfter(afterId, VECTOR_LOAD_BATCH);
      try {
        for (const row of rows) this.vectors.add(row.id, row.documentId, row.vector);
      } catch {
        log.warn('Stored embeddings have inconsistent dimensions – re-embedding all passages');
        this.store.clearEmbeddings();
        this.vectors.clear();
        break;
      }
      if (rows.length < VECTOR_LOAD_BATCH) break;
      afterId = rows[rows.length - 1].id;
      await new Promise((resolve) => setImmediate(resolve));
      if (generation !== this.vectorGeneration) return; // reset meanwhile (rebuild, model change)
    }
    this.vectorsLoaded = true;
    if (this.vectors.count) {
      log.info(`Loaded ${this.vectors.count} vectors (${(this.vectors.memoryBytes / 1e6).toFixed(1)} MB) in ${Date.now() - started} ms`);
    }
  }

  // ------------------------------------------------------------------ status

  status(): RagStatus {
    const stats = this.store.stats();
    const spec = embeddingSpec(this.cfg);
    return {
      enabled: this.enabled,
      state: !this.enabled ? 'disabled' : this.syncing ? 'indexing' : this.lastError ? 'error' : 'idle',
      documents: stats.documents,
      chunks: stats.chunks,
      embedded: stats.embedded,
      embeddingProvider: spec.provider,
      embeddingModel: spec.model || null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      progress: this.progress,
      vectorSearch: spec.provider !== 'none' && stats.embedded > 0,
    };
  }

  private emitStatus(): void {
    this.emit('status', this.status());
  }

  // ------------------------------------------------------------------ indexing

  /** Synchronise the index with Paperless (incremental). Concurrent calls share one run. */
  sync(opts: { full?: boolean } = {}): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.syncing = this.runSync(opts.full ?? false, signal)
      .catch((err) => {
        if (signal.aborted) log.info(`Index synchronisation stopped (${describeError(signal.reason)})`);
        else {
          this.lastError = describeError(err);
          log.error(`Index synchronisation failed: ${this.lastError}`);
        }
      })
      .finally(() => {
        this.syncing = null;
        this.abort = null;
        this.progress = null;
        this.emitStatus();
        if (this.pendingResync && !this.stopped) {
          this.pendingResync = false;
          setTimeout(() => this.requestSync(), 2000).unref();
        }
      });
    this.emitStatus();
    return this.syncing;
  }

  /** Drop the whole index and rebuild it from scratch. */
  async rebuild(): Promise<void> {
    this.abort?.abort(new Error('rebuild requested'));
    await this.syncing?.catch(() => undefined);
    this.store.clear();
    this.resetVectors();
    this.ctx.repos.kv.delete('rag_embedding_key');
    void this.sync({ full: true });
  }

  private setProgress(phase: string, done: number, total: number): void {
    this.progress = { phase, done, total };
    this.emitStatus();
  }

  private async runSync(full: boolean, signal: AbortSignal): Promise<void> {
    if (!this.ctx.isConfigured()) throw new Error('Setup is not complete');
    const started = Date.now();
    this.lastError = null;
    await this.ensureVectors();
    const client = this.ctx.paperless();
    const metadata = this.ctx.metadata();

    this.setProgress('listing', 0, 0);
    const [docs, meta] = await Promise.all([
      client.listDocuments({ fields: ['id', 'title', 'modified', 'created', 'correspondent', 'document_type', 'tags'], ordering: '-added', pageSize: 1000 }),
      metadata.snapshot(true),
    ]);
    const tagNames = new Map(meta.tags.map((t) => [t.id, t.name]));
    const corrNames = new Map(meta.correspondents.map((c) => [c.id, c.name]));
    const typeNames = new Map(meta.documentTypes.map((d) => [d.id, d.name]));
    const internalTags = new Set([normalizeName(this.cfg.processing.processedTagName), ...this.cfg.processing.tags.map(normalizeName)]);

    const describe = (d: (typeof docs)[number]): Omit<RagDocumentMeta, 'contentHash'> => ({
      id: d.id,
      modified: d.modified ?? null,
      title: d.title ?? `Document ${d.id}`,
      correspondent: d.correspondent != null ? corrNames.get(d.correspondent) ?? null : null,
      documentType: d.document_type != null ? typeNames.get(d.document_type) ?? null : null,
      tags: (d.tags ?? []).map((t) => tagNames.get(t)).filter((t): t is string => Boolean(t) && !internalTags.has(normalizeName(t!))),
      created: datePart(d.created_date ?? d.created),
    });

    const indexed = this.store.indexedDocuments();
    const present = new Set<number>();
    const toUpdate: Omit<RagDocumentMeta, 'contentHash'>[] = [];
    for (const d of docs) {
      present.add(d.id);
      const m = describe(d);
      const prev = indexed.get(d.id);
      if (full || !prev || prev.modified !== m.modified || prev.meta !== metaLine(m)) toUpdate.push(m);
    }
    let removed = 0;
    for (const id of indexed.keys()) {
      if (!present.has(id)) {
        for (const chunkId of this.store.deleteDocument(id)) this.vectors.remove(chunkId);
        removed++;
      }
    }

    // Fetch content of new/changed documents in batches and (re)chunk them.
    for (let i = 0; i < toUpdate.length; i += FETCH_BATCH) {
      if (signal.aborted) throw signal.reason;
      this.setProgress('reading documents', i, toUpdate.length);
      const batch = toUpdate.slice(i, i + FETCH_BATCH);
      const contents = await client.listDocuments({ ids: batch.map((b) => b.id), fields: ['id', 'content'], pageSize: FETCH_BATCH });
      const byId = new Map(contents.map((c) => [c.id, c.content ?? '']));
      for (const m of batch) {
        const content = normalizeContent(byId.get(m.id) ?? '');
        const chunks = content ? chunkText(content) : [m.title];
        this.vectors.removeDocument(m.id);
        this.store.upsertDocument({ ...m, contentHash: createHash('sha1').update(content).digest('hex') }, chunks);
      }
    }

    if (toUpdate.length || removed) log.info(`Index updated: ${toUpdate.length} documents (re)indexed, ${removed} removed`);
    await this.embedPending(signal);
    this.lastSyncAt = Date.now();
    this.ctx.repos.kv.set('rag_last_sync', this.lastSyncAt);
    log.debug(`Index synchronisation finished in ${Date.now() - started} ms`);
  }

  private async embedPending(signal: AbortSignal): Promise<void> {
    let embedder: EmbeddingClient | null;
    try {
      embedder = await this.getEmbedder();
    } catch (err) {
      this.lastError = `Embeddings unavailable – using keyword search only: ${describeError(err)}`;
      log.warn(this.lastError);
      return;
    }
    if (!embedder) return;
    const total = this.store.countPendingEmbeddings();
    if (!total) return;
    log.info(`Embedding ${total} passages with ${embedder.id}`);
    let done = 0;
    const started = Date.now();
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const pending = this.store.pendingEmbeddings(EMBED_BATCH);
      if (!pending.length) break;
      this.setProgress('embedding', done, total);
      let vectors: Float32Array[];
      try {
        vectors = await embedder.embed(pending.map((p) => truncateToTokens(p.text, 480).text), 'passage', signal);
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        this.lastError = `Embedding failed – keyword search still works: ${describeError(err)}`;
        log.error(this.lastError);
        return;
      }
      const items = pending.map((p, i) => ({ id: p.id, documentId: p.documentId, vector: vectors[i] }));
      this.store.saveEmbeddings(items);
      for (const it of items) this.vectors.add(it.id, it.documentId, it.vector);
      done += pending.length;
    }
    log.info(`Embedded ${done} passages in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }

  // ------------------------------------------------------------------ retrieval

  /** Find known correspondents / document types mentioned in the question. */
  private mentioned(question: string, column: 'correspondent' | 'document_type'): string[] {
    const q = ` ${question.toLowerCase()} `;
    return this.store.distinctValues(column).filter((name) => {
      const n = name.toLowerCase().trim();
      if (n.length < 3) return false;
      const idx = q.indexOf(n);
      if (idx < 0) return false;
      const before = q[idx - 1];
      const after = q[idx + n.length];
      return !/[\p{L}\p{N}]/u.test(before ?? ' ') && !/[\p{L}\p{N}]/u.test(after ?? ' ');
    });
  }

  async search(
    question: string,
    opts: { filters?: SearchFilters; limit?: number; keywords?: string[]; signal?: AbortSignal } = {},
  ): Promise<SearchResult> {
    const started = Date.now();
    if (this.enabled) await this.ensureVectors();
    const keywords = opts.keywords ?? [];
    const terms = queryTerms(keywords.length ? `${question} ${keywords.join(' ')}` : question, 32);
    const limit = opts.limit ?? this.cfg.rag.topK;
    const f = opts.filters ?? {};

    // Hard filters from the UI.
    let allowDocs: Set<number> | null = null;
    if (f.from || f.to || f.correspondent || f.documentType) {
      allowDocs = new Set(
        this.store
          .documentsWhere({
            from: f.from,
            to: f.to,
            correspondents: f.correspondent ? [f.correspondent] : undefined,
            documentTypes: f.documentType ? [f.documentType] : undefined,
          })
          .map((d) => d.id),
      );
    }

    const lists: { weight: number; ids: number[]; factors?: number[] }[] = [];
    const chunkDoc = new Map<number, number>();

    // 1. BM25 keyword search. Hits that contain only some of the query terms (e.g. only a year or
    //    a generic word) are ranked behind complete matches and contribute less.
    const match = buildFtsQuery(terms);
    if (match) {
      const hits = this.store.ftsSearch(match, CANDIDATES * 2).filter((h) => !allowDocs || allowDocs.has(h.documentId)).slice(0, CANDIDATES);
      const toStem = (t: string) => (t.length >= 4 && !/^\d+$/.test(t) ? stem(t) : t);
      const qStems = queryTerms(question).map(toStem);
      const kStems = queryTerms(keywords.join(' ')).map(toStem).filter((k) => !qStems.includes(k));
      const texts = this.store.chunksWithMeta(hits.map((h) => h.id));
      const coverage = new Map(
        hits.map((h) => {
          const c = texts.get(h.id);
          const text = c ? `${metaLine(c)} ${c.text}`.toLowerCase() : '';
          let cov = qStems.length ? qStems.filter((st) => text.includes(st)).length / qStems.length : 0;
          // Matching AI keywords (synonyms/translations) counts like matching the question.
          const kHits = kStems.filter((st) => text.includes(st)).length;
          if (kHits) cov = Math.max(cov, 0.25 + (0.5 * kHits) / kStems.length);
          return [h.id, qStems.length || kStems.length ? cov : 1];
        }),
      );
      const ordered = hits
        .map((h, rank) => ({ ...h, rank, cov: coverage.get(h.id) ?? 0 }))
        .sort((a, b) => b.cov - a.cov || a.rank - b.rank);
      for (const h of ordered) chunkDoc.set(h.id, h.documentId);
      lists.push({ weight: 1, ids: ordered.map((h) => h.id), factors: ordered.map((h) => Math.max(0.25, h.cov)) });
    }

    // 2. Vector search
    let mode: SearchResult['mode'] = 'keyword';
    if (this.vectors.count) {
      try {
        const embedder = await this.getEmbedder();
        if (embedder) {
          const inputs = keywords.length ? [question, keywords.join(', ')] : [question];
          const [qv, kv] = await embedder.embed(inputs, 'query', opts.signal);
          const hits = this.vectors.search(qv, CANDIDATES, allowDocs);
          for (const h of hits) chunkDoc.set(h.id, h.documentId);
          lists.push({ weight: 1, ids: hits.map((h) => h.id) });
          if (kv) {
            // AI keywords (synonyms, translations) as a second, weaker semantic query.
            const khits = this.vectors.search(kv, CANDIDATES, allowDocs);
            for (const h of khits) chunkDoc.set(h.id, h.documentId);
            lists.push({ weight: 0.5, ids: khits.map((h) => h.id) });
          }
          mode = 'hybrid';
        }
      } catch (err) {
        log.warn(`Vector search unavailable, falling back to keyword search: ${describeError(err)}`);
      }
    }

    // Reciprocal rank fusion over passages.
    const scores = new Map<number, number>();
    for (const list of lists) {
      list.ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + (list.weight * (list.factors?.[rank] ?? 1)) / (RRF_K + rank + 1)));
    }

    // 3. Soft boosts derived from the question. Membership boosts are uniform (they must not
    //    favour recent documents); only an explicit "latest …" question boosts by date.
    const UNIT = 1 / (RRF_K + 1); // score of a first-ranked hit in one list
    const membership = new Map<number, number>();
    const addMembership = (docIds: number[], weight: number) => {
      for (const d of docIds) membership.set(d, (membership.get(d) ?? 0) + weight * UNIT);
    };
    const corr = this.mentioned(question, 'correspondent');
    const corrDocs = corr.length ? this.store.documentsWhere({ correspondents: corr }) : [];
    addMembership(corrDocs.map((d) => d.id), 0.5);
    const types = this.mentioned(question, 'document_type');
    const typeDocs = types.length ? this.store.documentsWhere({ documentTypes: types }) : [];
    addMembership(typeDocs.map((d) => d.id), 0.3);
    const months = mentionedMonths(question);
    const monthDocs = months.length ? this.store.documentsWhere({ months }) : [];
    addMembership(monthDocs.map((d) => d.id), 0.6);
    const years = mentionedYears(question);
    if (years.length && !months.length) addMembership(this.store.documentsWhere({ years }).map((d) => d.id), 0.2);

    const docScore = (id: number) => membership.get(chunkDoc.get(id)!) ?? 0;
    for (const [id, s] of scores) scores.set(id, s + docScore(id));

    // Documents matching a specific correspondent/type/month without any passage hit still get
    // their first passage (e.g. "latest invoice from X" when the wording does not match).
    const specific = [...new Set([...corrDocs, ...typeDocs, ...monthDocs].map((d) => d.id))];
    if (specific.length && specific.length <= limit * 3) {
      const hitDocs = new Set(chunkDoc.values());
      for (const doc of specific) {
        if (hitDocs.has(doc) || (allowDocs && !allowDocs.has(doc))) continue;
        const first = this.store.documentChunks(doc)[0];
        if (!first) continue;
        chunkDoc.set(first.id, doc);
        scores.set(first.id, membership.get(doc) ?? 0);
      }
    }

    if (asksForRecency(question)) {
      // Among the relevant candidates (or the documents of the mentioned correspondent/type),
      // prefer newer documents.
      const candidateDocs = specific.length
        ? specific
        : [...new Set([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id]) => chunkDoc.get(id)!))];
      const created = this.store.createdDates(candidateDocs);
      const byDate = [...candidateDocs].sort((a, b) => (created.get(b) ?? '').localeCompare(created.get(a) ?? ''));
      const recency = new Map(byDate.map((doc, rank) => [doc, 0.8 / (RRF_K + rank + 1)]));
      for (const [id, s] of scores) scores.set(id, s + (recency.get(chunkDoc.get(id)!) ?? 0));
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const chunkMeta = this.store.chunksWithMeta(ranked.slice(0, limit * 4).map(([id]) => id));
    const byDoc = new Map<number, RetrievedDocument>();
    for (const [id, score] of ranked) {
      const c = chunkMeta.get(id);
      if (!c) continue;
      let entry = byDoc.get(c.documentId);
      if (!entry) {
        if (byDoc.size >= limit) continue;
        entry = { documentId: c.documentId, score: 0, chunks: [] };
        byDoc.set(c.documentId, entry);
      }
      if (entry.chunks.length < 3) {
        // The best passage decides the rank (summing passage scores let long documents with several
        // weak passages outrank the best matching document); further passages are context only.
        if (!entry.chunks.length) entry.score = score;
        entry.chunks.push(c);
      }
    }
    const documents = [...byDoc.values()].sort((a, b) => b.score - a.score);
    return { query: question, terms, documents, mode, tookMs: Date.now() - started };
  }

  /** Convert search results into numbered sources with snippets. */
  toSources(result: SearchResult): RagSource[] {
    return result.documents.map((d, i) => {
      const first = d.chunks[0];
      return {
        n: i + 1,
        documentId: d.documentId,
        title: first.title,
        correspondent: first.correspondent,
        documentType: first.documentType,
        created: first.created,
        tags: first.tags,
        snippet: makeSnippet(d.chunks.map((c) => c.text).join(' … '), result.terms),
        score: Math.round(d.score * 10000) / 10000,
        url: this.ctx.documentLink(d.documentId),
      };
    });
  }

  /** Build the numbered context block within a token budget. Short documents are included completely. */
  private buildContext(result: SearchResult, budget: number): { text: string; used: number[] } {
    const blocks: string[] = [];
    const used: number[] = [];
    let remaining = budget;
    result.documents.forEach((d, i) => {
      if (remaining < 150) return;
      const first = d.chunks[0];
      let chunks = d.chunks;
      if (first.chunkCount <= 3) chunks = this.store.documentChunks(d.documentId).map((c) => ({ ...first, ...c }));
      const body = [...chunks].sort((a, b) => a.idx - b.idx).map((c) => c.text).join('\n…\n');
      const header = `[${i + 1}] ${metaLine(first)}`;
      const allowance = Math.min(remaining, Math.max(400, Math.floor(budget / Math.min(result.documents.length, 4))));
      const { text } = truncateToTokens(body, allowance - estimateTokens(header) - 10);
      const block = `${header}\n"""\n${text}\n"""`;
      remaining -= estimateTokens(block);
      blocks.push(block);
      used.push(i + 1);
    });
    return { text: blocks.join('\n\n'), used };
  }

  // ------------------------------------------------------------------ chat

  private systemPrompt(): string {
    const today = new Date().toISOString().slice(0, 10);
    return `You are Paperless-AI, an assistant answering questions about the user's personal document archive (Paperless-ngx). Today is ${today}.
Rules:
- Answer ONLY with information from the numbered document excerpts provided with the question. Do not invent facts.
- Cite the excerpts you used with their number in square brackets directly after the statement, e.g. [1] or [2][3].
- If the excerpts do not contain the answer, say so clearly. If they only partially answer it, answer that part and say what is missing.
- The excerpts come from the best-matching documents only, not from the whole archive. For questions about how many documents there are, use the "Archive facts" (exact numbers from Paperless) when provided; without them, say that you can only count the documents in the excerpts and that the archive may contain more.
- List or sum up only what the excerpts show; mention that the list may be incomplete when the question asks for all documents.
- Answer in the language of the user's question. Be concise and precise: quote exact amounts, dates, numbers and names.
- Use Markdown (lists, bold, tables) when it improves readability.`;
  }

  /**
   * Let the AI turn the question into a standalone query plus search keywords (synonyms and
   * translations into the language of the archive). For follow-up questions this also resolves
   * references to the conversation. Falls back to the original question on any problem.
   */
  async analyzeQuery(question: string, history: ChatTurn[] = [], signal?: AbortSignal): Promise<{ query: string; keywords: string[] }> {
    const fallback = { query: question, keywords: [] as string[] };
    try {
      const llm = this.ctx.llm();
      const titles = this.store.sampleTitles(12);
      const convo = history
        .slice(-6)
        .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${truncateToTokens(stripCitations(t.content), 250).text}`)
        .join('\n');
      const system = `You prepare searches in a personal document archive (scanned letters, invoices, contracts …).
Example document titles from the archive: ${titles.join(' | ') || '(none yet)'}
Return JSON {"query": string, "keywords": string[]}:
- "query": the question as a standalone question${history.length ? ' (resolve references to the conversation: names, dates, topics)' : ''}, in the language of the question.
- "keywords": 3–8 short search terms that are likely to appear in matching documents: important nouns, names, synonyms and – if the archive language differs from the question – translations into the archive language. No dates in natural language, no filler words.`;
      const user = history.length ? `Conversation:\n${convo}\n\nQuestion: ${question}` : `Question: ${question}`;
      const res = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { json: true, temperature: 0, maxTokens: 250, signal, timeoutMs: 30_000 },
      );
      this.ctx.recordUsage('rag', res);
      const parsed = extractJsonObject<{ query?: unknown; keywords?: unknown }>(res.text);
      const query = typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : question;
      const keywords = Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 1).map((k) => k.trim().slice(0, 60)).slice(0, 10)
        : [];
      return { query, keywords };
    } catch (err) {
      if (signal?.aborted) throw err;
      log.debug(`Query analysis failed, using the original question: ${describeError(err)}`);
      return fallback;
    }
  }

  /**
   * Answer a question about the archive. Yields sources first, then the
   * streamed answer.
   */
  async *chat(question: string, history: ChatTurn[], opts: { filters?: SearchFilters; signal?: AbortSignal } = {}): AsyncGenerator<ChatStreamEvent> {
    if (!this.enabled) throw new Error('The document chat (RAG) is disabled in the settings');
    const llm = this.ctx.llm();
    const signal = opts.signal;
    const cleanHistory = history.filter((t) => t.content?.trim()).slice(-10);

    if (!this.store.stats().documents) {
      yield { type: 'status', message: 'The search index is still empty – indexing has started, please try again in a moment.' };
      this.requestSync();
    }
    let query = question;
    let keywords: string[] = [];
    if (cleanHistory.length || this.cfg.rag.queryExpansion) {
      yield { type: 'status', message: 'Understanding the question…' };
      const analysis = await this.analyzeQuery(question, cleanHistory, signal);
      // Follow-up questions need the rewritten (standalone) query; for first questions the user's
      // own wording stays authoritative and the AI keywords only complement it.
      if (cleanHistory.length) query = analysis.query;
      keywords = analysis.keywords;
    }
    yield { type: 'status', message: 'Searching documents…' };
    const [result, facts] = await Promise.all([this.search(query, { filters: opts.filters, keywords, signal }), archiveFacts(this.ctx, query)]);
    const sources = this.toSources(result);
    yield { type: 'sources', sources };

    const cfg = this.cfg;
    const contextWindow = contextBudget(cfg.ai);
    const maxAnswer = Math.min(Math.max(cfg.ai.responseTokens, 2000), Math.floor(contextWindow / 4));
    const system = this.systemPrompt();
    let historyBudget = Math.min(3000, Math.floor(contextWindow * 0.15));
    const historyMsgs: ChatMessage[] = [];
    for (const turn of [...cleanHistory].reverse()) {
      const content = stripCitations(turn.content);
      const t = estimateTokens(content);
      if (t > historyBudget) break;
      historyBudget -= t;
      historyMsgs.unshift({ role: turn.role, content });
    }
    const passageBudget = Math.max(
      500,
      Math.min(
        cfg.rag.contextTokens,
        contextWindow - maxAnswer - estimateTokens(system) - historyMsgs.reduce((s, m) => s + estimateTokens(m.content), 0) - estimateTokens(question) - 300,
      ),
    );
    const context = this.buildContext(result, Math.max(300, passageBudget - (facts ? estimateTokens(facts) : 0)));
    const factsText = facts ? `\n\nArchive facts (exact numbers from Paperless):\n${facts}` : '';
    const user = context.text
      ? `Question: ${question}${factsText}\n\nDocument excerpts:\n${context.text}`
      : `Question: ${question}${factsText}\n\n(No matching documents were found in the archive.)`;

    yield { type: 'status', message: 'Writing answer…' };
    let usage: Usage | undefined;
    let text = '';
    const started = Date.now();
    for await (const chunk of llm.stream([{ role: 'system', content: system }, ...historyMsgs, { role: 'user', content: user }], {
      temperature: Math.min(cfg.ai.temperature, 0.4),
      maxTokens: maxAnswer,
      signal,
    })) {
      if (chunk.type === 'delta') {
        text += chunk.text;
        yield { type: 'delta', text: chunk.text };
      } else usage = chunk.usage;
    }
    const finalUsage = usage ?? {
      promptTokens: estimateTokens(system + user),
      completionTokens: estimateTokens(text),
      totalTokens: estimateTokens(system + user) + estimateTokens(text),
    };
    this.ctx.recordUsage('rag', { usage: finalUsage, model: llm.model, durationMs: Date.now() - started });
    yield { type: 'done', usage: finalUsage, model: llm.model };
  }
}
