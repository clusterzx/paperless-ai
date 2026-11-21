# Data model and storage (built-in archive)

← [Overview](README.md)

## 1. Database files

| File | Content | Backup |
| --- | --- | --- |
| `data/paperless-ai.db` (exists) | Users, roles, API keys, libraries, documents, metadata, file versions, document text, change log, document full text index, processing state, history, OCR results, calendar, workflows | nightly online backup (§8) |
| `data/index.db` (new) | RAG: `rag_documents`, `rag_chunks`, `rag_fts`, embeddings | optional, less often – can be rebuilt (costs time / embedding fees) |
| `data/library/` (new, configurable) | Blob store with the files, thumbnails | file-level backup (restic, rsync, …), files never change |

Reasons for two database files:

* The index is the largest part (embeddings: several GB at 200k documents) and changes all the
  time. Keeping it apart keeps the core small to back up, vacuum and check.
* Corruption or a schema reset of the index never touches archive data.
* RAG indexing already happens after the fact (polling, soon events). It needs no transaction
  shared with the core, and SQLite in WAL mode is not atomic across attached files anyway.

The **document full text index** (`lib_fts`) stays in the core database. A document is searchable
in the same transaction it is stored in, and `lib_fts` is rebuilt from `lib_document_text` when
needed.

The companion mode uses the same files. The `lib_*` tables are simply empty there. `index.db` is
introduced for both modes in M4 (the existing `rag_*` tables are moved once on upgrade).

## 2. Identity and `modified`

* `lib_documents.id` is `INTEGER PRIMARY KEY AUTOINCREMENT`. AUTOINCREMENT guarantees that IDs of
  purged documents are **never reused**. `history`, `ocr_results`, `calendar_events`, `documents`
  (processing state) and `rag_*` reference document IDs and must never point to a different
  document.
* The importer inserts explicit IDs (same as in Paperless-ngx). `sqlite_sequence` then continues
  after the highest one.
* `modified` is an ISO 8601 UTC string with milliseconds (`2026-11-21T10:15:02.123Z`). The
  existing code compares it for equality, so every write must change it:
  `modified = max(now, previous + 1 ms)`.
* Writes that change `modified`: metadata, text, current version, library (move), restore.
  Writes that do not: thumbnail regeneration, counters, blob verification.

## 3. Schema

The tables are created by one migration ("builtin archive", appended to `migrations` in
`src/server/db/database.ts`), including libraries, versions and the change log (principle 4).

### 3.1 Users, groups, API keys (both modes, M1)

```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
-- Upgrade: the existing users become admins (today every user can do everything).
UPDATE users SET role = 'admin';

CREATE TABLE groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- groups synchronised from the OIDC groups claim are not edited by hand
  oidc_name TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
) WITHOUT ROWID;

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,              -- first 8 characters, shown in the UI and used for lookup
  hash TEXT NOT NULL,                -- SHA-256 of the full key (256 random bits – no slow hash needed)
  scopes TEXT NOT NULL DEFAULT '["read"]',   -- JSON, see access-control.md
  library_ids TEXT,                  -- JSON array; NULL = all libraries of the user
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX api_keys_prefix ON api_keys(prefix);

-- iCal feed per user (replaces the global kv 'calendar.feedToken'; the existing token becomes the
-- feed of the first admin, so existing subscriptions keep working).
CREATE TABLE calendar_feeds (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,               -- the random token in the feed URL (shown again, like before)
  token_hash TEXT NOT NULL UNIQUE,   -- its SHA-256, for the lookup
  created_at INTEGER NOT NULL
);

-- Saved views of the document list (per user, optionally shared with a library).
CREATE TABLE saved_views (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  library_id INTEGER,                -- set = shared with the members of this library
  name TEXT NOT NULL,
  filter TEXT NOT NULL,              -- JSON DocumentFilter
  columns TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  in_navigation INTEGER NOT NULL DEFAULT 0
);

-- In-app notifications (workflow action notify_inapp, intake failures, migration finished …).
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, read_at, at);
```

### 3.2 Libraries

```sql
CREATE TABLE libraries (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON: version retention, trash retention, default language …
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE library_members (
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (library_id, principal_type, principal_id)
) WITHOUT ROWID;
CREATE INDEX library_members_principal ON library_members(principal_type, principal_id);
```

### 3.3 Documents, files, text

