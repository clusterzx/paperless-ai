# Architecture: one codebase, two backends

← [Overview](README.md)

## 1. Current coupling to Paperless-ngx

Paperless-ngx is reached through exactly two objects, both created in `src/server/context.ts`:

* `ctx.paperless()` → `PaperlessClient` (`src/server/paperless/client.ts`): REST calls.
* `ctx.metadata()` → `PaperlessMetadata` (`src/server/paperless/metadata.ts`): cached snapshot of
  tags, correspondents, document types and custom fields, with case-insensitive get-or-create.

Call sites outside `src/server/paperless/` (state of v4.4.0):

| File | Uses |
| --- | --- |
| `processing/engine.ts` | `listDocuments` (scan, prune), `getDocument`, metadata snapshot / `resolveTags` |
| `processing/applier.ts` | `updateDocument` (apply, undo), metadata resolve/create |
| `processing/analyzer.ts`, `processing/promptRules.ts` | metadata lookups, storage paths, users |
| `ocr/service.ts` | `download` (original / archived PDF), `updateDocument({ content })`, `listDocuments` (assessment) |
| `rag/service.ts` | `listDocuments` + metadata snapshot (index sync) |
| `rag/documentChat.ts`, `rag/facts.ts` | `getDocument`, `listDocuments`, metadata |
| `calendar/scanner.ts` | `listDocuments`, `getDocument` |
| `routes/documents.ts` | `searchDocuments`, `getDocument`, `thumbnail` |
| `routes/processing.ts` | dashboard: `connect()`, `count('/documents/')`; metadata counts |
| `routes/promptRules.ts` | `getDocument` (rule test) |
| `routes/settings.ts`, `routes/system.ts` | connection test; **debug route with raw `req()`** |
| `context.ts` | client construction, `documentLink()` → Paperless UI URL |

The methods actually used form a small, closed set. Change detection everywhere relies on the
document's `modified` timestamp: `needsProcessing` in the engine, `source_modified` /
`written_modified` in OCR, and the diff in the RAG sync.

### Leaks to remove in M0

| Leak | Fix |
| --- | --- |
| `routes/system.ts` – `/api/debug/paperless/:resource` calls `client.req()` | Only registered when `backend.kind === 'paperless'`; built-in gets its own `/api/debug/archive`. |
| `routes/processing.ts` – dashboard uses `connect()` and `count('/documents/')` | `backend.info()` and `backend.countDocuments()`; `DashboardData.paperless` → `DashboardData.archive`. |
| `context.ts` – `documentLink()` builds a Paperless URL | `backend.documentLink(id)`: Paperless UI URL or `/documents/:id`. |
| `paperlessConfigured()` / `isConfigured()` | `archiveConfigured()` delegates to the backend factory. |
| Setup step `paperless` (`src/web/pages/Setup.tsx`) | New step "Archive" with the mode choice, see §6. |
| UI wording "Save to Paperless", "Scanning Paperless…", "What the AI changed in Paperless" | Neutral wording or wording from `backend.label`. |
| `shared/api.ts`: `CalendarEvent.url` "Link to the document in Paperless", OCR texts `inPaperless` | Renamed to neutral names; old names kept as deprecated aliases for the API. |

## 2. The `DocumentBackend` interface

New module `src/server/backend/`:

