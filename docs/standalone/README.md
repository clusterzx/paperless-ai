# Built-in archive (standalone mode) – plan

Status: **proposal / planning** · Branch: `claude/busy-fermat-647g3o` · Origin: [Discussion #1019](https://github.com/clusterzx/paperless-ai/discussions/1019)

This folder describes what will be built, why, and how. It is the reference for the implementation
and for reviewing it. Everything here is open to change until the matching milestone starts. The
decision log at the end records what has been settled.

| Document | Content |
| --- | --- |
| [README.md](README.md) | Product view: goals, the two modes, feature matrix, milestones, decisions, open questions |
| [architecture.md](architecture.md) | Backend abstraction, capabilities, context changes, config, setup, event bus, code layout |
| [data-model.md](data-model.md) | Database files, schema, file storage, versions, change log, trash, backups |
| [access-control.md](access-control.md) | Roles, groups, libraries, `AccessContext`, API keys, permissions in companion mode |
| [ingest.md](ingest.md) | Upload, API, watch folder, e-mail, WebDAV, mobile; the intake pipeline |
| [workflows.md](workflows.md) | Triggers, conditions, actions, execution engine, prompt rules migration |
| [search-and-scale.md](search-and-scale.md) | Benchmarks for 200k documents, query rules, full text, RAG and vector index changes |
| [ui-and-api.md](ui-and-api.md) | New pages, changes to existing pages, REST API |
| [migration.md](migration.md) | Upgrading existing installations, Paperless-ngx → built-in archive, export back to Paperless-ngx |
| [testing-and-operations.md](testing-and-operations.md) | Test strategy, Docker, configuration, backups, monitoring |
| [benchmarks/](benchmarks/) | Scripts behind the numbers in `search-and-scale.md` |

---

## 1. Summary

Paperless-AI 4 already does most of what a document archive needs: its own OCR (PaddleOCR via ONNX),
AI extraction of metadata, custom fields and dates, hybrid search (FTS5 + embeddings), users with
2FA, OIDC and API keys. Paperless-ngx mostly serves as file and metadata storage, and OCR and search
indexing happen twice.

Paperless-AI gets a **built-in document archive**. When setting it up, the user chooses:

* **Companion mode**: Paperless-AI runs next to a Paperless-ngx instance, as it does today.
  Paperless-ngx stays the archive, and Paperless-AI analyses, enriches and searches it.
* **Built-in archive**: Paperless-AI is the archive. It stores documents (files + SQLite) and
  takes them in through upload, API, watch folder, e-mail and WebDAV. It offers versions, workflows
  and archives shared by several users. Paperless-ngx, Redis and Postgres are not needed.

Both modes are first-class. One codebase serves both through a backend interface. A migration
assistant moves an existing Paperless-ngx archive into the built-in archive, and an export leads
back to Paperless-ngx.

## 2. Background

* Discussion #1019 (Nov 2026) proposed an optional standalone mode. The maintainer confirmed it is
  planned and that Paperless-ngx stays supported.
* The work is duplicated today. Paperless-ngx runs OCR (Tesseract) and full text indexing (Whoosh).
  Paperless-AI reads the documents again (PaddleOCR) and builds its own index (FTS5 + vectors).
* Requests from the discussion: intake via web, e-mail and apps; an intake directory (possibly
  WebDAV for scanners); folder structure possibly derived from the AI analysis.

## 3. Goals

1. **The user decides** between companion mode and the built-in archive during setup. Both remain
   fully supported.
2. **A complete archive** in the built-in mode:
   * Intake from web upload, REST API, watch folder, e-mail (IMAP), WebDAV and mobile share.
   * Storage of originals that are never modified, with checksums.
   * List, filter, full text search, viewer, editing, bulk editing, trash.
   * **Versioning**: file versions (new scan, edited PDF) and a complete change log of all metadata
     changes, with undo.
   * **Workflows**: triggers, conditions and actions, including AI conditions and AI actions.
     Prompt rules become a special case.
   * **Archives for several users** ("libraries") with members, roles and groups. Search, chat,
     calendar and statistics respect them.
3. **Better than the status quo, not a copy**. Concretely: one container instead of
   ngx + Redis + Postgres; a change log and undo for every change; workflows with a visible run log
   and dry run; permission-aware semantic search; a modern UI.
4. **Scales to 200,000+ documents** on modest hardware (see [search-and-scale.md](search-and-scale.md)).
5. **No lock-in**: an ngx archive can be migrated with the same IDs, and the built-in archive can
   be exported in the Paperless-ngx exporter format.
6. **Companion users profit too**: the new document UI, roles, workflows and the faster vector
   search also work against Paperless-ngx.

## 4. Non-goals (for now)

| Non-goal | Reason / alternative |
| --- | --- |
| Postgres / MariaDB support | SQLite handles the target size (measured). A second database would double the test matrix and require making the whole repository layer async. Revisit only for multi-instance / HA needs. |
| Switching the mode at runtime, or a hybrid of both | One source of truth per instance. Switching works through the migration assistant. |
| Paperless-ngx REST API compatibility | Only an upload endpoint compatible with `post_document` is considered (scanner apps, shortcuts), see [ingest.md](ingest.md). |
| Office documents in the first release | PDF and images first, since the OCR pipeline already reads them. Office formats later via an optional Gotenberg sidecar. |
| Horizontal scaling, several app instances | Self-hosted single-container product. |
| Native mobile apps | PWA (install, share target, camera upload) plus the REST API for existing scanner apps. |
| Barcode / separator page splitting, notes, share links | Later, after the core is stable. |

## 5. The two modes

```
                         ┌──────────────── Paperless-AI ────────────────┐
 Upload · API · Folder   │  UI · Ask · Chat · Calendar · Workflows      │
 Mail · WebDAV · PWA ───▶│  Processing engine · OCR · RAG index         │
                         │                    │                         │
                         │            DocumentBackend                   │
                         │           ┌────────┴────────┐                │
                         │   PaperlessBackend     LocalBackend          │
                         └───────────┬──────────────────┬───────────────┘
                                     │                  │
                              Paperless-ngx      SQLite + blob store
                              (companion)         (built-in archive)
```

* The mode is stored in `config.json` as `archive.mode: 'paperless' | 'builtin'`. It is set in the
  setup wizard, can be pinned with `PAPERLESS_AI_ARCHIVE`, and is changed only by the migration
  assistant.
* Existing installations are migrated to `paperless` automatically. Nothing changes for them.
* Features ask the backend what it can do (**capabilities**), never the mode. See
  [architecture.md](architecture.md#3-capabilities).

### Feature matrix

| Feature | Companion (Paperless-ngx) | Built-in archive |
| --- | --- | --- |
| AI analysis, OCR, Ask your archive, document chat, calendar | ✓ | ✓ |
| Document list, viewer, editing, bulk edit | ✓ via the ngx API | ✓ |
| Metadata management (tags, correspondents, types, custom fields) | ✓ via the ngx API | ✓ |
| Upload, REST upload | forwarded to ngx (`post_document`) | ✓ native |
| Watch folder, e-mail, WebDAV | handled by ngx (it has consume folder and mail) | ✓ native |
| Workflows | ✓ (actions through the ngx API; overlap with ngx workflows is explained in the UI) | ✓ |
| Change log + undo | for changes made through Paperless-AI | for every change |
| File versions | – (Paperless-ngx's business) | ✓ |
| Libraries with members and roles | – (Paperless-ngx permissions apply, see [access-control.md](access-control.md#7-companion-mode)) | ✓ |
| Trash | ngx trash | ✓ |
| Roles in Paperless-AI (admin / member), API keys per user | ✓ | ✓ |
| Migration assistant | source | target |

## 6. Principles

1. **One codebase, two backends.** All document access goes through `DocumentBackend`. Nothing
   outside the backend knows about HTTP to Paperless or about blob paths.
2. **Capabilities, not modes.** `if (caps.fileVersions)`, never `if (mode === 'builtin')`.
3. **The internal document model stays Paperless-shaped**: numeric IDs, tags, correspondent,
   document type, custom fields, `modified`. The engine, OCR and RAG detect changes through
   `modified`. A backend that updates `modified` on every change works with them unchanged.
4. **The schema is complete from the first migration.** Libraries, file versions and the change
   log are in the first schema version of the built-in archive, even if their UI comes later.
   Adding them to existing data afterwards would be expensive.
5. **Originals are immutable** and addressed by their SHA-256. Everything else (thumbnails, text,
   index) can be derived again.
6. **Permissions are enforced in one place**, the backend and index queries, never in routes.
7. **Every write is attributable**: user, AI, workflow or system, with before/after.
8. **No lock-in**: import with the same IDs, export in the Paperless-ngx format.

## 7. Milestones

Sizes are relative (S < M < L < XL). Every milestone ships in a normal release and leaves both
modes working.

### M0 – Foundation (both modes) · M

* `DocumentBackend` interface, `PaperlessBackend` (wraps `PaperlessClient`), `ctx.backend()`.
* Capabilities in `SessionInfo`; the leaks are removed (debug route, dashboard, `documentLink`,
  wording in the UI).
* Document event bus (`document.added/updated/deleted/processed`).
* Backend contract test suite, running against the mock Paperless server.
* **Accept:** no behaviour change, all existing tests green, contract suite green.

### M1 – Users and access (both modes) · M

* Instance roles (admin / member), groups, API keys per user with scopes, `AccessContext` threaded
  through all services.
* Only admins can change settings; the legacy global API key keeps working as an admin key.
* Companion mode: explicit "one shared view" with a note in the UI.
* **Accept:** permission matrix tests for every route; existing single-user installations are
  unchanged after the upgrade (the first user becomes admin).

### M2 – Document UI against Paperless-ngx · L

* Pages Documents (list/grid, filters, full text, bulk edit) and Document (viewer, metadata,
  history), metadata management – all through the backend, so they work in companion mode.
* Upload forwarded to ngx.
* Setup wizard: mode choice step (built-in archive shown as "coming soon" or behind a flag).
* **Accept:** e2e tests for list/detail/edit/upload against the mock Paperless server.

### M3 – Built-in archive core (experimental) · XL

* Complete schema ([data-model.md](data-model.md)), blob store, `LocalBackend`.
* Intake: web upload, REST upload, watch folder; text layer extraction; thumbnails.
* Document full text index, metadata management, a single default library, trash.
* Developer importer (CLI) from Paperless-ngx with the same IDs, to test with real archives.
* Setup: built-in archive selectable behind `PAPERLESS_AI_EXPERIMENTAL_ARCHIVE=true`.
* **Accept:** contract suite green for both backends; 200k-document fixture meets the targets in
  [search-and-scale.md](search-and-scale.md#6-targets); crash safety tests (kill during intake).

### M4 – Search and scale (both modes, can run in parallel to M2/M3) · M

* Read connections in worker threads; vector search in a worker with 1-bit prefilter and int8
  rescoring; embeddings stored as int8; separate `index.db`; facet counters.
* **Accept:** Ask retrieval < 300 ms at 1M passages on the reference machine; no event loop
  block > 50 ms from search.

### M5 – Versions and libraries · L

* File versions (upload new version, switch, compare text, retention), change log UI with undo for
  every event.
* Several libraries with members, roles and groups; permission-aware RAG, calendar, statistics.
* **Accept:** permission matrix covers chat/RAG/calendar/feeds; version switch re-indexes the
  document.

### M6 – Workflows and more intake · L

* Workflow engine ([workflows.md](workflows.md)), run log, dry run; prompt rules migrated.
* E-mail (IMAP), WebDAV inbox, PWA share target.
* **Accept:** workflow loop protection tests; migration of existing prompt rules without
  behaviour change.

### M7 – Migration assistant, built-in archive stable · L

* Assistant ngx → built-in (dry run, initial import, incremental sync, cutover), export in
  ngx exporter format, permission mapping options.
* The experimental flag is removed; the setup offers both modes equally.
* **Accept:** migration of a real 3.x archive with history, OCR results, RAG index and calendar
  intact; round trip built-in → ngx exporter format → `document_importer`.

### Later

Searchable archive PDF (text layer from OCR boxes), folder projection (storage path templates),
Office formats via Gotenberg, per-user mapping in companion mode, separator page splitting, notes,
share links.

### Implementation status

All milestones M0–M7 are implemented on this branch (one commit per milestone). Deviations from
the plan, decided while building:

* **No experimental flag:** the setup offers both modes from M3 on; the migration assistant and
  the exports make the built-in archive usable for existing installations (M7).
* **Importer CLI** moved from M3 to M7, together with the migration it serves.
* **Performance (M4):** prefix indexes for 3 *and* 4 characters, ranking of very common terms
  among their newest 5,000 matches, counters maintained by SQLite triggers; measured results in
  [search-and-scale.md §6.1](search-and-scale.md#61-measured-m4).
* **Workflows (M6):** see [workflows.md §12](workflows.md#12-implementation-notes-m6) – prompt
  rules are workflows, webhooks are admin-only, IMAP IDLE and drag and drop are not there yet.
* **Migration (M7):** see [migration.md §7](migration.md#7-implementation-notes-m7) – rollback
  does not write changes back to Paperless-ngx yet; the round trip CI job awaits its first run.
* Still open from the plan, in "Later": folder projection, searchable PDF/A, Office formats,
  per-user mapping in companion mode, notes (exported to `data/migration/notes.json` for now).

## 8. Decision log

| # | Decision | Date |
| --- | --- | --- |
| D1 | The user chooses companion mode or built-in archive in the setup; both stay first-class. | 2026-11-21 |
| D2 | One codebase with a `DocumentBackend` interface; features use capabilities. | 2026-11-21 |
| D3 | Versioning, workflows and archives for several users are part of the built-in archive (not optional extras). | 2026-11-21 |
| D4 | SQLite only, used deliberately (two database files, worker readers, see `search-and-scale.md`). No Postgres. | 2026-11-21 |
| D5 | No runtime mode switch and no hybrid. Switching works through import/export with the same IDs. | 2026-11-21 |
| D6 | The internal document model keeps the Paperless shape (numeric IDs, `modified`). | 2026-11-21 |
| D7 | Companion mode starts with one shared view for all Paperless-AI users; per-user mapping comes later. | 2026-11-21 |

## 9. Open questions

| # | Question | Proposal |
| --- | --- | --- |
| Q1 | Metadata (tags, correspondents, types, custom fields) per library or global? | Per library, plus optional global "shared vocabulary" lists that libraries can opt into. Prevents leaks through tag lists. |
| Q2 | Prompt rules: migrate into workflows or keep both? | Migrate; keep a simplified "Prompt rules" view that edits the matching workflows. |
| Q3 | Folder projection (human-readable folders from metadata) in which milestone? | After M7, as a read-only export view (hardlinks). |
| Q4 | Searchable archive PDF (PDF/A with text layer): needed for v1? | No; the viewer shows the original, search uses the stored text. Later. |
| Q5 | Office formats: optional Gotenberg sidecar? | Yes, later, opt-in. |
| Q6 | Default retention of file versions? | Keep all; per-library limit (N versions / X days) is optional. |
| Q7 | Do workflows ship in companion mode at the same time? | Yes – a good way to test the engine with real users before the built-in archive is stable. |
| Q8 | Product name: does "Paperless-AI" still fit a standalone archive? | Out of scope for this plan; noted. |
| Q9 | Notes / comments on documents? | Later; the change log already covers "who changed what". |

## 10. Glossary

| Term | Meaning |
| --- | --- |
| Companion mode | Paperless-AI next to Paperless-ngx (`archive.mode = paperless`). |
| Built-in archive | Paperless-AI stores the documents itself (`archive.mode = builtin`). |
| Backend | Implementation of `DocumentBackend` (`PaperlessBackend`, `LocalBackend`). |
| Capability | A feature flag that a backend reports (e.g. `fileVersions`). |
| Library | A container of documents with members and roles ("archive" in the UI). |
| Blob | An immutable file in the blob store, named by its SHA-256. |
| Principal | Who performs an action: user, API key (of a user), workflow, system. |
| Change log | `lib_document_events`: every change with actor, before and after. |
