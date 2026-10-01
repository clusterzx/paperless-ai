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
import { createRemoteEmbeddingClient, embeddingSpec } from '../ai/factory.js';
import { extractJsonObject } from '../ai/json.js';
import { estimateTokens, normalizeContent, truncateToTokens } from '../ai/tokens.js';
import type { ChatMessage, EmbeddingClient, Usage } from '../ai/types.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';
import { datePart } from '../processing/dates.js';
import { normalizeName } from '../paperless/metadata.js';
import { chunkText } from './chunker.js';
import { LocalEmbedder, localEmbeddingsAvailable } from './localEmbedder.js';
import { metaLine, RagStore, type ChunkWithMeta, type RagDocumentMeta } from './store.js';
import { asksForRecency, buildFtsQuery, makeSnippet, mentionedYears, queryTerms } from './text.js';
import { VectorIndex } from './vectorIndex.js';

const log = logger.child({ module: 'rag' });

const RRF_K = 60;
const CANDIDATES = 80;
const FETCH_BATCH = 25;
const EMBED_BATCH = 64;

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

  /** Make sure the stored embeddings belong to the configured model; load them into memory. */
  private ensureVectors(): void {
    const key = this.embeddingKey(this.cfg);
    const storedKey = this.ctx.repos.kv.get<string>('rag_embedding_key');
    if (storedKey !== key) {
      if (storedKey) log.info(`Embedding model changed (${storedKey} → ${key}) – passages will be re-embedded`);
      this.store.clearEmbeddings();
      this.vectors.clear();
      this.ctx.repos.kv.set('rag_embedding_key', key);
      this.vectorsLoaded = true;
      return;
    }
    if (this.vectorsLoaded) return;
    const started = Date.now();
    this.vectors.clear();
    let mismatched = false;
    for (const row of this.store.iterateEmbeddings()) {
      try {
        this.vectors.add(row.id, row.documentId, row.vector);
      } catch {
        mismatched = true;
        break;
      }
    }
    if (mismatched) {
      log.warn('Stored embeddings have inconsistent dimensions – re-embedding all passages');
      this.store.clearEmbeddings();
      this.vectors.clear();
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
    this.vectors.clear();
    this.ctx.repos.kv.delete('rag_embedding_key');
    this.vectorsLoaded = false;
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
    this.ensureVectors();
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

  async search(question: string, opts: { filters?: SearchFilters; limit?: number; signal?: AbortSignal } = {}): Promise<SearchResult> {
    const started = Date.now();
    if (this.enabled) this.ensureVectors();
    const terms = queryTerms(question);
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

    const lists: { weight: number; ids: number[] }[] = [];
    const chunkDoc = new Map<number, number>();

    // 1. BM25 keyword search
    const match = buildFtsQuery(terms);
    if (match) {
      const hits = this.store.ftsSearch(match, CANDIDATES * 2).filter((h) => !allowDocs || allowDocs.has(h.documentId)).slice(0, CANDIDATES);
      for (const h of hits) chunkDoc.set(h.id, h.documentId);
      lists.push({ weight: 1, ids: hits.map((h) => h.id) });
    }

    // 2. Vector search
    let mode: SearchResult['mode'] = 'keyword';
    if (this.vectors.count) {
      try {
        const embedder = await this.getEmbedder();
        if (embedder) {
          const [qv] = await embedder.embed([question], 'query', opts.signal);
          const hits = this.vectors.search(qv, CANDIDATES, allowDocs);
          for (const h of hits) chunkDoc.set(h.id, h.documentId);
          lists.push({ weight: 1, ids: hits.map((h) => h.id) });
          mode = 'hybrid';
        }
      } catch (err) {
        log.warn(`Vector search unavailable, falling back to keyword search: ${describeError(err)}`);
      }
    }

    // 3. Soft boosts from the question (mentioned correspondent / type / year, recency).
    const docBoosts: { weight: number; docs: number[] }[] = [];
    const corr = this.mentioned(question, 'correspondent');
    if (corr.length) docBoosts.push({ weight: 0.6, docs: this.store.documentsWhere({ correspondents: corr }).map((d) => d.id) });
    const types = this.mentioned(question, 'document_type');
    if (types.length) docBoosts.push({ weight: 0.4, docs: this.store.documentsWhere({ documentTypes: types }).map((d) => d.id) });
    const years = mentionedYears(question);
    if (years.length) docBoosts.push({ weight: 0.4, docs: this.store.documentsWhere({ years }).map((d) => d.id) });
    if (asksForRecency(question)) {
      const scope = corr.length || types.length ? docBoosts.flatMap((b) => b.docs) : this.store.recentDocuments(50).map((d) => d.id);
      docBoosts.push({ weight: 0.5, docs: scope });
    }

    // Reciprocal rank fusion over passages.
    const scores = new Map<number, number>();
    for (const list of lists) {
      list.ids.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + list.weight / (RRF_K + rank + 1)));
    }
    if (docBoosts.length) {
      const docRank = new Map<number, number>();
      for (const b of docBoosts) {
        b.docs.forEach((doc, rank) => docRank.set(doc, (docRank.get(doc) ?? 0) + b.weight / (RRF_K + rank + 1)));
      }
      for (const [id, s] of scores) {
        const boost = docRank.get(chunkDoc.get(id)!);
        if (boost) scores.set(id, s + boost);
      }
      // Boosted documents without any passage hit (e.g. "latest invoice from X") still get their first passage.
      if (scores.size < limit * 3) {
        for (const [doc, boost] of [...docRank.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
          if ([...chunkDoc.values()].includes(doc)) continue;
          if (allowDocs && !allowDocs.has(doc)) continue;
          const first = this.store.documentChunks(doc)[0];
          if (first) {
            scores.set(first.id, boost);
            chunkDoc.set(first.id, doc);
          }
        }
      }
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
- Answer in the language of the user's question. Be concise and precise: quote exact amounts, dates, numbers and names.
- Use Markdown (lists, bold, tables) when it improves readability.`;
  }

  /** Turn a follow-up question into a standalone search query. */
  private async condense(history: ChatTurn[], question: string, signal?: AbortSignal): Promise<string> {
    try {
      const llm = this.ctx.llm();
      const convo = history
        .slice(-6)
        .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${truncateToTokens(t.content.replace(/\[\d+\]/g, ''), 300).text}`)
        .join('\n');
      const res = await llm.complete(
        [
          {
            role: 'system',
            content:
              'Rewrite the follow-up question into a standalone question that can be understood without the conversation. Keep the language of the question. Include names, dates and topics referenced from the conversation. Reply as JSON: {"query": "..."}',
          },
          { role: 'user', content: `Conversation:\n${convo}\n\nFollow-up question: ${question}` },
        ],
        { json: true, temperature: 0, maxTokens: 200, signal, timeoutMs: 60_000 },
      );
      this.ctx.recordUsage('rag', res);
      const q = extractJsonObject<{ query?: string }>(res.text).query?.trim();
      return q || question;
    } catch (err) {
      if (signal?.aborted) throw err;
      log.debug(`Query rewriting failed, using the original question: ${describeError(err)}`);
      return question;
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
    if (cleanHistory.length) {
      yield { type: 'status', message: 'Understanding the question…' };
      query = await this.condense(cleanHistory, question, signal);
    }
    yield { type: 'status', message: 'Searching documents…' };
    const result = await this.search(query, { filters: opts.filters, signal });
    const sources = this.toSources(result);
    yield { type: 'sources', sources };

    const cfg = this.cfg;
    const maxAnswer = Math.min(Math.max(cfg.ai.responseTokens, 2000), Math.floor(cfg.ai.tokenLimit / 4));
    const system = this.systemPrompt();
    let historyBudget = Math.min(3000, Math.floor(cfg.ai.tokenLimit * 0.15));
    const historyMsgs: ChatMessage[] = [];
    for (const turn of [...cleanHistory].reverse()) {
      const content = turn.content.replace(/\s*\[\d+\](\[\d+\])*/g, '');
      const t = estimateTokens(content);
      if (t > historyBudget) break;
      historyBudget -= t;
      historyMsgs.unshift({ role: turn.role, content });
    }
    const contextBudget = Math.max(
      500,
      Math.min(
        cfg.rag.contextTokens,
        cfg.ai.tokenLimit - maxAnswer - estimateTokens(system) - historyMsgs.reduce((s, m) => s + estimateTokens(m.content), 0) - estimateTokens(question) - 300,
      ),
    );
    const context = this.buildContext(result, contextBudget);
    const user = context.text
      ? `Question: ${question}\n\nDocument excerpts:\n${context.text}`
      : `Question: ${question}\n\n(No matching documents were found in the archive.)`;

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