```sql
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,           -- hex; file at blobs/ab/cd/<sha256>
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER                -- last successful checksum verification
) WITHOUT ROWID;

CREATE TABLE lib_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  library_id INTEGER NOT NULL REFERENCES libraries(id),
  title TEXT NOT NULL,
  created TEXT,                      -- document date YYYY-MM-DD
  added TEXT NOT NULL,               -- ISO timestamp of the intake
  modified TEXT NOT NULL,            -- see §2
  correspondent_id INTEGER REFERENCES lib_correspondents(id) ON DELETE SET NULL,
  document_type_id INTEGER REFERENCES lib_document_types(id) ON DELETE SET NULL,
  storage_path_id INTEGER REFERENCES lib_storage_paths(id) ON DELETE SET NULL,
  archive_serial_number INTEGER,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  page_count INTEGER,
  source TEXT NOT NULL,              -- upload | api | folder | mail | webdav | import
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX lib_docs_lib_created ON lib_documents(library_id, created DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_lib_added ON lib_documents(library_id, added DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_created ON lib_documents(created DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX lib_docs_correspondent ON lib_documents(correspondent_id, created DESC);
CREATE INDEX lib_docs_type ON lib_documents(document_type_id, created DESC);
CREATE INDEX lib_docs_modified ON lib_documents(modified);
CREATE UNIQUE INDEX lib_docs_asn ON lib_documents(library_id, archive_serial_number) WHERE archive_serial_number IS NOT NULL;
CREATE INDEX lib_docs_deleted ON lib_documents(deleted_at) WHERE deleted_at IS NOT NULL;

-- File versions. Version 1 = first intake. kind 'archive' = derived PDF (later: searchable PDF).
CREATE TABLE lib_document_files (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'archive')),
  blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  original_filename TEXT,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  page_count INTEGER,
  comment TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (document_id, version, kind)
);
CREATE INDEX lib_files_blob ON lib_document_files(blob_sha256);

-- Text per version. Kept apart from lib_documents so list queries never read large rows.
CREATE TABLE lib_document_text (
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('text_layer', 'ocr', 'manual', 'import')),
  quality INTEGER,                   -- text-quality score (ocr/quality.ts)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, version)
);

-- Full text index of the current text; rowid = lib_documents.id. Contentless like rag_fts.
CREATE VIRTUAL TABLE lib_fts USING fts5(
  title, body, meta,
  content = '', contentless_delete = 1,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '3'
);
```

### 3.4 Metadata

Scope per library (open question Q1 in the README). All names have a normalised twin for
case-insensitive uniqueness. It is computed with `normalizeName()` in code, the same as for
Paperless today.

```sql
CREATE TABLE lib_tags (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  color TEXT,
  parent_id INTEGER REFERENCES lib_tags(id) ON DELETE SET NULL,
  is_inbox INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (library_id, name_norm)
);
-- lib_correspondents, lib_document_types: same columns without color/parent_id/is_inbox.
CREATE TABLE lib_storage_paths (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  template TEXT NOT NULL DEFAULT '',  -- folder projection, e.g. {correspondent}/{created_year}/{title}
  UNIQUE (library_id, name_norm)
);
CREATE TABLE lib_custom_fields (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  data_type TEXT NOT NULL,           -- the CUSTOM_FIELD_TYPES of config/schema.ts + documentlink
  extra TEXT NOT NULL DEFAULT '{}',  -- JSON: currency, select options
  UNIQUE (library_id, name_norm)
);

-- Tags per document. library_id and created are denormalised from lib_documents (kept in sync in the
-- same transaction) so that "tag X, newest first" is a single index range (search-and-scale.md).
CREATE TABLE lib_document_tags (
  tag_id INTEGER NOT NULL REFERENCES lib_tags(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  library_id INTEGER NOT NULL,
  created TEXT,
  PRIMARY KEY (tag_id, document_id)
) WITHOUT ROWID;
CREATE INDEX lib_doc_tags_doc ON lib_document_tags(document_id, tag_id);
CREATE INDEX lib_doc_tags_sorted ON lib_document_tags(tag_id, library_id, created DESC, document_id DESC);

-- Typed values instead of JSON: range filters and sorting use an index.
CREATE TABLE lib_custom_field_values (
  document_id INTEGER NOT NULL REFERENCES lib_documents(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES lib_custom_fields(id) ON DELETE CASCADE,
  value_text TEXT,                   -- string, longtext, url, select option id
  value_num REAL,                    -- integer, float, monetary amount, boolean (0/1)
  value_date TEXT,                   -- YYYY-MM-DD
  value_json TEXT,                   -- documentlink ids, monetary currency
  PRIMARY KEY (document_id, field_id)
) WITHOUT ROWID;
CREATE INDEX lib_cf_num ON lib_custom_field_values(field_id, value_num) WHERE value_num IS NOT NULL;
CREATE INDEX lib_cf_date ON lib_custom_field_values(field_id, value_date) WHERE value_date IS NOT NULL;
CREATE INDEX lib_cf_text ON lib_custom_field_values(field_id, value_text) WHERE value_text IS NOT NULL;
```

### 3.5 Change log, counters, intake log