```ts
// src/server/backend/types.ts
export type BackendKind = 'paperless' | 'builtin';

/** The internal document model. Same shape as the Paperless-ngx API object (see principle 3). */
export type ArchiveDocument = PaperlessDocument & {
  /** Built-in archive only. */
  library_id?: number;
  current_version?: number;
};

export interface DocumentBackend {
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;

  // -- status
  info(): Promise<BackendInfo>;                        // version, user, permissions, document count
  test(): Promise<ConnectionTestResult>;

  // -- documents
  listDocuments(scope: AccessScope, q: DocumentListQuery): Promise<ArchiveDocument[]>;
  searchDocuments(scope: AccessScope, q: DocumentSearchQuery): Promise<DocumentPage>;
  countDocuments(scope: AccessScope, q?: DocumentFilter): Promise<number>;
  getDocument(scope: AccessScope, id: number): Promise<ArchiveDocument>;
  updateDocument(scope: AccessScope, id: number, patch: DocumentPatch, origin: ChangeOrigin): Promise<ArchiveDocument>;
  deleteDocument(scope: AccessScope, id: number, origin: ChangeOrigin): Promise<void>;   // to trash
  download(scope: AccessScope, id: number, opts: { original: boolean; version?: number; signal?: AbortSignal }): Promise<FileData>;
  thumbnail(scope: AccessScope, id: number): Promise<FileData>;
  documentLink(id: number): string;

  // -- intake (built-in: native; paperless: forwards to post_document)
  ingest(scope: AccessScope, file: IngestFile, hints: IngestHints): Promise<IngestResult>;

  // -- metadata
  tags(scope: AccessScope): Promise<Tag[]>;
  correspondents(scope: AccessScope): Promise<Correspondent[]>;
  documentTypes(scope: AccessScope): Promise<DocumentType[]>;
  customFields(scope: AccessScope): Promise<CustomField[]>;
  storagePaths(scope: AccessScope): Promise<StoragePath[]>;
  users(scope: AccessScope): Promise<ArchiveUser[]>;
  createTag(scope: AccessScope, name: string, extra?: Partial<Tag>): Promise<Tag>;
  createCorrespondent(scope: AccessScope, name: string): Promise<Correspondent>;
  createDocumentType(scope: AccessScope, name: string): Promise<DocumentType>;
  createCustomField(scope: AccessScope, name: string, type: CustomFieldType, currency?: string): Promise<CustomField>;
  updateMetadata(scope: AccessScope, kind: MetadataKind, id: number, patch: object): Promise<void>;
  deleteMetadata(scope: AccessScope, kind: MetadataKind, id: number): Promise<void>;

  // -- optional (guarded by capabilities)
  versions?: VersionApi;           // capabilities.fileVersions
  libraries?: LibraryApi;          // capabilities.libraries
  changeLog?: ChangeLogApi;        // capabilities.fullChangeLog
}
```

Notes:

* `AccessScope` comes from the `AccessContext` of the request or of the system principal (see
  [access-control.md](access-control.md)). The Paperless backend ignores it in v1 (one shared view).
* Callers do not pass the scope to every call: `ctx.backend(scope)` returns a `BackendView`
  (`backend/view.ts`) bound to one scope, `ctx.backend()` one bound to the system scope. The binding
  is still explicit – there is no implicit "current user".
* `ChangeOrigin` = `{ actor: 'user' | 'ai' | 'workflow' | 'system', actorId, reason?, runId? }`.
  The built-in backend writes it into the change log. The Paperless backend passes it to the
  Paperless-AI history only (as today).
* `DocumentPatch` gets `owner`, `library_id` (built-in), `storage_path` and `archive_serial_number`
  in addition to the current fields.
* The types `Tag`, `Correspondent`, … are the current `Paperless*` types, renamed. The old names stay
  as type aliases so the diff of M0 is mostly mechanical.
