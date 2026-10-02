# Paperless-AI 4 – Architecture

Paperless-AI is a single Node.js (≥ 22) process written in TypeScript. It serves a React single page
application and a JSON API, runs the document processing pipeline and keeps the search index for
“Ask your archive”. All state lives in `data/`:

| File | Content |
| --- | --- |
| `config.json` (+ `.bak`) | settings (written atomically, validated with zod) |
| `paperless-ai.db` | SQLite (WAL): users, processing state, history, token usage, RAG index |
| `models/` | cached local embedding model (only when local embeddings are used) |

On first start a legacy `data/.env` is converted into `config.json` and a legacy `data/documents.db`
is imported (users, processed documents, history, token metrics). The legacy files are not modified.

## Source layout

```
src/
  shared/api.ts          API contract (types only, shared by server and web)
  server/
    index.ts             bootstrap, graceful shutdown
    context.ts           AppContext: config, DB, lazily (re)built clients
    config/              schema (zod), store (env overrides, live reload), legacy .env mapping
    db/                  migrations, legacy import, repositories
    auth.ts              bcrypt, JWT session cookie, API key
    paperless/           Paperless-ngx client (API v7–v10), metadata cache with get-or-create
    ai/                  OpenAI-compatible/Azure, Anthropic and Ollama clients, JSON extraction, token estimation
    processing/          prompt builder, analyzer, applier (+ undo), engine (queue/scheduler), external API
    rag/                 chunker, SQLite store (FTS5), vector index, local embedder (worker), service, document chat
    http/ routes/        Fastify app, auth levels, SSE helper, route modules
  web/                   React 19 + Tailwind 4 UI (Vite), pages are code-split
    styles.css           design tokens (ink palette, accent presets via [data-accent], dark via [data-theme])
    components/          ui primitives, app shell (Layout), command menu, chat, settings forms
test/                    vitest unit & integration tests with fake Paperless/LLM servers
e2e/                     demo server + Playwright end-to-end tests
```

## Configuration

`ConfigStore` keeps the stored configuration and the environment overrides separately. The effective
configuration is `stored ⊕ env`, validated leniently (invalid values fall back to defaults instead of
crashing). Saving settings emits a `change` event; the Paperless client, the AI client, the scheduler
and the RAG service rebuild themselves from it – no restart. Secrets are never sent to the browser
(masked values round-trip unchanged).

## Paperless-ngx compatibility

`PaperlessClient` negotiates the API version on the first request: it asks for version 9 (accepted by
Paperless-ngx 2.16 – 3.x), reads `X-Api-Version` and then uses the highest supported version up to 10.
Older servers (406) fall back to the advertised version. The client never relies on the `all` field
(removed in API v10), paginates with page numbers, sends `created` as a date (`created_date` for API < 9),
and resolves the API user via `/api/ui_settings/`. Tags, correspondents and document types are resolved
case-insensitively; concurrent creations of the same name are de-duplicated.

## Document processing

```
scan (cron) ─┐
webhook ─────┼─▶ queue (dedup, concurrency) ─▶ analyze ─▶ plan update ─▶ PATCH ─▶ history + state
manual ──────┘                                   │
                                                 └─ prompt: system prompt + existing data/restrictions
                                                    + external data + generated output contract
```

* The output contract and a JSON schema are generated from the enabled functions (only requested
  fields are asked for; allowed values become enums when restricted).
* `OpenAiCompatibleClient` adapts to provider quirks at runtime (json_schema → json_object → plain,
  `max_completion_tokens`/`max_tokens`, unsupported temperature, reasoning budget, output limits,
  context length errors) and remembers what works.
* `AnthropicClient` uses the official SDK (streamed Messages API, structured outputs, cached system
  prompt) and adapts effort/sampling parameters per Claude model the same way.
* `OllamaClient` uses the native API with a fixed `num_ctx` (Ollama reloads the model when it
  changes), so long documents are neither truncated silently nor cause reloads; prompts are planned
  with that window minus room for thinking. `think` is sent when configured and dropped for models
  without thinking support.
* Rate limits (HTTP 429, Anthropic 529) pause the queue (Retry-After or growing back-off) and put
  the document back without counting an attempt.
* Model output is parsed leniently (fences, `<think>` blocks, trailing commas, truncated JSON) and
  normalised (dates, custom field values per type, “unknown”-like values).
* A document is only marked as processed after the PATCH succeeded. Failures are retried on later
  scans (`maxAttempts`); documents without permission or text are skipped until they change.
* Every change stores a snapshot of the previous values → *History → Undo* restores them.

## Ask your archive (RAG)

```
Paperless ──list (id, modified, metadata)──▶ diff ──▶ fetch content (batches) ──▶ chunk (~1200 chars)
                                                                         │
                       SQLite: rag_documents, rag_chunks, rag_fts (FTS5, contentless)
                                                                         │
                               embed pending passages (batches) ──▶ BLOB + in-memory int8 index
question ─▶ query analysis with the LLM (standalone query for follow-ups + search keywords)
        ─▶ BM25 (stemmed prefix terms, coverage-weighted) + vector search (question, keywords)
        ─▶ reciprocal rank fusion ─▶ boosts (mentioned correspondent/type/month/year, “latest”)
        ─▶ group by document (best passage decides, ≤ 3 passages)
        ─▶ context within token budget (short documents completely) ─▶ streamed answer with [n] citations
```

* Passages carry a metadata header (title, correspondent, type, date, tags) that is indexed with a
  higher BM25 weight and prepended for embeddings.
* Index synchronisation is incremental (by `modified` and metadata), runs every 15 minutes and after
  processing; deleted documents are removed. Keyword search works immediately, vectors follow.
* The vector index stores normalised vectors as int8 with a per-vector scale and is searched brute
  force with a bounded heap – milliseconds for archives with hundreds of thousands of passages.
* Query analysis (`rag.queryExpansion`) is one short JSON call (temperature 0) that also receives a
  few document titles, so the model can translate terms into the language of the archive. Any
  failure falls back to the original question. For first questions the user's wording stays the
  query; the keywords only add a second BM25/vector signal with half the weight.
* Boosts are uniform per mentioned attribute (all documents of the mentioned correspondent get the
  same bonus) so that they never prefer newer documents; only “latest …” questions add a recency bonus.
* Local embeddings run in a worker thread (`transformers.js`/ONNX, limited threads) that is stopped
  after 5 minutes of inactivity.

## HTTP API & security

* Fastify with zod validation; OpenAPI docs at `/api-docs`.
* Auth levels per route: `public`, `user` (session cookie or API key), `session` (logged-in user only,
  e.g. settings and API key), `setup` (only while no user exists).
* Session: HS256 JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` behind HTTPS); changing the
  password invalidates existing sessions. API key comparison is constant-time. Login is rate limited.
* CORS allows any origin without credentials (API key only), so browser extensions keep working.
* Server-sent events are used for chats and the live log; disconnecting clients abort the LLM request.
