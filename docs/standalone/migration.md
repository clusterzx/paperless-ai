# Migration

← [Overview](README.md)

Three paths: upgrading existing installations (automatic), moving from Paperless-ngx to the
built-in archive (assistant), and exporting from the built-in archive back to Paperless-ngx.

## 1. Upgrading existing installations

Automatic, without any action by the user:

| Step | When | What |
| --- | --- | --- |
| Config | M0 | `archive.mode = 'paperless'` for every config with a Paperless URL; nothing else changes |
| Roles | M1 | all existing users become `admin` (today everyone can do everything); the global API key keeps working as the legacy key |
| `index.db` | M4 | `rag_documents`, `rag_chunks`, `rag_fts` are copied into `index.db` and dropped from the core database; embeddings are converted from float32 to int8 on the way. The UI shows progress, Ask keeps working (keyword search first). |
| Built-in schema | M3 | the `lib_*` tables are created empty |

Before every migration that moves data (M4), the application writes a backup of the database
(`data/backups/pre-<version>.db`). It keeps the last three.

## 2. Paperless-ngx → built-in archive (assistant)

The assistant runs while Paperless-AI stays in companion mode. Paperless-ngx is only **read**.
Nothing changes for users until the cutover.

```
analyse (dry run) ─▶ choose mapping ─▶ initial import ─▶ incremental sync (repeatable) ─▶ cutover
       │                                     │                       │                     │
   report: counts, size,           same document IDs,         changed / new /        pause processing,
   what cannot be moved            same `modified`            deleted documents      final sync, switch mode
```

### 2.1 Analyse (dry run)

* Connection with the configured token. The token needs to see all documents. With a non-superuser
  token, the report says how many documents are visible and that only those will be migrated.
* Report:
  * Documents, pages, tags, correspondents, types, custom fields, storage paths, users, groups,
    notes.
  * Estimated storage: sample of the documents' file sizes through the ngx metadata endpoint,
    extrapolated, compared with the free space of the storage directory.
  * Owners and permissions (input for the library mapping, §4).
  * **Not transferable**, with counts: Paperless-ngx workflows, mail accounts and rules, saved
    views, matching rules of tags / correspondents / types, share links, notes (see §3).
  * Custom field values that do not fit their type (would be imported as text, listed).

### 2.2 Mapping choices

* Libraries from owners and permissions (§4).
* Users: Paperless-ngx users are matched to Paperless-AI users by user name. Missing users can be
  created (disabled, without password, to be activated or linked to SSO).
* Archived PDFs (Paperless-ngx's OCR'd PDF/A next to the original): import as `kind = 'archive'`
  (more storage, the text layer is kept) or skip (default; the text is imported anyway).

### 2.3 Initial import

For each document, oldest first, with a configurable concurrency (default 4):

1. `GET /api/documents/:id/` (metadata and content), download the original
   (`/download/?original=true`) and, if chosen, the archived PDF.
2. Verify the checksum of the original against the one Paperless-ngx reports in the document
   metadata endpoint, store the blob (write protocol).
3. One transaction: `lib_documents` with **the same id**, the same `created`, `added` and **the
   same `modified` string** as in Paperless-ngx. Metadata is mapped by name into the chosen library.
   The text goes into `lib_document_text`. If Paperless-AI holds a better OCR text that was not
   written back (`ocr_results` with `kept_original = 0` and `written_back = 0`), that text is used
   (`source = 'ocr'`). One change log event `created` with `actor_type = 'import'`,
   `ref = 'ngx:<id>'`.
4. Progress in `migration_items`: pause, resume and restart are possible at any time. Errors are
   listed and do not stop the import.

```sql
CREATE TABLE migration_items (
  ngx_id INTEGER PRIMARY KEY,        -- = lib_documents.id
  status TEXT NOT NULL CHECK (status IN ('pending', 'imported', 'failed', 'skipped', 'deleted')),
  imported_modified TEXT,            -- ngx `modified` of the imported state
  checksum TEXT,                     -- checksum of the original as reported by ngx
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
-- kv 'migration.paperless': strategy, mapping, started/finished timestamps, last sync, cutover time
```