* `PaperlessMetadata` becomes `MetadataCache` and takes a `DocumentBackend` instead of a
  `PaperlessClient`. The resolve and dedupe logic does not change. The 403 handling ("unreadable
  kinds") stays a Paperless backend concern, reported through `info().permissions`.

### Implementations

| | `PaperlessBackend` | `LocalBackend` |
| --- | --- | --- |
| Location | `src/server/backend/paperless.ts` (wraps the existing `PaperlessClient`, unchanged) | `src/server/archive/` (see §7) |
| Storage | Paperless-ngx REST API v7–v10 | `paperless-ai.db` + blob store |
| `ingest` | `POST /api/documents/post_document/`, returns the task id; the document arrives later via webhook/scan | Native pipeline ([ingest.md](ingest.md)) |
| `updateDocument` | `PATCH /api/documents/:id/` | Transaction: update + change log + counters + `modified` |
| `documentLink` | `{publicUrl}/documents/:id/details` | `/documents/:id` |

## 3. Capabilities

```ts
export interface BackendCapabilities {
  /** 'native' = own intake pipeline, 'forward' = handed to Paperless-ngx. */
  upload: 'native' | 'forward';
  intakeChannels: ('folder' | 'mail' | 'webdav')[];   // built-in only
  fileVersions: boolean;
  libraries: boolean;
  /** Every change is logged, not only those made through Paperless-AI. */
  fullChangeLog: boolean;
  trash: 'native' | 'external';
  /** Opening a document in another application (Paperless-ngx UI). */
  externalLink: boolean;
  /** Metadata management (create/rename/delete tags etc.) in the Paperless-AI UI. */
  manageMetadata: boolean;
}
```

* `SessionInfo` (`src/shared/api.ts`) gets `archive: { mode, label, capabilities }` next to
  `features`.
* The web UI reads them through `useSession()` and hides or shows navigation entries, buttons and
  settings sections.
* Routes guarded by a capability answer `409 { error: 'not_supported_by_backend' }` when it is
  missing, so API clients get a clear answer.

## 4. Context changes

```ts
class AppContext {
  backend(): DocumentBackend;        // replaces paperless(); rebuilt on config change
  metadata(): MetadataCache;         // now on top of the backend
  archiveConfigured(): boolean;      // replaces paperlessConfigured()
  isConfigured(): boolean;           // setupCompleted && archiveConfigured() && AI configured
  readonly events: DocumentEvents;   // §5
  readonly db: Db;                   // core database
  readonly indexDb: Db;              // index database (search-and-scale.md §4)
}
```

* `ctx.paperless()` stays available during the transition as a deprecated method that throws in
  built-in mode. M0 replaces all call sites; the method is removed at the end of M0.
* The backend is cached under a key of the relevant config (as `paperlessCache` today), so saving
  settings still rebuilds without a restart.
* `LocalBackend` is created once per process; it owns the blob store, the intake watchers and the
  writer queue.

## 5. Document event bus

Workflows, the change log, the RAG index and the calendar need to react to document changes. Today
the RAG sync polls every 15 minutes. A typed in-process event bus:

```ts
type DocumentEvent =
  | { type: 'document.added'; id: number; source: IngestSource; libraryId?: number }
  | { type: 'document.updated'; id: number; fields: string[]; origin: ChangeOrigin }
  | { type: 'document.version_added'; id: number; version: number }
  | { type: 'document.deleted'; id: number; origin: ChangeOrigin }
  | { type: 'document.restored'; id: number }
  | { type: 'document.processed'; id: number; historyId: number };
```

* **Built-in:** emitted by `LocalBackend` after the transaction commits (never inside it).
* **Companion:** `document.added` from the webhook and from new IDs found by the scan;
  `document.updated` when the scan sees a changed `modified`; `document.processed` from the engine.
  Changes made directly in Paperless-ngx are therefore seen with the delay of the scan interval.
* Subscribers: RAG service (re-index the one document instead of waiting for the periodic sync),
  workflow engine, calendar (remove events of deleted documents), SSE stream to the UI (live list
  updates).
* Events are not persisted. Durable work (workflow runs, processing jobs) is written to its own
  tables by the subscriber.

## 6. Configuration and setup

New config section (`src/server/config/schema.ts`):

```ts
archive: z.object({
  /** 'paperless' = companion mode, 'builtin' = built-in archive. Set by the setup, changed by the migration assistant. */
  mode: z.enum(['paperless', 'builtin']).default('paperless'),
  builtin: z.object({
    /** Blob store; default <dataDir>/library */
    storageDir: str(),
    /** Watch folder; empty = off. */
    consumeDir: str(),
    consumePollSeconds: z.coerce.number().int().min(2).max(3600).default(10),
    /** After intake: delete the file from the watch folder or move it to <consumeDir>/.done */
    consumeAfter: z.enum(['delete', 'move']).default('delete'),
    maxUploadMb: z.coerce.number().int().min(1).max(2048).default(200),
  }).prefault({}),
}).prefault({}),
```

* The existing `paperless` section stays as it is (companion settings).
* Environment variables: `PAPERLESS_AI_ARCHIVE`, `PAPERLESS_AI_STORAGE_DIR`,
  `PAPERLESS_AI_CONSUME_DIR` (mapped in `config/legacy.ts`/`store.ts` like the others).
* **Upgrade:** a stored config without `archive` but with `paperless.url` gets `mode: 'paperless'`.
  This is the same mechanism that derives `setupCompleted` today (`config/store.ts`).
* **E-mail accounts, WebDAV and workflows** live in the database, not in `config.json`. They are per
  library and there can be many.

### Setup wizard

```
account ─▶ archive ─┬─ "With Paperless-ngx"  ─▶ URL + token (today's step) ─┐
                    └─ "Built-in archive"     ─▶ storage + intake options ──┤
                                                                             ▼
                                                        ai ─▶ processing ─▶ finish
```

* The archive step shows two cards with a short explanation and the feature matrix in brief.
* Built-in: storage directory (default shown, warning if it is on a network file system, see
  [data-model.md](data-model.md#9-network-file-systems)), optional watch folder, first library
  name (default "Archive").
* Built-in defaults for processing: OCR enabled with mode `poor`, write-back on (the text is ours),
  automatic processing on.

## 7. Code layout

```
src/server/
  backend/
    types.ts            DocumentBackend, capabilities, document model, ChangeOrigin
    factory.ts          builds the backend from the config
    paperless.ts        PaperlessBackend (wraps paperless/client.ts)
    contract.ts         shared helpers for the contract test suite
  archive/              built-in archive (LocalBackend)
    backend.ts          LocalBackend: implements DocumentBackend
    schema.ts           migrations of the lib_* tables (registered in db/database.ts)
    repo/               documents, metadata, versions, events, libraries, counters (SQL)
    blobs.ts            blob store: write protocol, read, verify, garbage collection
    text.ts             text layer extraction (PDF), text per version
    thumbs.ts           thumbnails (PDFium + sharp)
    trash.ts            soft delete, restore, purge
    export.ts           Paperless-ngx exporter format
  ingest/
    service.ts          IngestService (shared by all channels)
    folder.ts           watch folder
    mail.ts             IMAP
    webdav.ts           WebDAV inbox
  workflows/
    engine.ts, triggers.ts, conditions.ts, actions.ts, runs.ts
  access/
    context.ts          AccessContext, scopes, system principal
    roles.ts            roles and permissions
  events.ts             document event bus
  db/readers.ts         read connections in worker threads (search-and-scale.md §5)
  migration/
    fromPaperless.ts    importer (CLI in M3, assistant in M7)
```

* `paperless/` stays as it is, as the HTTP client.
* `processing/`, `ocr/`, `rag/`, `calendar/` change only at their call sites (`ctx.backend()` and an
  `AccessScope`).

## 8. Processing in the built-in archive

The engine needs almost no changes:

* **Scan:** `LocalBackend.listDocuments` with the same filters (tags any/none). In built-in mode the
  scan mostly finds nothing, because intake enqueues directly; it stays as a safety net (e.g. after
  a crash between intake and enqueue).
* **Enqueue:** `IngestService` calls `engine.enqueue(id, { source: 'ingest' })`. `'ingest'` is a new
  `EnqueueOptions.source`.
* **OCR:** `OcrService.documentFile` reads through `backend.download`. In built-in mode the text
  layer of digital PDFs is extracted during intake, so the quality score decides whether OCR is
  needed at all. `ocr.writeBack` is forced on (the text belongs to the archive). The previous text
  stays in `ocr_results.previous_text` for undo, as today.
* **Searchable PDF** (`ocr.searchablePdf`): the worker reports where each line was read (corners
  in fractions of the page as shown, in reading order – `textLayer.ts`); `searchablePdf.ts` lays the
  text over the pages as invisible text (render mode 3, a glyphless TrueType font built in
  `glyphlessFont.ts`, Type0/Identity-H with a ToUnicode map) with pdf-lib. Built-in: stored as the
  `archive` file of the current version (`LocalBackend.setArchivePdf`). Paperless-ngx: uploaded with
  `POST /api/documents/{id}/update_version/`, labelled `OCR text layer (Paperless-AI)`; a version
  with that label is never read by the OCR again. `ocr_results.pdf` / `pdf_ref` keep where it went
  (SHA-256 of the archive file / Paperless task) so a revert can take it away.
* **Remote OCR for Paperless-ngx** (`ocr.remoteEndpoint`): `routes/remoteOcr.ts` speaks the part of
  the Azure AI Document Intelligence REST API (2024-11-30, model `prebuilt-read`) that Paperless-ngx
  uses with `PAPERLESS_REMOTE_OCR_ENGINE=azureai`: `POST …/prebuilt-read:analyze` (base64 file) →
  `202` with `Operation-Location`, `GET …/analyzeResults/{id}` (status, text), `GET …/pdf`.
  `ocr/remote.ts` reads the files one after the other with `OcrService.readFile` and keeps results in
  memory until fetched (an hour at most). Auth: API key with the `ocr` scope, sent as
  `Ocp-Apim-Subscription-Key`. Texts read this way are remembered by hash (`ocr_remote_reads`) so the
  document is not read again when it arrives through the webhook.
* **Applier:** `updateDocument(..., origin: { actor: 'ai', … })`. The `history` table stays for the
  AI-specific data (tokens, prompt, suggestion). The change log entry of the built-in backend
  references the history id.
* **Trigger tags / processed tag:** keep working the same way (they are tags).
