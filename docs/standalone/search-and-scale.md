# Search and scale: 200,000+ documents

← [Overview](README.md)

## 1. Question

Is SQLite suitable for archives of 200,000 documents and more? Yes. The measurements below show
that SQLite itself is not the bottleneck. Three things around it are: the vector search, the
synchronous database driver on the event loop, and the storage size of the embeddings.

## 2. Measurements

**Setup:** synthetic data, `node:sqlite` (SQLite 3.54, the same engine better-sqlite3 bundles),
Node 22, 4 vCPU (Intel Xeon @ 2.1 GHz), 16 GB RAM, database warm in the page cache. Scripts:
[benchmarks/](benchmarks/). On a NAS with a Celeron-class CPU and HDDs, expect roughly 2–3× slower
numbers.

**Data:** 200,000 documents, Ø ~5 KB text (Zipf-distributed vocabulary of 60,000 words), 5 libraries,
300 tags (1–5 per document, the most common one on 31 % of the documents), 3,000 correspondents,
40 document types, a numeric custom field on half of the documents. The user may read 2 of the 5
libraries (~40 % of the archive).

### 2.1 SQLite (schema as in data-model.md, simplified)

| Query (with the library filter) | Median |
| --- | --- |
| Newest 50, one library / two libraries / all | 0.09 / 0.14 / 0.08 ms |
| Page 600: keyset / `OFFSET 30000` | 0.12 / 75 ms |
| Count of the user's documents | 4.7 ms |
| Filter on a tag with 1,400 documents, newest 50 | 0.9 ms |
| Filter on a tag with 62,000 documents (31 %), newest 50 | 57 ms |
| Two tags AND + correspondent | 27 ms |
| Count for the 31 % tag | 17 ms |
| Custom field "amount > 1500", sorted by amount | 0.14 ms |
| Facets: number of documents per tag (all 300 tags) | 170 ms |
| FTS5 + bm25, top 50: rare term (118 docs) / medium (1,800) / very common (132,000) | 0.3 / 2.6 / 73 ms |
| FTS5: medium AND very common | 8.5 ms |
| FTS5: 3-letter prefix | 43 ms |
| 1,000 new documents incl. FTS in one transaction | 0.71 s |
| Import of 200,000 documents incl. FTS (batches of 20,000) | 66 s |

Database size: **1.46 GB** (text 951 MB, FTS 458 MB, documents + indexes 37 MB).

**Reading:** almost everything is below 10 ms. The slow cases are known patterns with known fixes:
`OFFSET` → keyset pagination; facets → counters maintained on write; very frequent tags →
the denormalised index on `lib_document_tags`; stop-word-like search terms → rank only the top
candidates. These fixes are part of the schema in [data-model.md](data-model.md).

### 2.2 Vector search (as `src/server/rag/vectorIndex.ts` does it today)

200,000 documents give roughly 0.8–1M passages of ~1,200 characters.

| Passages × dims | int8 brute force (today) | 1-bit prefilter (top 1,000) | RAM int8 → 1 bit |
| --- | --- | --- | --- |
| 250,000 × 768 | 226 ms | 17 ms | 183 → 23 MiB |
| 1,000,000 × 768 | 911 ms | 74 ms | 732 → 92 MiB |
| 1,000,000 × 1536 | 2,120 ms | 127 ms | 1,465 → 183 MiB |

* `docs/ARCHITECTURE.md` says the brute-force scan takes "milliseconds for archives with hundreds
  of thousands of passages". Measured, it is hundreds of milliseconds at 250k and about a second at
  1M passages.
* `RagService` runs it **twice per question** (question and keywords,
  `src/server/rag/service.ts:555` and `:560`) **on the main thread**. At 1M passages that is about
  2 s during which no other HTTP request is served.
* Rescoring the 1,000 candidates with int8 costs well under 1 ms. The 1-bit prefilter plus int8
  rescoring is therefore ~12× faster with 8× less RAM, at practically the same result quality
  (standard technique; to be confirmed with the existing RAG evaluation in `e2e/rag-eval`).

