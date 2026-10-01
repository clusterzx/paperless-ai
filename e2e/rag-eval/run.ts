/**
 * Retrieval quality evaluation of "Ask your archive".
 *
 *   npx tsx e2e/rag-eval/run.ts                    # keyword + local embeddings + 3.x baseline
 *   OLLAMA_URL=http://127.0.0.1:11434 npx tsx e2e/rag-eval/run.ts   # additionally Ollama embeddings
 *
 * Compares the new hybrid retrieval with an emulation of the retrieval of
 * Paperless-AI 3.x (one embedding of the first ~100 words per document with
 * paraphrase-multilingual-MiniLM-L12-v2, unnormalised L2 distance, BM25 over
 * the whole text, 0.7/0.3 weighting; the English cross-encoder re-ranking is
 * omitted).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockPaperless } from '../../test/helpers/mockPaperless.js';
import { AppContext } from '../../src/server/context.js';
import { RagService } from '../../src/server/rag/service.js';
import type { AppConfig, DeepPartial } from '../../src/server/config/schema.js';
import { buildCorpus, type EvalDoc, type EvalQuestion } from './corpus.js';

const modelCache = process.env.MODEL_CACHE ?? path.join(os.tmpdir(), 'pai-eval-models');
fs.mkdirSync(modelCache, { recursive: true });

const { docs, questions } = buildCorpus();
const paperless = await startMockPaperless({ token: 'eval' });
const ids = { tag: new Map<string, number>(), corr: new Map<string, number>(), type: new Map<string, number>() };
for (const d of docs) {
  for (const t of d.tags) if (!ids.tag.has(t)) ids.tag.set(t, paperless.addTag(t).id);
  if (!ids.corr.has(d.correspondent)) ids.corr.set(d.correspondent, paperless.addCorrespondent(d.correspondent).id);
  if (!ids.type.has(d.type)) ids.type.set(d.type, paperless.addDocumentType(d.type).id);
  paperless.addDocument({
    id: d.id,
    title: d.title,
    content: d.content,
    created: d.created,
    tags: d.tags.map((t) => ids.tag.get(t)!),
    correspondent: ids.corr.get(d.correspondent)!,
    document_type: ids.type.get(d.type)!,
  });
}

interface Metrics {
  name: string;
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  ms: number;
  misses: string[];
}

function score(name: string, ranked: number[][], ms: number): Metrics {
  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let mrr = 0;
  const misses: string[] = [];
  ranked.forEach((r, i) => {
    const rank = r.findIndex((id) => questions[i].expected.includes(id));
    if (rank === 0) hit1++;
    if (rank >= 0 && rank < 3) hit3++;
    if (rank >= 0 && rank < 5) hit5++;
    if (rank >= 0) mrr += 1 / (rank + 1);
    if (rank !== 0) misses.push(`${questions[i].q} → ${rank < 0 ? 'not found' : `rank ${rank + 1}`}`);
  });
  const n = questions.length;
  return { name, hit1: hit1 / n, hit3: hit3 / n, hit5: hit5 / n, mrr: mrr / n, ms, misses };
}

async function evalNew(name: string, rag: DeepPartial<AppConfig['rag']>, ai: DeepPartial<AppConfig['ai']> = {}, expand = false): Promise<Metrics> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-eval-'));
  fs.symlinkSync(modelCache, path.join(dataDir, 'models'));
  const ctx = new AppContext({ dataDir, env: {} });
  ctx.config.update({
    setupCompleted: true,
    paperless: { url: paperless.url, token: 'eval' },
    ai: { provider: 'custom', custom: { baseUrl: 'http://127.0.0.1:9/v1', model: 'unused' }, ...ai },
    rag: { enabled: true, ...rag },
  });
  const service = new RagService(ctx);
  const t0 = Date.now();
  await service.sync();
  const indexMs = Date.now() - t0;
  const status = service.status();
  if (status.lastError) console.warn(`${name}: ${status.lastError}`);
  const ranked: number[][] = [];
  const s0 = Date.now();
  for (const q of questions) {
    const analysis = expand ? await service.analyzeQuery(q.q) : { query: q.q, keywords: [] };
    if (expand && process.env.VERBOSE) console.log(`  ${q.q} → ${analysis.query} | ${analysis.keywords.join(', ')}`);
    ranked.push((await service.search(q.q, { limit: 10, keywords: analysis.keywords })).documents.map((d) => d.documentId));
  }
  const ms = (Date.now() - s0) / questions.length;
  await service.stop();
  ctx.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  const m = score(name, ranked, ms);
  console.log(`${name}: indexed ${status.documents} docs / ${status.chunks} passages in ${(indexMs / 1000).toFixed(1)} s`);
  return m;
}

// ------------------------------------------------------------------ 3.x baseline emulation

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function bm25Scores(corpus: string[][], query: string[]): number[] {
  const k1 = 1.5;
  const b = 0.75;
  const N = corpus.length;
  const avgdl = corpus.reduce((s, d) => s + d.length, 0) / N;
  const df = new Map<string, number>();
  for (const d of corpus) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return corpus.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const q of query) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgdl)));
    }
    return s;
  });
}

async function evalLegacy(): Promise<Metrics | null> {
  let tf: typeof import('@huggingface/transformers');
  try {
    tf = await import('@huggingface/transformers');
  } catch {
    return null;
  }
  tf.env.cacheDir = modelCache;
  const extractor = await tf.pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { dtype: 'q8' });
  const embed = async (text: string) => Array.from((await extractor(text, { pooling: 'mean', normalize: false })).data as Float32Array);
  const texts = docs.map((d: EvalDoc) => `${d.title} ${d.correspondent} ${d.content}`);
  // sentence-transformers truncated at 128 word pieces ≈ the first ~100 words.
  const vectors = await Promise.all(texts.map((t) => embed(t.split(/\s+/).slice(0, 100).join(' '))));
  const corpusTokens = texts.map(tokenize);
  const ranked: number[][] = [];
  const s0 = Date.now();
  for (const q of questions as EvalQuestion[]) {
    const qv = await embed(q.q);
    const sem = vectors.map((v) => {
      const dist = v.reduce((s, x, i) => s + (x - qv[i]) ** 2, 0);
      return dist <= 1 ? 1 - dist : 0;
    });
    const bm = bm25Scores(corpusTokens, tokenize(q.q));
    const maxBm = Math.max(...bm) || 1;
    const combined = docs.map((d, i) => ({ id: d.id, s: 0.3 * (bm[i] / maxBm) + 0.7 * sem[i] }));
    ranked.push(combined.sort((a, b) => b.s - a.s).slice(0, 10).map((x) => x.id));
  }
  return score('3.x baseline (emulated)', ranked, (Date.now() - s0) / questions.length);
}

// ------------------------------------------------------------------ run

const results: Metrics[] = [];
const legacy = await evalLegacy();
if (legacy) results.push(legacy);
results.push(await evalNew('4.0 keyword only (BM25)', { embeddingProvider: 'none' }));
results.push(await evalNew('4.0 hybrid, local multilingual-e5-small', { embeddingProvider: 'local' }));
if (process.env.OLLAMA_URL) {
  results.push(
    await evalNew('4.0 hybrid, Ollama nomic-embed-text', { embeddingProvider: 'ollama', embeddingModel: 'nomic-embed-text' }, {
      provider: 'ollama',
      ollama: { url: process.env.OLLAMA_URL, model: 'unused' },
    }),
  );
  const llmModel = process.env.OLLAMA_LLM ?? 'qwen2.5:3b';
  results.push(
    await evalNew(
      `4.0 hybrid, local e5 + smart terms (${llmModel})`,
      { embeddingProvider: 'local' },
      { provider: 'ollama', ollama: { url: process.env.OLLAMA_URL, model: llmModel } },
      true,
    ),
  );
  if (process.env.OLLAMA_EXTRA_MODEL) {
    results.push(
      await evalNew(`4.0 hybrid, Ollama ${process.env.OLLAMA_EXTRA_MODEL}`, { embeddingProvider: 'ollama', embeddingModel: process.env.OLLAMA_EXTRA_MODEL }, {
        provider: 'ollama',
        ollama: { url: process.env.OLLAMA_URL, model: 'unused' },
      }),
    );
  }
}
await paperless.close();

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
console.log(`\n${questions.length} questions, ${docs.length} documents\n`);
console.log(`${'Retrieval'.padEnd(46)} hit@1  hit@3  hit@5   MRR   ms/query`);
for (const r of results) {
  console.log(`${r.name.padEnd(46)} ${pct(r.hit1)}  ${pct(r.hit3)}  ${pct(r.hit5)}  ${r.mrr.toFixed(2)}  ${r.ms.toFixed(0).padStart(6)}`);
}
for (const r of results) {
  if (!r.misses.length) continue;
  console.log(`\nNot ranked first – ${r.name}:`);
  for (const m of r.misses) console.log(`  · ${m}`);
}