**Only into an archive without documents of its own.** Because the ids are kept, the import cannot
run next to documents that were added in the built-in archive itself (an installation that started
with the built-in archive): the start is refused while there are any (`MigrationStatus.ownDocuments`),
and a single document whose id is taken by such a document is never replaced – it fails with a
reason (e.g. a document added after the cutover and a new ngx document in a later sync). Rolling back
is only possible after a cutover by the assistant.

**Why the same id and the same `modified`:** the processing state (`documents`), the AI history,
the OCR results, the calendar and the RAG index reference document ids and compare `modified`.
With both unchanged, everything stays valid. There is no re-analysis, no new OCR and no
re-embedding.

### 2.4 Incremental sync

* Lists all ngx documents with id and `modified` and compares them with `migration_items`:
  * new → import
  * `modified` changed → update metadata and text; a changed checksum → new file version
  * missing → move to the built-in trash
* Can run as often as needed, for example nightly during a trial period. Only the built-in tables
  are written. The built-in archive is not in use yet, so there are no conflicts.

### 2.5 Cutover

1. Pause processing and intake.
2. Final incremental sync.
3. Switch `archive.mode` to `builtin` (config change, the backend is rebuilt without a restart).
4. Resume. The RAG index stays valid. Chunks keep their copied text until they are re-indexed,
   then they switch to offsets.
5. The report recommends keeping Paperless-ngx (read-only) for a while before shutting it down.

### 2.6 Rollback

* **Before the cutover:** "Discard migration" deletes the built-in data (`lib_*`, blobs) after
  confirmation.
* **After the cutover:** switching back to companion mode is possible while Paperless-ngx still
  exists. The assistant lists the changes since the cutover from the change log. As a best effort,
  it can write metadata changes back through the ngx API and upload documents added since then
  through `post_document`.

## 3. Mapping Paperless-ngx → built-in archive

| Paperless-ngx | Built-in archive |
| --- | --- |
| document (id, title, created, added, modified, ASN, original file name, mime type, page count) | `lib_documents`, same values |
| content | `lib_document_text` (version 1, `source = 'import'` or `'ocr'`) |
| original file | blob + `lib_document_files` (version 1, `original`) |
| archived PDF | optional: `lib_document_files` (version 1, `archive`) |
| tags (incl. parent, color, inbox tag) | `lib_tags` per library, by name |
| correspondents, document types | `lib_correspondents`, `lib_document_types` |
| storage paths (name, path template) | `lib_storage_paths` (template kept for the later folder projection) |
| custom fields (all types, select options, default currency) | `lib_custom_fields`; values into typed columns (monetary `EUR12.50` → `value_num` + currency in `value_json`) |
| document link fields | kept (document ids are the same) |
| owner | `owner_id` (mapped user) |
| permissions (view / change for users and groups) | library membership, see §4 |
| users, groups | matched / created, see §2.2 |
| notes | not in the model yet (Q9). Exported to `data/migration/notes.json` and listed in the report. |
| workflows, mail rules, matching rules | not transferred; listed with a summary. Matching rules and workflows can be rebuilt as workflows; the report links the editor. |
| saved views | not transferred in the first version (could map to saved views later) |
| share links, trash | not transferred |
| thumbnails | regenerated |

## 4. Permissions

Paperless-ngx permissions are per object (owner + view/change per user and group). Libraries are
coarser on purpose. The assistant offers three strategies and shows a **"who will see what"** table
before the import:

| Strategy | Result | Good for |
| --- | --- | --- |
| One library | all documents in one library; mapped users become editors (admins owners) | single users, families who share everything |
| Library per owner | one library per owner (owner role), plus a "Shared" library for documents without owner; users with view/change permission on documents of an owner become viewers/editors of that owner's library | households with private archives |
| Rules | conditions (owner, tag, storage path, custom field) → library, evaluated in order | anything else |