## 3. Problems and decisions

| Problem | Decision |
| --- | --- |
| Vector search blocks the event loop and scales linearly in JS | 1-bit prefilter + int8 rescoring, in a worker thread (§5) |
| better-sqlite3 is synchronous: 50–170 ms queries block all requests | Read connections in worker threads for heavy reads (§5) |
| Embeddings stored as float32 in `rag_chunks` (3–6 GB at 1M passages) | Store int8 + scale (4× smaller). The 1-bit codes are derived at load time. |
| `rag_chunks.text` copies the document text (+~1 GB) | Built-in: chunks store `(version, start, end)` offsets into `lib_document_text`. Companion: unchanged (the text lives in ngx). |
| `OFFSET` pagination | Keyset pagination everywhere (`(created, id) < (?, ?)`) |
| Facet counts over large libraries | `lib_counters`, maintained in the write transactions |
| Index rebuilds / size dominate backups | Separate `index.db` ([data-model.md](data-model.md#1-database-files)) |

## 4. Full text search

Two indexes with different jobs:

| | `lib_fts` (built-in, core DB) | `rag_fts` (both modes, index.db) |
| --- | --- | --- |
| Unit | document (title, current text, metadata line) | passage (~1,200 characters) |
| Used by | document list search, command palette, workflows (`text contains`), `post_document`-style clients | Ask your archive, document chat (hybrid with vectors) |
| Updated | in the same transaction as the document | after the change (event-driven instead of the 15-minute poll) |
| Query | FTS5 `MATCH` with the stemmed prefix terms from `rag/text.ts` (one tokenizer and stemmer for both) | as today |

* Document list search: bm25 with weights title 3, metadata 2, body 1, limited to the readable
  libraries, top 1,000 joined with the other conditions. bm25 costs ~0.7 µs per match, so a term
  that matches more than 5,000 documents is ranked among its newest 5,000 matches only (a rowid
  bound found with one `ORDER BY rowid DESC` step); if the other conditions leave too few of them,
  the query is repeated without the bound. Snippets are made in JavaScript from the stored text.
* Prefix indexes for 3 **and 4** characters: terms from four letters on are searched as prefixes
  (stemmed), and a 4-letter prefix without its own index merges the posting lists of every term
  that starts with it (0.7 s for "post*" in the fixture, < 50 ms with the index; +46 % FTS size).
* Companion mode: the document list search stays on the Paperless-ngx search API
  (`searchDocuments`), as today. Ask your archive uses `rag_fts`.
* German compound words ("Krankenversicherungsbeitrag") are covered by prefix search and the
  existing stemmer. A trigram index (FTS5 `trigram` tokenizer, ~3× larger) is an option for real
  substring search, and is decided after testing with real archives.

## 5. Worker threads

```
main thread (Fastify, engine, writes)          worker pool (read-only)
  ├─ single writer connection (short transactions)    ├─ reader 1: SQLite (core + index, read-only)
  ├─ request ─▶ light query (by id, page)            ├─ reader 2: SQLite
  └─ request ─▶ heavy query ──────────────────────▶  └─ vector worker: VectorIndex (1-bit + int8)
                   ◀────────────── rows (structured clone)
```

* **Writer:** one connection in the main thread, as today. Write transactions are short (one
  document). Bulk work (import, re-index) is batched into transactions of ~500 documents, with a
  `setImmediate` between batches.
* **Readers:** `src/server/db/readers.ts` starts N worker threads (default `min(4, cpus − 1)`,
  `PAPERLESS_AI_READERS`), each with a read-only connection (`readonly: true`, same pragmas,
  `query_only = ON`). WAL allows parallel readers next to the writer. `LocalBackend` sends the SQL
  it builds (never user input – values are parameters) with `reader.all/get`; the worker keeps the
  last 300 prepared statements. The least busy worker gets the query. In tests (and with
  `PAPERLESS_AI_READERS=0`) the queries run on the main connection.
* What goes to the readers: FTS searches, facets, statistics / dashboard, history pages, exports,
  RAG BM25. What stays on the main thread: lookups by primary key and first pages of lists
  (sub-millisecond).
* **Vector worker:** holds the `VectorIndex` (1-bit codes + int8 vectors). It loads from `index.db`
  on start and gets add/remove messages from the RAG service. The search request carries the
  `allowDocs` set (or library ids) of the scope.
* Local embeddings already run in a worker (`rag/localEmbedder.ts`). The new workers follow the
  same pattern (start on demand, end after idle time).

## 6. Targets

Reference: the benchmark machine above, 200,000 documents / 1M passages, warm cache.
`npm run perf` measures them against a generated fixture (`e2e/perf/`, see §6.1).

| Operation | Target (p95) |
| --- | --- |
| Document list page (any filter combination of the UI) | < 50 ms |
| Document list search (FTS) | < 100 ms |
| Facets (sidebar counts) | < 20 ms |
| Ask your archive: retrieval (BM25 + vectors + fusion), without LLM | < 300 ms |
| Longest event loop block caused by search | < 50 ms |
| Intake: upload of a 10-page digital PDF until it appears in the list | < 3 s |
| Import from Paperless-ngx | limited by download speed, not by the database |

A 200k-document fixture (generated like the benchmark, plus files) runs these as a nightly
performance test ([testing-and-operations.md](testing-and-operations.md)).

### 6.1 Measured (M4)

`npm run perf -- --documents 200000 --passages 250000 --dims 768` on a 4-core cloud VM (Node 22,
3 read workers), p50 / p95 of 9 runs:

| Operation | p50 | p95 | Target |
| --- | --- | --- | --- |
| Newest 50, all libraries / member of 2 libraries | 1.3 / 1.5 ms | 2.2 / 4.9 ms | < 50 ms |
| Page 21 with a keyset cursor / page 600 by number (`OFFSET`) | 1.0 / 1.6 ms | 4.3 / 2.2 ms | < 50 ms |
| Frequent tag (17k) / rare tag (512), newest 50 | 1.5 / 1.5 ms | 3.1 / 3.5 ms | < 50 ms |
| Two tags AND + correspondent | 13 ms | 25 ms | < 50 ms |
| Custom field "amount ≥ 1500" | 2.7 ms | 9.2 ms | < 50 ms |
| Full text: rare / medium / very common word (130k docs) | 3.3 / 8.0 / 52 ms | 4.3 / 15 / 66 ms | < 100 ms |
| Full text: 4-letter prefix "post*" | 40 ms | 48 ms | < 100 ms |
| Facets without filter (counters), admin / member | 2.2 / 0.8 ms | 6.0 / 6.8 ms | < 20 ms |
| Facets with a filter: rare tag / medium word / frequent tag (17k) | 2.6 / 12 / 64 ms | 9.3 / 16 / 72 ms | – |
| Count without filter / frequent tag | 1.3 / 19 ms | 1.9 / 30 ms | – |
| Longest event loop block, 40 heavy queries at once | | 18 ms | < 50 ms |
| Vector search top 50, 250k × 768 (285 MiB) / 40 % of documents allowed | 21 / 19 ms | 27 / 25 ms | < 300 ms (retrieval) |

What made the difference (first run → final): sort indexes on the exact sort expression
(`COALESCE(created, '')`, newest 50: 34 → 1.3 ms), choosing the tag lookup by the counters (rare
tag: 91 → 1.5 ms), ranking only the newest 5,000 matches of very common terms (148 → 52 ms), the
4-letter prefix index (715 → 40 ms), facets in one statement over a materialized match set
(211 → 64 ms) and counters for unfiltered facets (any size → 2 ms).

## 7. Beyond 1M documents

The list and filter queries stay index ranges and do not grow. Scans (facets without counters,
`count(*)` over everything, frequent FTS terms) grow linearly, which is why counters, top-N ranking
and keyset pagination are rules from the start. For vectors beyond ~5M passages, an approximate
index (HNSW via `usearch`, or `sqlite-vec`) can replace the brute-force prefilter behind the same
worker interface. Filtering by library then needs one index per library or filtered search support,
which is why it is not the default.
