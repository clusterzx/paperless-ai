# UI and API

← [Overview](README.md)

## 1. Principles

* **The same pages in both modes.** Pages talk to the API, the API to the backend. What a mode
  cannot do is hidden through capabilities (`useSession().archive.capabilities`), not through
  separate pages.
* **Wording is neutral.** "Save", "Archive", "Document". Paperless-ngx is named only where it
  really is meant (companion settings, "Open in Paperless-ngx").
* **URL state:** filters, sort, search and selection of the document list live in the URL, so
  views can be shared and bookmarked.
* **Fast first:** thumbnails, keyset paging (infinite scroll with a stable order), optimistic
  updates for metadata edits, live updates through SSE.
* Existing building blocks are reused: `components/ui.tsx`, `DocumentPicker`, the prompt rules
  editor, `chat.tsx`, `Markdown`, the command palette.

## 2. Navigation

```
Dashboard
Documents            list / grid, filters, search, bulk edit            (new, M2)
Inbox                upload, recent intake, duplicates, failures        (new, M2 forward / M3 native)
Ask                  (exists)
Calendar             (exists)
Workflows            (new, M6)
Activity             AI history (exists as History) + change log + runs
OCR · Prompts        (exist)
Trash                (new, built-in)
Settings             + Archive, Libraries, Intake, Users & groups, Notifications, Audit log
```

## 3. New pages

### Documents (`/documents`)

* **Table and grid** (thumbnail cards). Columns are configurable: title, date, correspondent,
  type, tags, custom fields, library, added, pages, AI status.
* **Sidebar filters with counts** (facets from `lib_counters` / ngx counts): library, tags
  (any / all / none), correspondent, type, date range, custom field ranges, AI status (processed,
  failed, not yet).
* **Search field:** full text (FTS in built-in, ngx search in companion) with highlighted snippets.
* **Saved views** per user (and shared per library), shown in the navigation.
* **Bulk bar** on selection: tags add/remove, correspondent, type, custom field, move to library,
  run analysis, run OCR, run workflow, delete. Built-in bulk edits can be undone as a whole.
* Infinite scroll with a keyset cursor. "Select all N matching" works on the filter, not on loaded
  rows.

### Document (`/documents/:id`)

```
┌───────────────────────────────┬──────────────────────────────┐
│ viewer (PDF / image)          │ title, date, correspondent,  │
│  page thumbnails, zoom,       │ type, tags, custom fields,   │
│  rotate (view only)           │ library, ASN, owner          │
│                               │ [Save] [Analyse again] [⋯]   │
│                               ├──────────────────────────────┤
│                               │ tabs: Details · Text ·       │
│                               │ Versions · Activity · Chat · │
│                               │ Dates                        │
└───────────────────────────────┴──────────────────────────────┘
```

* **Viewer:** the browser's PDF viewer in an `iframe` on `/api/documents/:id/file?inline=1`
  (with range requests for large files). Images use `<img>` with zoom. pdf.js (for highlighting
  search hits in the page) comes later.
* **Text:** the stored text of the current version, its source (text layer / OCR / manual), its
  quality score, "Run OCR again". With versions: a diff between two versions.
* **Versions** (built-in): list with date, user, size, pages, comment; upload new version; make
  current; download; delete (owners).
* **Activity:** one timeline from the change log, AI history (tokens, prompt, suggestion), workflow
  runs and OCR runs. Undo per entry where possible.
* **Chat:** the existing document chat (`components/chat.tsx`).
* **Dates:** calendar events of the document (existing data).
* Companion mode: the same page. Versions are hidden, and the activity shows only what went
  through Paperless-AI, plus a link to Paperless-ngx.

### Inbox (`/inbox`)

* Drop zone (several files), library selection, optional tags. Upload progress per file.
* Recent intake attempts (`lib_intake`): channel, file, status (stored / duplicate / failed /
  rejected) with reason, link to the document. Failures can be retried or dismissed.
* Documents that are stored but not yet analysed are shown with their processing stage (SSE).

### Libraries, intake, users (Settings)

* **Libraries:** list, create, rename, members (users and groups with roles), settings (version
  retention, trash retention, re-analysis on new version, duplicate policy).
* **Intake** per library: watch folders, mail accounts with rules, WebDAV on/off. Test buttons
  ("Check mailbox now", "Show what the folder contains").
* **Users & groups** (admin): create, disable, role, groups, OIDC-synchronised groups read-only.
* **API keys** (every user, own keys): create with scopes and libraries, last used, revoke.
* **Audit log** (admin, owners for their library).

### Metadata (`/metadata`)

Tags, correspondents, document types and custom fields per library: rename, color, parent tag,
merge (moves all documents in one bulk change with undo), delete, document counts. Companion mode:
the same through the ngx API (merge = bulk edit + delete).

### Trash (`/trash`)

Deleted documents of the readable libraries with deletion date, user and remaining days. Restore,
purge (owners).

### Workflows (`/workflows`)

