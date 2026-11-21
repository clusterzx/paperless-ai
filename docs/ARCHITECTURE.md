# Paperless-AI 4 – Architecture

Paperless-AI is a single Node.js (≥ 22) process written in TypeScript. It serves a React single page
application and a JSON API, runs the document processing pipeline and keeps the search index for
“Ask your archive”. All state lives in `data/`:

| File | Content |
| --- | --- |
| `config.json` (+ `.bak`) | settings (written atomically, validated with zod) |
| `paperless-ai.db` | SQLite (WAL): users, libraries, processing state, history, token usage; in built-in mode the archive (documents, metadata, versions, change log, full text) |
| `index.db` | SQLite (WAL): the search index of “Ask your archive” (passages, FTS5, int8 embeddings) – can be rebuilt, kept apart so the core database stays small to back up |
| `library/` | built-in mode: the files, content addressed by SHA-256 (`archive.builtin.storageDir`) |
| `models/` | cached local embedding model (only when local embeddings are used) |

On first start a legacy `data/.env` is converted into `config.json` and a legacy `data/documents.db`
is imported (users, processed documents, history, token metrics). The legacy files are not modified.

## Source layout

```
src/
  shared/api.ts          API contract (types only, shared by server and web)
  shared/ocr.ts          OCR options (languages, modes, quality presets)
  shared/promptWizard.ts prompt wizard answers → system prompt (used for the live preview and on the server)
  server/
    index.ts             bootstrap, graceful shutdown
    context.ts           AppContext: config, DB, lazily (re)built clients
    config/              schema (zod), store (env overrides, live reload), legacy .env mapping
    db/                  migrations, legacy import, repositories
    auth.ts              bcrypt, JWT session cookie, API key
    oidc.ts              single sign-on: OpenID Connect discovery, code flow with PKCE, groups, provider logout
    paperless/           Paperless-ngx client (API v7–v10), metadata cache with get-or-create
    ai/                  OpenAI-compatible/Azure, Anthropic and Ollama clients, JSON extraction, token estimation
    processing/          prompt builder, analyzer, applier (+ undo), engine (queue/scheduler), external API
    rag/                 chunker, SQLite store (FTS5), vector index (worker), local embedder (worker), service, document chat
    archive/             built-in archive: LocalBackend, blob store, intake (upload, folder, mail), maintenance, counters
    workflows/           triggers → conditions → actions, analysis.before (prompt rules), run log, notifications
    ocr/                 PaddleOCR via ONNX Runtime (child process): rendering, detection post-processing, recognition,
                         reading order, text-quality heuristic, service (when to read, write-back, undo)
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

## Archive backends

Documents live either in Paperless-ngx (companion mode) or in the built-in archive
(`archive.mode`). Everything outside `src/server/backend/` and `src/server/archive/` works with the
`DocumentBackend` interface (`backend/types.ts`): `ctx.backend(scope)` returns a `BackendView` bound
to an access scope (system scope for internal work), `ctx.metadata(libraryId)` the metadata cache of
a namespace (Paperless-ngx has one, the built-in archive one per library). Features ask the backend's
capabilities (`SessionInfo.archive.capabilities`), never the mode. Committed changes are published on
the document event bus (`events.ts`); `wiring.ts` connects the RAG index and the calendar to it.
`test/backend/contract.ts` is the test suite every backend must pass. The plan for the built-in archive
is in `docs/standalone/`.

Built-in archive at scale (`archive/backend.ts`, measured with `npm run perf` on 200,000 documents):

* Heavy reads – lists, full text, counts, facets – run on read-only connections in worker threads
  (`db/readers.ts`, `db/readWorker.ts`; WAL lets them read next to the single writer). Tests and
  `PAPERLESS_AI_READERS=0` run them on the main connection.
* Lists use keyset cursors on indexes that match the sort expression exactly (`COALESCE(created, '')`).
  Tag filters either walk the sort index and check each document (frequent tags) or start from the
  tag's documents (rare tags, all counts); the counters decide (`rareTags`).
* `lib_counters` holds document counts per library, tag, correspondent and type, maintained by SQLite
  triggers in the writing transaction (`archive/counters.ts`); unfiltered facets and the metadata lists
  read them, the weekly maintenance compares them with a recount.
* Full text: `lib_fts` (FTS5, prefix indexes for 3 and 4 characters). A term that matches more than
  `rankCandidates` (5,000) documents is ranked by bm25 among its newest matches only, unless the
  other conditions leave too few of them.

Libraries and access (`access/`, `http/policy.ts`, `db/scoped.ts`):

* The route policy table decides who may call a route at all (admin, API key scope); library roles
  are checked per document by the backend. Instance-wide lists – history, problems, statistics,
  OCR list, processing status, metadata, calendar – take the caller's readable libraries
  (`readableLibraries(scope)`, `null` in companion mode) and filter in SQL (`inLibraries`).
* Ask your archive stores `library_id` per indexed document (`index.db`); BM25, the vector search
  (`allowDocs`), the boosts for mentioned names and the sample titles sent to the AI are limited to
  the caller's libraries, so foreign passages never reach a prompt. `test/integration/isolation.test.ts`
  checks every GET route, Ask/chat and the AI prompts for a marker from a foreign library.
* File versions: a new version or a switch is a change log event; undo makes the previous version
  current again, undoing a trash move restores (`UNDOABLE_KINDS` in `archive/backend.ts`).

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
* The prompt library (`prompts`, `prompt_ratings`; `routes/prompts.ts`) keeps prompts with a use case
  and ratings per provider/model. Activating one writes it to `processing.systemPrompt`; a prompt made
  with the wizard brings its answers back (`promptWizard`, e.g. the output language), any other one
  marks the prompt as hand-written. The same text is never stored twice – saving it again adds a rating.
* Calendar (`processing.functions.events`): the schema and the output contract get an `events` list
  (title, date, time, kind); `suggestion.ts` normalises it and the engine stores it after the PATCH
  (`calendar_events`, `calendar_scans`; a re-analysis replaces the dates of a document, dismissed ones
  stay dismissed). `calendar/scanner.ts` searches earlier documents with the same analysis but only
  the `events` function enabled, so nothing else is asked for or changed. `calendar/ics.ts` writes the
  iCal feed (RFC 5545: escaping, 75-octet folding, all-day/floating times, alarms) behind a secret
  token in the URL (`kv: calendar.feedToken`).

## Workflows

```
document events ─┐                     ┌─ conditions (cheap first, AI questions last, cached) ─┐
schedule / dates ┼─▶ workflow_runs ───▶│                                                       ├─▶ step log
manual / API ────┘   (queue, durable)  └─ actions: field changes in one write, notifications …  ┘
processing job ─▶ analysis.before workflows (synchronous) ─▶ prompt + settings for the AI analysis
```

* `workflows/engine.ts` turns document events (added, processed, updated, new version), cron
  schedules, dates and manual requests into runs; a worker takes them (one at a time per
  document), evaluates the conditions and runs the actions with the workflow's own scope
  (its library, or everything for global ones). Interrupted runs are queued again on start.
* Loop protection: a workflow's own change never triggers it again, chains end at depth 3, and at
  most 10 runs per workflow and document per hour.
* `analysis.before` is evaluated inside the processing job (`workflows/analysis.ts`) – this is what
  prompt rules are now. New documents wait for their `document.added` workflows (bounded), so a
  workflow can still skip or shape the analysis.
* Notifications: in the app, e-mail (`notifications.smtp`, nodemailer), webhooks with an HMAC
  signature (`X-Paperless-AI-Signature`) or as ntfy / Gotify messages; retried up to three times.

## OCR

```
engine job ─▶ needs OCR? (mode: always / missing / poor = text-quality score) ─▶ download original
   (or archived PDF) ─▶ OCR worker ─▶ text ─▶ scores better than the Paperless text?
   ─▶ yes: optional PATCH content (old text kept for undo), analyze the OCR text; no: analyze the Paperless text