```sql
-- Every change to a document, in the same transaction as the change.
CREATE TABLE lib_document_events (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL,      -- no FK: events outlive purged documents (audit)
  library_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'version_added', 'version_switched',
                                     'version_deleted', 'moved', 'deleted', 'restored', 'purged')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'workflow', 'system', 'import')),
  actor_id INTEGER,                  -- user id, workflow id
  ref TEXT,                          -- 'history:123', 'run:45', 'apikey:7', 'undo:89'
  changes TEXT NOT NULL DEFAULT '{}',-- JSON { field: [before, after] }, names resolved for display
  reverted_by INTEGER                -- id of the undo event
);
CREATE INDEX lib_events_document ON lib_document_events(document_id, id);
CREATE INDEX lib_events_library_at ON lib_document_events(library_id, at);
CREATE INDEX lib_events_actor ON lib_document_events(actor_type, actor_id, at);

-- Facet counts (documents per tag / correspondent / type / custom field per library).
-- Maintained in the write transactions; rebuilt by a maintenance job.
CREATE TABLE lib_counters (
  library_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- tag | correspondent | document_type | custom_field | documents
  item_id INTEGER NOT NULL,          -- 0 for kind = documents
  count INTEGER NOT NULL,
  PRIMARY KEY (library_id, kind, item_id)
) WITHOUT ROWID;

-- Every intake attempt: idempotency, duplicates, errors (see ingest.md).
CREATE TABLE lib_intake (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,             -- upload | api | folder | mail | webdav | import
  channel_ref TEXT,                  -- file path, message id, client request id
  filename TEXT,
  sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'stored', 'duplicate', 'failed', 'rejected')),
  document_id INTEGER,
  error TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX lib_intake_ref ON lib_intake(channel, channel_ref) WHERE channel_ref IS NOT NULL;
CREATE INDEX lib_intake_created ON lib_intake(created_at);
```