* Where a strategy **widens** access compared with Paperless-ngx (example: a user could see 3
  documents of an owner and would now see the owner's whole library), the table marks it. The
  assistant then suggests moving those documents into a separate library.
* Nothing is imported until the admin confirms the table.

## 5. Built-in archive → Paperless-ngx

Two exports, both from Settings → Archive (admins; owners for their libraries):

1. **Paperless-ngx exporter format:** `manifest.json` with the model objects (documents, tags,
   correspondents, types, custom fields and their instances, storage paths, users, groups) plus the
   files, the way `document_exporter` writes them, so that `document_importer` can read it into a
   fresh Paperless-ngx. The format depends on the Paperless-ngx version. The export targets the
   current major version, and a CI job checks the round trip against the official Paperless-ngx
   image ([testing-and-operations.md](testing-and-operations.md#3-ci)).
2. **Plain export:** folders `library/correspondent/year/` with the original files named after
   their titles, plus `metadata.json` and `metadata.csv`. Readable without any software, and a
   guarantee that the data is never locked in.

## 6. Tests

* Importer against the mock Paperless server (`test/helpers/mockPaperless.ts`) with a fixture of
  ~1,000 documents: ids, `modified`, metadata, custom field types, permissions strategies, resume
  after a crash, incremental sync (new / changed / deleted), the processing state and RAG index
  staying valid (no document re-queued).
* `e2e/real-paperless-check.ts` gets a migration check against a real instance (manual / nightly).
* Round trip: built-in → exporter format → `document_importer` (Docker, nightly CI).

## 7. Implementation notes (M7)

Code: `src/server/migration/service.ts` (analysis, plan, import, sync, cutover, rollback, discard),
`src/server/migration/export.ts` (both exports), `src/server/routes/migration.ts`,
`src/server/cli.ts`, `src/web/pages/Migration.tsx` (*Move to built-in archive*, admins in companion
mode), *Settings → Archive → Export*. Tests: `test/integration/migration.test.ts`,
`test/integration/cli.test.ts`; nightly round trip `.github/workflows/roundtrip.yml`.

* The import runs while companion mode is active, with its own passive instance of the built-in
  archive (no intake, no maintenance timers). Names are resolved per library directly in the
  `lib_*` tables, so metadata is never created in Paperless-ngx.
* Checksums: Paperless-ngx reports the MD5 of the original; it is compared with the download
  before the blob is stored. A changed checksum on a sync adds a new file version.
* Paperless-AI administrators become owners of every library the migration creates (otherwise
  they would not see the documents after the switch). Accounts created for Paperless-ngx users are
  disabled and have no password.
* Custom field values that do not fit their type are stored as text and listed by the analysis.
* The cutover pauses the processing queue, runs a final sync, closes the passive instance and
  switches `archive.mode` – without a restart. Documents that never had an analysis (e.g. added in
  Paperless-ngx after the last scan) are analysed afterwards as usual; nothing else is queued again.
* "Switch back" (rollback) changes the mode and reports how many changes were made in the
  built-in archive since the switch; writing them back to Paperless-ngx is not automated yet.
* CLI: `paperless-ai migrate analyse | plan | start | sync | status | cutover | discard` and
  `paperless-ai export --format ngx|plain --out <dir>` (`npm run cli -- …` from a checkout; the
  data directory is `PAPERLESS_AI_DATA_DIR` or `--data`). Stop the server before a cutover from
  the command line – the web assistant does it without a restart.
* The exporter writes the manifest for Paperless-ngx 2.x (`metadata.json` version 2.20.0): users,
  correspondents, types, tags, storage paths, custom fields and their values, documents with MD5
  checksums, originals and archived PDFs. Names that exist in several libraries become one object
  (Paperless-ngx names are global). The round trip into the official image runs as a nightly CI
  job; it could not be run in the environment the feature was built in (no Docker), so its first
  run is the real check.