```

* `ocr/render.ts` turns PDFs into page images with PDFium (WebAssembly) and decodes images with sharp
  (EXIF orientation, multi-page TIFF). Pages are rendered one at a time.
* `ocr/pipeline.ts` runs the PP-OCRv5 models with ONNX Runtime: page orientation (0/90/180/270°) →
  DB text detection (`detPost.ts`: threshold → connected regions → minimum-area rectangle → box
  score → unclip, no OpenCV) → perspective crop → text-line orientation (0/180°) → CTC recognition.
  `layout.ts` straightens skewed scans and builds lines and paragraphs.
* Execution provider: `auto` tries CUDA (when the provider library is installed, i.e. the `-cuda`
  image) or DirectML (Windows) and falls back to the CPU.
* Models come from the PaddlePaddle repositories on Hugging Face, pinned to a revision, cached in
  `data/models/paddleocr`.
* The worker is a child process (`ocr/worker.ts`, forked by `ocr/runner.ts`): ending it frees all of
  its memory – including the CUDA context, which would otherwise stay with the server process – and
  a crash of a native library cannot take the server down. It is started on demand and ends after
  each document read on the GPU (`ocr.release: auto`; before the AI analysis, so that a local model
  on the same GPU gets the memory) or after 10 idle minutes, and on its own when the server goes
  away. Jobs run through the normal processing queue, so a manual OCR request is followed by the AI
  analysis.
* `ocr_documents` holds the text-quality score of every document (refreshed incrementally on the OCR
  page and after each analysis), `ocr_results` the OCR text, the previous Paperless text (undo) and
  the document version it belongs to. Text that is not written back replaces the Paperless text for
  the analysis and the RAG index.

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
* The vector index stores normalised vectors as int8 with a per-vector scale (`PQ8` blobs in
  `index.db`, older float32 blobs are converted when the index moves out of `paperless-ai.db`). From
  20,000 passages on a 1-bit sign code preselects the closest max(20·k, 2,000) candidates by Hamming
  distance, which are then scored exactly with int8. It runs in a worker thread
  (`rag/vectorWorker.ts`, `rag/vectorSearch.ts`), so searches never block the server: ~25 ms for
  250,000 passages × 768 dimensions.
* Query analysis (`rag.queryExpansion`) is one short JSON call (temperature 0) that also receives a
  few document titles, so the model can translate terms into the language of the archive. Any
  failure falls back to the original question. For first questions the user's wording stays the
  query; the keywords only add a second BM25/vector signal with half the weight.
* Boosts are uniform per mentioned attribute (all documents of the mentioned correspondent get the
  same bonus) so that they never prefer newer documents; only “latest …” questions add a recency bonus.
* Local embeddings run in a worker thread (`transformers.js`/ONNX, limited threads) that is stopped
  after 5 minutes of inactivity.
* Prompt rules (`processing/promptRules.ts`, `routes/promptRules.ts`, `processing.promptRules`): before the
  analysis the engine takes the first enabled rule whose conditions match the document (names compared
  like Paperless names; storage paths and users are loaded only when a rule needs them). The rule
  yields a copy of the processing settings – prompt from the library, field switches, custom field
  subset, restrictions, allowed tag / document type lists – and an optional model; prompt building,
  planning the update and the calendar all use that copy, so nothing else needs to know about rules.
  `history.prompt_id/prompt_name` record the prompt. A webhook/API `prompt` skips the rules.
* Embedding prompts (`shared/embeddingPrompts.ts`) are applied by `RagService` for every provider:
  own prompts (`rag.queryPrompt`/`rag.documentPrompt`) or automatic ones for measured model families.
  The stored embedding key (`kv.rag_embedding_key`) only gets a prompt hash when the embedded texts
  differ from earlier versions, so updates never re-embed by themselves. An index made without the
  prompts its model now gets automatically keeps them off until the admin switches
  (`POST /api/rag/embedding-prompts`, `kv.rag_prompts_accepted`).

## HTTP API & security

* Fastify with zod validation; OpenAPI docs at `/api-docs`.
* Auth levels per route: `public`, `user` (session cookie or API key), `session` (logged-in user only,
  e.g. settings and API key), `setup` (only while no user exists).
* Session: HS256 JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` behind HTTPS); changing the
  password invalidates existing sessions. API key comparison is constant-time. Login is rate limited.