Workflow tables: see [workflows.md](workflows.md#6-storage). Mail accounts and WebDAV settings: see
[ingest.md](ingest.md).

### 3.6 Existing tables in the built-in archive

| Table | Use |
| --- | --- |
| `documents` (processing state) | unchanged, keyed by `lib_documents.id` |
| `history` | unchanged (AI details); change log events reference it via `ref = 'history:<id>'` |
| `ocr_documents`, `ocr_results` | unchanged; `ocr_results.previous_text` stays the undo source for OCR text |
| `calendar_events`, `calendar_scans` | unchanged; access checks join through `lib_documents.library_id` |
| `rag_*` | move to `index.db`; get `library_id` (search-and-scale.md) |

On purge (final delete from the trash), the rows of a document in these tables are removed by the
`trash.ts` purge job. The change log keeps a `purged` event without content.

## 4. Blob store

```
<storageDir>/
  blobs/ab/cd/abcd…ef          originals and derived PDFs, named by SHA-256, read-only (0440)
  thumbs/<docId>-v<version>.webp
  tmp/                         uploads in progress (same file system as blobs/ → atomic rename)
  .paperless-ai-store          marker file with a store id (protects against a wrong mount)
```

**Write protocol** (crash-safe, see the kill tests in [testing-and-operations.md](testing-and-operations.md)):

1. Stream the upload into `tmp/<uuid>` and compute SHA-256 and size on the way (size limit
   enforced while streaming).
2. `fsync` the file.
3. If `blobs/…/<sha256>` exists: delete the temp file (identical content, deduplicated). Otherwise
   `rename` it into place and `fsync` the directory.
4. One database transaction: `blobs` row, `lib_documents`, `lib_document_files`,
   `lib_document_text` (when known), tags, `lib_fts`, `lib_counters`, `lib_document_events`,
   `lib_intake.status = 'stored'`.
5. After the commit: emit `document.added` and enqueue the processing job.

**Garbage collection** (daily):

* Files in `blobs/` without a `blobs` row and older than one hour (crash between 3 and 4) are
  deleted.
* `blobs` rows that no `lib_document_files` row references any more (version deleted, document
  purged) are deleted: file first, then row.
* Files in `tmp/` older than 24 hours are deleted.

**Rules:**

* Files are only read through the API, after the access check. The storage directory is never
  served statically.
* Originals are never modified. Rotating pages, merging and other edits create a new version.
* Thumbnails can be regenerated at any time (PDFium + sharp, as in `ocr/render.ts`).
* Encryption at rest is not part of the plan: use disk or volume encryption.

## 5. Versions

* **Version 1** is the first intake. A new version comes from "Upload new version" in the UI or
  API, from the intake with a hint (`replace: <docId>`), or later from editing actions (rotate,
  remove pages).
* `lib_documents.current_version` points to the version shown, searched and indexed. Switching it
  (also back to an older version) is an event (`version_switched`) and changes `modified`. The engine,
  OCR and RAG then pick the document up again on their own.
* Text is stored per version (`lib_document_text`). The UI compares the text of two versions
  (line diff).
* Whether a new version also re-runs the AI analysis is a library setting (default: OCR and index
  yes, metadata analysis no – the metadata usually stays valid).
* Retention per library (`libraries.settings.versions`): `keepAll` (default) or
  `{ maxVersions, maxAgeDays }`. The current version and version 1 are never removed automatically.
* Only library owners can delete versions by hand. Every deletion is an event.

## 6. Change log and undo

* Every write in `LocalBackend` takes a `ChangeOrigin` and writes exactly one
  `lib_document_events` row in the same transaction. `changes` holds before/after per field with
  names resolved (tag names, not only ids), so the log stays readable after metadata is deleted.
* **Undo** of an event writes the inverse patch as a new event (`ref = 'undo:<id>'`) and sets
  `reverted_by` on the original. If a field was changed again after the event, the undo shows the
  conflict and needs confirmation (no silent overwrite).
* History page (AI changes): in the built-in archive, undo goes through the change log, so an undo
  of an AI change is itself logged.
* Bulk edits write one event per document, with the same `ref = 'bulk:<uuid>'`. A bulk edit can be
  undone as a whole.
* Retention: the change log is kept (it is small, roughly 0.5 KB per event). An optional
  per-library limit exists for very large archives.

## 7. Trash

* Deleting sets `deleted_at` / `deleted_by` and writes a `deleted` event. All list, search and index
  queries filter `deleted_at IS NULL` (partial indexes above).
* Restore clears it (`restored` event, new `modified`).
* Purge after the library's trash retention (default 30 days) or by hand (owners): rows of the
  document in all tables, then blob GC.

## 8. Pragmas, maintenance, backups

Existing (`openDatabase`): `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`,
`busy_timeout = 5000`, `temp_store = MEMORY`. Added:

| Pragma / job | Value | Why |
| --- | --- | --- |
| `cache_size` | `-65536` (64 MiB) per connection | hot pages of list and filter queries |
| `mmap_size` | `268435456` (256 MiB) | fewer read syscalls; safe on local file systems |
| `journal_size_limit` | 64 MiB | WAL file does not stay huge after imports |
| `wal_autocheckpoint` | default; plus `wal_checkpoint(TRUNCATE)` after bulk imports | |
| `auto_vacuum` | `INCREMENTAL` for **new** databases; `PRAGMA incremental_vacuum` in the maintenance job | existing databases need a one-time `VACUUM` to switch – offered in the UI, not forced |
| `PRAGMA optimize` | hourly and on shutdown | keeps query plans good as data grows |
| `PRAGMA quick_check` | weekly, result on the dashboard | early warning |
| Blob verification | recompute SHA-256 of ~1/30 of the blobs per night (`blobs.verified_at`) | bit rot detection over a month |

**Backups:**

* Nightly online backup of `paperless-ai.db` with the better-sqlite3 backup API (`db.backup()`)
  to `data/backups/paperless-ai-<date>.db`, keeping 7 daily and 4 weekly copies (configurable).
* `index.db` weekly or not at all (setting).
* The blob store is not copied by Paperless-AI. Because files are immutable and named by content,
  any file-level backup (restic, borg, rsync, snapshot) is incremental and consistent. The docs show
  a restic example.
* Restore: stop, put back the database copy and the blob store, start. Blobs newer than the
  database copy are orphans and are collected; documents whose blob is missing are reported by the
  verification job.
* Optional: Litestream for continuous replication of `paperless-ai.db` (documented, not bundled).

## 9. Network file systems

SQLite in WAL mode needs shared memory and working POSIX locks on the same host. A data directory
on NFS or SMB is the realistic corruption risk.

* At start and in the setup, the mount of the data directory is looked up in `/proc/mounts`
  (longest prefix). For `nfs`, `nfs4`, `cifs`, `smb3`, `fuse.sshfs` and similar, a warning is shown
  in the setup and on the dashboard.
* The blob store itself may be on a network share (files are written once and renamed). Only the
  database files must be local. `archive.builtin.storageDir` allows exactly this split.

## 10. Sizing (200,000 documents)

Measured with synthetic data (see [search-and-scale.md](search-and-scale.md)): Ø ~5 KB text per
document.

| Part | Size |
| --- | --- |
| `lib_documents` + indexes | ~40 MB |
| Text (`lib_document_text`, current version) | ~1 GB |
| `lib_fts` | ~0.5 GB |
| Change log (10 events per document) | ~1 GB |
| `index.db`: RAG chunks with offsets instead of copied text + `rag_fts` | ~0.6 GB |
| `index.db`: embeddings, ~1M passages, int8 (768 / 1536 dims) | 0.75 / 1.5 GB (float32 today: 3 / 6 GB) |
| Blob store | size of the originals (typical scans: 100 KB – 1 MB per page) |
