# Testing and operations

← [Overview](README.md)

## 1. Test strategy

| Layer | What | Where |
| --- | --- | --- |
| Unit | repositories (SQL), blob store protocol, templates, condition evaluation, permission checks, quantisation | `test/archive/`, `test/workflows/`, `test/access/` |
| **Backend contract suite** | one test suite for `DocumentBackend` that runs against `PaperlessBackend` + mock Paperless **and** against `LocalBackend` + temp directory: list/filter/search semantics, get/update/`modified` changes, metadata get-or-create (case-insensitive, concurrent), download, thumbnails, ingest, capabilities | `test/backend/contract.test.ts` |
| Integration | routes through `test/helpers/appHarness.ts` with the mock LLM, in both modes (parametrised) | `test/integration/` |
| **Permission matrix** | every route × every role / scope, two libraries, no foreign id in responses, SSE or LLM prompts | `test/integration/permissions.test.ts` ([access-control.md](access-control.md#11-tests)) |
| **Crash safety** | a child process ingests files and is killed (`SIGKILL`) at random points. Invariants afterwards: no document without blob, no duplicate document for the same intake, orphan blobs collected by GC, the database passes `quick_check`. | `test/archive/crash.test.ts` |
| Migration | importer against the mock Paperless server (fixture ~1,000 documents), resume, incremental sync, permission strategies, nothing re-queued | `test/migration/` |
| Workflows | triggers, loop protection, `analysis.before`, migrated prompt rules give identical results | `test/workflows/` |
| E2E (Playwright) | the demo server gets `--mode builtin` next to the mock Paperless mode. Upload → list → detail → edit → version → undo; workflow dry run; mode choice in setup. | `e2e/` |
| Performance (nightly) | 200k-document fixture, targets from [search-and-scale.md](search-and-scale.md#6-targets), event loop delay measured with `perf_hooks.monitorEventLoopDelay`; `npm run perf -- --check` fails on a missed p95 | `e2e/perf/`, `.github/workflows/perf.yml` |
| RAG quality | the existing evaluation (`e2e/rag-eval`) before/after the 1-bit prefilter; recall@k must not drop measurably | `e2e/rag-eval` |

Rules:

* Every new route is part of the permission matrix (the test fails for routes it does not know).
* Every new `DocumentBackend` method is part of the contract suite.
* Tests of the built-in archive use real files in a temp directory (no mocked file system), so the
  write protocol is really exercised.

## 2. Demo and development

* `npm run demo` keeps starting the companion setup with the mock Paperless server.
  `npm run demo -- --mode builtin` starts the built-in archive with a temp storage directory and
  sample PDFs (generated, no real personal documents).
* `npm run fixture:archive -- --documents 200000` creates the performance fixture (database with
  the real schema, words, metadata and tags Zipf-distributed like
  `docs/standalone/benchmarks/bench-sqlite.mjs`; one shared PDF, `--files` for one per document).
  `npm run perf` creates it on first use and measures lists, full text, facets, counts, the event
  loop under 40 parallel queries and the vector index (`--passages`, `--dims`).

## 3. CI

Existing `ci.yml`: `npm ci`, typecheck, lint, `npm test`, build, Playwright. Added:

* E2E for both modes (matrix `mode: [paperless, builtin]`).
* Nightly: performance fixture, RAG evaluation, round trip export → `document_importer` with the
  official Paperless-ngx Docker image ([migration.md](migration.md#5-built-in-archive--paperless-ngx)).

## 4. Docker

The image does not change: PDFium, sharp, ONNX Runtime and better-sqlite3 are already in it.

Companion mode: the existing `docker-compose.yml`. Built-in archive (new example
`docker-compose.builtin.yml`):

```yaml
services:
  paperless-ai:
    image: clusterzx/paperless-ai:latest
    restart: unless-stopped
    environment:
      - PAPERLESS_AI_ARCHIVE=builtin            # optional, the setup asks otherwise
      - PAPERLESS_AI_CONSUME_DIR=/consume
    ports:
      - "3000:3000"
    volumes:
      - paperless-ai_data:/app/data             # databases – keep on a local disk
      - /srv/archive:/app/data/library          # blob store – may live on a separate (large) disk
      - /srv/scans:/consume                     # watch folder (scanner, SMB/FTP sidecar)
  # optional, for Office documents (later):
  # gotenberg:
  #   image: gotenberg/gotenberg:8
volumes:
  paperless-ai_data:
```

The docs include examples for an FTP or SMB sidecar container that writes into `/consume`, for
scanners that cannot use WebDAV or the REST upload.

## 5. Configuration reference (new)

| Environment variable | Config path | Default |
| --- | --- | --- |
| `PAPERLESS_AI_ARCHIVE` | `archive.mode` | `paperless` (existing installs), set by setup otherwise |
| `PAPERLESS_AI_STORAGE_DIR` | `archive.builtin.storageDir` | `<dataDir>/library` |
| `PAPERLESS_AI_CONSUME_DIR` | `archive.builtin.consumeDir` | empty (off) |
| `PAPERLESS_AI_CONSUME_POLL` | `archive.builtin.consumePollSeconds` | `10` |
| `PAPERLESS_AI_MAIL_POLL` | `archive.builtin.mailPollMinutes` | `5` |
| `PAPERLESS_AI_MAX_UPLOAD_MB` | `archive.builtin.maxUploadMb` | `200` |
| `PAPERLESS_AI_READERS` | – | `min(4, cpus)` worker threads for reads |
| `PAPERLESS_AI_BACKUP_KEEP` | `archive.backup.keep` | `7 daily, 4 weekly` |

Mail accounts, WebDAV, intake folders, libraries and workflows are configured in the UI (database).

## 6. Operations

**Health:**

* `/health` (exists, public) stays minimal. `/api/health/details` (admin) adds the database
  `quick_check` result and date, the blob verification progress and failures, free disk space of
  the data and storage directories, the intake failures and workflow failures of the last 24 h, the
  queue lengths, and a network-file-system warning.
* The dashboard shows the same as a health panel for admins.

**Disk space:**

* Warning below 5 GB or 10 % free (setting).
* Intake is refused below 1 GB free, with a clear error in the inbox and to API clients (`507`).
  This protects the database from a full disk in the middle of a transaction.

**Logs:** new logger modules `archive`, `intake`, `workflows`, `migration`, shown in the live log
like the existing ones.

**Backups and restore:** see [data-model.md](data-model.md#8-pragmas-maintenance-backups). The docs
contain a tested restore procedure ("restore drill") and a restic example for the blob store.

## 7. Documentation deliverables

* README: the two modes, the setup choice, a short comparison.
* `docs/ARCHITECTURE.md`: backend abstraction, built-in archive, worker threads. Fix the vector
  search claim ("milliseconds for hundreds of thousands of passages", measured 226 ms at 250k).
* Guides: built-in archive setup, scanners (WebDAV / SMB / FTP / apps), e-mail intake, workflows,
  migration from Paperless-ngx, backups and restore.
* Release notes per milestone, with what changes for companion users (usually: new features, no
  required action).