* Two-factor authentication (`totp.ts`, `twoFactor.ts`, `routes/twoFactor.ts`): TOTP (RFC 6238, SHA-1,
  6 digits, 30 s, ±1 step) with replay protection (`users.totp_last_step`) and ten recovery codes
  stored as salted scrypt hashes. With 2FA the password login returns a 5-minute ticket signed with a
  key derived from the JWT secret – a ticket can never pass as a session – and `/api/auth/login/2fa`
  turns ticket + code into the session cookie. Enabling 2FA ends all other sessions.
  `PAPERLESS_AI_RESET_2FA=<user>` switches it off at start-up. API keys are not affected.
* Single sign-on (`oidc.ts`, `routes/oidc.ts`, `openid-client`): authorization code flow with PKCE (S256),
  `state` and `nonce`. Nothing is stored on the server during the flow: state, nonce, code verifier,
  redirect URI and the target path live in a 10-minute HS256-signed cookie (key derived from the JWT
  secret, `SameSite=Lax`, path `/api/auth/oidc`). The callback verifies the ID token, merges the userinfo
  claims (groups are often only there), checks the allowed groups and maps `(issuer, sub)` to a user
  (`users.oidc_issuer/oidc_subject`, unique). Accounts are created on the first sign-in (`autoCreate`)
  or linked by a signed-in user (`?link=1`); SSO-only accounts have no password hash and cannot use the
  password login. The ID token is kept in an `httpOnly` cookie for RP-initiated logout. Discovery is
  cached for an hour and refreshed on config changes. The password login can only be switched off while
  SSO is usable and – in the UI – only by a linked account. The local 2FA applies to the password login.
* CORS allows any origin without credentials (API key only), so browser extensions keep working.
* Server-sent events are used for chats and the live log; disconnecting clients abort the LLM request.