See [workflows.md](workflows.md#10-ui).

### Migration assistant (Settings → Archive)

See [migration.md](migration.md).

## 4. Changes to existing pages

| Page | Change |
| --- | --- |
| Setup | new "Archive" step with the mode choice ([architecture.md](architecture.md#6-configuration-and-setup)) |
| Dashboard | "Paperless" card → "Archive" card (mode, document count, storage size in built-in); statistics per scope; intake summary |
| Review | "Save to Paperless" → "Save"; link to the document page |
| History | becomes part of Activity. In built-in, undo goes through the change log. |
| OCR | in built-in, "write back" is implicit and the option is hidden |
| Ask | library filter (chips) when the user can read several libraries |
| Calendar | feed URL per user (`calendar_feeds`) |
| Command palette | document search through the backend; actions "Upload", "New workflow" |
| Settings | sections shown by role (admin) and capabilities; new sections listed above |
| Login / Layout | user menu shows the role; the version footer stays |

## 5. API

Conventions:

* JSON, zod-validated, documented in OpenAPI (`/api-docs`), as today.
* **Lists:** `?limit=50&cursor=<opaque>` (keyset). The existing `page`/`pageSize` stay for the
  pickers. Filters: `library`, `tags`, `tagsAll`, `tagsNone`, `correspondent`, `documentType`,
  `createdFrom`, `createdTo`, `addedFrom`, `cf.<fieldId>.gte|lte|eq`, `q`, `sort`.
* **Errors:** `{ error: code, message }`. `404` for documents outside the scope (not 403).
  `409 not_supported_by_backend` for capability-guarded routes.
* **Auth:** session cookie or API key (`X-API-Key` / `Authorization: Bearer`), with scopes from
  [access-control.md](access-control.md#5-api-keys).

### Endpoints

`R` = read scope / viewer, `W` = write / editor, `O` = library owner, `A` = admin, `U` = upload.
`B` = built-in only (capability-guarded).

| Method | Path | Access | Milestone |
| --- | --- | --- | --- |
| GET | `/api/session` (+ `archive: { mode, label, capabilities }`, user role) | public | M0 |
| GET | `/api/documents` (filters, cursor) – extends the existing route | R | M2 |
| GET | `/api/documents/facets` | R | M2 |
| GET | `/api/documents/:id` (exists, extended) | R | M2 |
| PATCH | `/api/documents/:id` | W | M2 |
| POST | `/api/documents/bulk` (`{ ids \| filter, patch \| action }`) | W | M2 |
| DELETE | `/api/documents/:id` (trash) | W | M2 |
| POST | `/api/documents/:id/restore` | W, B | M3 |
| GET | `/api/documents/:id/file?version=&original=&inline=` | R | M2 |
| GET | `/api/documents/:id/thumb` (exists) | R | – |
| GET | `/api/documents/:id/text?version=` | R | M3 |
| GET | `/api/documents/:id/text/diff?from=&to=` | R, B | M5 |
| GET / POST | `/api/documents/:id/versions` (POST = multipart upload) | R / W, B | M5 |
| POST | `/api/documents/:id/versions/:v/activate` | W, B | M5 |
| DELETE | `/api/documents/:id/versions/:v` | O, B | M5 |
| GET | `/api/documents/:id/activity` | R | M2 (AI history) / M5 (change log) |
| POST | `/api/documents/:id/events/:eventId/undo` | W, B | M5 |
| POST | `/api/documents/upload` (multipart, `Idempotency-Key`) | U | M2 / M3 |
| POST | `/api/documents/post_document/` (ngx-compatible upload) | U, B | M3 |
| GET | `/api/intake?status=&limit=` | R | M3 |
| POST | `/api/intake/:id/retry` | W | M3 |
| GET / POST | `/api/trash`, `/api/trash/purge` | R / O, B | M3 |
| GET POST PATCH DELETE | `/api/tags`, `/api/correspondents`, `/api/document-types`, `/api/custom-fields` | R / W | M2 |
| POST | `/api/tags/merge` (and the other kinds) | W | M2 |
| GET / POST | `/api/libraries` | R / member (setting) | M3 |
| PATCH / DELETE | `/api/libraries/:id` | O | M5 |
| GET / PUT | `/api/libraries/:id/members` | O / A | M5 |
| CRUD | `/api/libraries/:id/intake/folders`, `/api/libraries/:id/intake/mail` | O, B | M3 / M6 |
| CRUD | `/api/users`, `/api/groups` | A | M1 |
| CRUD | `/api/me/api-keys` | session | M1 |
| GET | `/api/audit-log` | A / O | M1 |
| CRUD | `/api/workflows` | O / A | M6 |
| POST | `/api/workflows/:id/dry-run` (`{ documentId }`) | O | M6 |
| POST | `/api/workflows/:id/run` (`{ documentIds \| filter }`) | W | M6 |
| GET | `/api/workflows/:id/runs`, `/api/workflow-runs/:id` | R | M6 |
| POST / GET | `/api/migration/paperless/{analyze,start,sync,cutover,status}` | A | M7 (CLI in M3) |
| POST | `/api/export/paperless` (exporter format, streamed zip or into a folder) | A / O, B | M7 |
| GET | `/api/events` (SSE: `document.*` of readable documents, intake and processing status) | R | M2 |
| WebDAV | `/dav/inbox/…` | U, B | M6 |
| POST | `/share-target` (PWA) | session | M6 |

The webhook `/api/webhook/document` and the legacy routes stay unchanged.

### Shared types (`src/shared/api.ts`)

New: `ArchiveInfo`, `BackendCapabilities`, `DocumentSummary` (list row), `DocumentFilter`,
`DocumentFacets`, `DocumentVersion`, `ChangeEvent`, `ActivityItem`, `IntakeItem`, `Library`,
`LibraryMember`, `ApiKeyInfo`, `AuditEntry`. Workflow types live in `src/shared/workflows.ts`.
`DashboardData.paperless` becomes `DashboardData.archive`. The old field stays one minor version
as an alias, for API clients.
