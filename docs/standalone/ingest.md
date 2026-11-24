# Intake: getting documents in

← [Overview](README.md)

## 1. Channels

| Channel | Built-in archive | Companion mode | Milestone |
| --- | --- | --- | --- |
| Web upload (drag & drop, file picker, camera on phones) | native | forwarded to ngx `post_document` | M2 (forward), M3 (native) |
| REST upload `POST /api/documents/upload` | native | forwarded | M2 / M3 |
| Upload endpoint compatible with `post_document` | native | – (ngx has it itself) | M3 |
| Watch folder | native | – (ngx consume folder) | M3 |
| E-mail (IMAP) | native | – (ngx mail rules) | M6 |
| WebDAV inbox | native | – | M6 |
| PWA share target (Android), iOS shortcut | via REST upload | via REST upload | M6 |
| FTP / SMB from scanners | via a sidecar container that writes into the watch folder (documented) | – | M3 (docs) |

Every channel only produces `(file, filename, channel, hints)` and hands it to the `IngestService`.
Channels have no logic of their own beyond fetching files.

## 2. `IngestService`

```ts
interface IngestFile {
  /** Stream or path; streams are written to <storage>/tmp while hashing. */
  source: NodeJS.ReadableStream | { path: string };
  filename: string;
  mimeType?: string;           // sniffed from the content anyway
}

interface IngestHints {
  libraryId?: number;          // default: channel setting, else the user's default library
  title?: string;
  created?: string;            // YYYY-MM-DD
  tags?: string[];             // names, created when missing (editor rights needed)
  correspondent?: string;
  documentType?: string;
  customFields?: Record<string, unknown>;
  /** Add as a new version of this document instead of a new document. */
  replaces?: number;
  /** Skip the AI analysis (OCR and indexing still run). */
  skipAnalysis?: boolean;
  /** Prompt of the prompt library (as the webhook `prompt` today). */
  prompt?: number | string;
  /** Idempotency key of the client (e.g. mail message id + attachment index, API header). */
  channelRef?: string;
}

interface IngestResult {
  status: 'stored' | 'duplicate' | 'rejected';
  documentId?: number;         // for duplicates: the existing document
  intakeId: number;
  reason?: string;
}
```

### Pipeline

```
channel ─▶ lib_intake (pending) ─▶ stream to tmp + SHA-256 + size limit
   ─▶ sniff type (magic bytes) ─▶ allowed? ── no ─▶ rejected (reason)
   ─▶ duplicate? (same SHA-256 already an original in a readable library) ── yes ─▶ duplicate (link)
   ─▶ blob store (write protocol, data-model.md §4)
   ─▶ page count, text layer (PDF), thumbnail of page 1
   ─▶ one transaction: document, file v1, text, tags/fields from hints, lib_fts, counters, event 'created'
   ─▶ commit ─▶ event document.added ─▶ engine.enqueue(id, { source: 'ingest', prompt })
                                          └─ OCR (if the text scores poor/missing) ─▶ AI analysis ─▶ RAG
```

* **Idempotency:** `lib_intake (channel, channel_ref)` is unique. The same mail attachment or the
  same API request with `Idempotency-Key` is stored once.
* **Duplicates:** an identical file (SHA-256) is not stored twice. The result links to the
  existing document. Per library, it can be set to "store anyway" (e.g. the same form filled twice
  is not the same file, but the same blank form uploaded twice is).
* **Errors:** the temp file is deleted, `lib_intake.status = 'failed'` with the reason. The watch
  folder moves the file to `<consumeDir>/.failed/` with a `.error.txt` next to it. The Inbox page
  shows the last intake attempts with their status.
* **Thumbnails and text layer** are created during intake, before the AI analysis. The document
  appears in the list within seconds, and the AI fills in the rest in the background.
* **Hints from the channel win over the AI** for the fields they set (e.g. a tag from the folder
  name). The AI fills in the remaining fields, using the existing processing functions and
  restrictions.

### Which library a file goes to

| Channel | Choice |
| --- | --- |
| Web upload | the "Library" field (only libraries the user can add to) |
| REST `POST /api/documents/upload` | `libraryId=<id>` or `library=<name>` |
| WebDAV | the first folder: `/dav/inbox/<library>/<tag>/file.pdf`. A library the user can only read is refused (403) instead of becoming a tag in another library |
| Watch folder of a library | always that library – with the rights of the folder, not of the administrator who set it up |
| Main watch folder | Settings → Archive → Watch folder → Library; with "Subfolders: first one is the library", `/consume/Family/Taxes/x.pdf` goes to "Family" with the tag "Taxes" |
| E-mail | the account's library, or the library of the matching rule |
| Everything else (sharing from the phone, `post_document`, the WebDAV root, REST without a library) | the **default library** |

The default library is, in this order: one of the libraries of the API key, if the key is limited
to libraries; the user's default library (Settings → Account → Uploads), if they can still add to
it; the oldest library (lowest id) they can add to. Unrestricted callers (the main watch folder
without a library) get the oldest library – never the alphabetically first, so renaming changes
nothing. Library names are unique (case ignored), as they address libraries in paths.

### Failures and retries

* A refusal (type, size, rights, a deleted library) has the status `rejected`; any other error is
  `failed` – sending the file again can work. Uploads answer per file; WebDAV answers 415 or 503,
  `post_document` 400 or 503.
* Every attempt is recorded before its library is chosen, so refused ones are in the Inbox too:
  attempts are shown to members of their library, to their sender, and – when they have no
  library – to administrators.
* "Try again" keeps the hints of the first attempt (tags, title, mail sender and subject,
  "store only"). It is offered to those who can see the attempt and checks the target library
  before the attempt is replaced.
* Attempts still `pending` when the process stopped count as `failed` after the next start (they
  never finish otherwise, and the same channel reference must be storable again).
* `Idempotency-Key` counts per user: two users or apps sending the same key do not get each
  other's result. A refused or failed attempt with the same reference is tried again.

## 3. File types

| Phase | Types | How |
| --- | --- | --- |
| M3 | PDF; JPEG, PNG, TIFF (multi-page), WebP | as the OCR pipeline reads them today (`ocr/render.ts`: PDFium for PDFs, sharp for images) |
| Later | HEIC (phone photos) | depends on what the sharp build decodes, or a conversion step |
| Always (4.6) | text (txt, md, csv, tsv), HTML, e-mails (.eml) | text read directly (`archive/textFormats.ts`) |
| Opt-in (4.6) | Office (docx, xlsx, pptx, odt, ods, odp, doc, xls, ppt, rtf), HTML and e-mails as PDF | LibreOffice as WebAssembly in a child process (`office/service.ts`), downloaded on first use; without it Office files are rejected with a clear reason |

* **Text layer of digital PDFs:** most invoices and letters from portals are digital. Extracting
  their text instead of running OCR is faster and exact. PDFium has a text API. Whether
  `@hyzyla/pdfium` exposes it needs to be checked, the alternative is `pdfjs-dist`. The existing
  text-quality score (`ocr/quality.ts`) then decides whether OCR is needed anyway (e.g. a PDF with
  an embedded scan and no text layer).
* Images are stored as they are (original). The viewer shows images directly. A derived PDF
  (`kind = 'archive'`) is only created later together with the searchable archive PDF.
* In the built-in mode `@hyzyla/pdfium` and `sharp` become required (they are optional
  dependencies today). The Docker image already contains them. A start without them disables the
  built-in archive with a clear message.

## 4. Web upload and REST

* `POST /api/documents/upload` (multipart, `@fastify/multipart`, streaming, limit
  `archive.builtin.maxUploadMb`). Fields: `file` (several allowed), `libraryId`, `title`, `tags`,
  `created`, `correspondent`, `documentType`, `replaces`, `skipAnalysis`, `prompt`. Header
  `Idempotency-Key` (optional). Auth: session or API key with the `upload` scope.
* Response `202` with one `IngestResult` per file. The UI then follows the documents through SSE
  (processing status) and shows them in the list right away.
* **`post_document` compatibility** (M3, built-in only): `POST /api/documents/post_document/` with
  the ngx field names (`document`, `title`, `created`, `correspondent`, `document_type`, `tags`,
  `archive_serial_number`, `custom_fields`). Ids are mapped to the library of the API key, and the
  answer is a task id string as in ngx. This lets scanner apps and shortcuts that can "upload to
  Paperless" upload to Paperless-AI with `Authorization: Token <key>`. Only this endpoint is
  provided, not the rest of the ngx API.
* **Companion mode:** the same `/api/documents/upload` forwards to ngx `post_document` with the
  ngx token. Hints are mapped to ngx ids (tags created through `MetadataCache` when missing). The
  response contains the ngx task id. The document then arrives through the webhook or the next
  scan, exactly as today.

## 5. Watch folder

* `archive.builtin.consumeDir` (Docker: a volume `/consume`). Several folders with their own target
  library are configured in the database (`intake_folders`: path, library, hints, after-action).
* **Polling, not inotify.** inotify does not report changes made through SMB/NFS mounts, which is
  how scanners usually deliver. Every `consumePollSeconds` the folder is listed.
* **Stability check:** a file is taken only when size and mtime did not change over two polls and
  it can be opened exclusively. Scanners write slowly, and half-written PDFs must not be imported.
* Ignored: hidden files, `*.tmp`, `*.part`, `~$*`, `.DS_Store`, `Thumbs.db`, files in `.done/` and
  `.failed/`.
* **Subfolders as hints** (setting per folder): `inbox/<tag>/<tag>/file.pdf` → tags, or
  `inbox/<library>/…` → library.
* After success: delete (default) or move to `.done/<date>/`. `channel_ref` is path + size + mtime,
  so a restart in the middle does not import twice.

```sql
CREATE TABLE intake_folders (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,         -- inside the container, e.g. /consume or /consume/family
  hints TEXT NOT NULL DEFAULT '{}',  -- JSON IngestHints applied to every file
  subfolders TEXT NOT NULL DEFAULT 'ignore' CHECK (subfolders IN ('ignore', 'tags', 'library')),
  after TEXT NOT NULL DEFAULT 'delete' CHECK (after IN ('delete', 'move')),
  act_as INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
```
* The intake of a library's folder acts as `system` with `ref = 'folder:<id>'` and may only add to
  that library (whoever set the folder up – administrators need not be members). "library"
  subfolders are for the main watch folder only.
* **Guards:** a watch folder imports every file and removes it. The data directory, the file
  storage, `tmp/`, the export directories, the program directory and system directories (`/etc`,
  `/usr` …) – and every folder containing one of them – are refused in the settings, for library
  folders and again before every poll (with links resolved), so a wrong path cannot move the
  database away or delete stored originals.
* A folder inside another watch folder belongs to the inner one only; its files are not taken
  twice. Watch folders and mail accounts of a deleted library are removed with the library.

## 6. E-mail (IMAP)

```sql
CREATE TABLE intake_mail_accounts (
  id INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  security TEXT NOT NULL DEFAULT 'tls' CHECK (security IN ('tls', 'starttls', 'none')),
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,        -- AES-256-GCM, key derived from the JWT secret; never sent to the browser
  folders TEXT NOT NULL DEFAULT '["INBOX"]',
  rules TEXT NOT NULL DEFAULT '[]',  -- JSON, evaluated in order
  after TEXT NOT NULL DEFAULT 'seen' CHECK (after IN ('seen', 'move', 'delete')),
  after_folder TEXT,
  state TEXT NOT NULL DEFAULT '{}',  -- JSON: UIDVALIDITY and last UID per folder
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
```

Behaviour:

* Polling with IDLE where the server supports it, otherwise every N minutes. Library: `imapflow`.
  MIME parsing: `mailparser`.
* **Rules** (evaluated in order): sender / recipient / subject contains / folder → library, tags,
  correspondent, `skipAnalysis`, or ignore.
* **What is ingested:** attachments of the allowed types (default), optionally the e-mail itself as
  a document (rule option `storeMail`: never / only without attachments / always – stored as .eml,
  a PDF of it with the Office converter). Inline images below a size threshold (signatures,
  logos) are skipped.
* **After processing:** mark as read, move to a folder, or delete (setting). Idempotency through
  `Message-ID` + attachment index.
* Sender, subject and date go into the hints (`created` falls back to the mail date) and are given
  to the AI as context (external data, like `externalApi` today).
* OAuth2 for Gmail / Microsoft 365 is a later addition (app passwords work for the first version).

**Implemented (M6)** – `archive/mail.ts`, Libraries → E-mail:

* Polling every `archive.builtin.mailPollMinutes` (default 5, Settings → Archive, `PAPERLESS_AI_MAIL_POLL`; a change applies at once) or "Check now"; IDLE is not used yet.
  Per folder the state keeps UIDVALIDITY and the last UID, so only new messages are read. The
  idempotency reference of an attachment is `account:folder:uidvalidity:uid:part` (more robust than
  the Message-ID, which is missing or reused by some senders); a rebuilt folder is read again
  without duplicates.
* Rules: sender / subject contains → tags, "store only" (no analysis), ignore, and another
  library ("into Family") – one mailbox for several libraries. One account per mailbox (server +
  user name): a second account would take the messages away from the first. The mail date as
  fallback document date is not there yet.
* "Only e-mails that arrive from now on": the first check of a folder remembers where it ends and
  reads nothing. Without it, all messages already in the folders are imported – read or not – and
  then marked, moved or deleted. A changed server or user name starts over the same way.
* Sender and subject go into the intake context (workflow conditions `mail_from` / `mail_subject`).
* A message is only marked, moved or deleted when all its attachments were stored (or were
  duplicates). An attachment that failed for a passing reason stops the check before the message:
  it is read again next time, attachments stored already are not stored twice. A refused
  attachment (too large, not accepted) leaves the message untouched – unread, in its folder – and
  the account shows why.
* Pictures that are decoration (logos, icons, avatars, signatures, banners, tracking pixels) are
  not stored. Mail clients do not mark them reliably – Outlook turns embedded pictures into
  "Unnamed attachment 00044.png" attachments – so the size decides (`isMailDecoration`): smaller
  than a readable page (longer side < 700 px or shorter side < 250 px), or part of the HTML text
  (multipart/related) and smaller than a photo or scan (longer side < 1500 px). Phone photos sent
  "inline" are not related and stay.
* Only the processed message is ever changed. "Mark as read" sets `\Seen` and nothing else (messages
  are fetched with `BODY.PEEK`, `CLOSE` is never sent). "Delete" uses `UID EXPUNGE`; a server without
  UIDPLUS would need a plain `EXPUNGE`, which also purges messages another client flagged
  `\Deleted`, so there the message is only flagged `\Seen \Deleted`. "Move" needs MOVE or UIDPLUS,
  otherwise the message is marked as read and the account shows why.
* Accounts are set up by administrators (connections to hosts on the network); owners of the
  library see them, start a check and remove them. Passwords: AES-256-GCM (`util/secretBox.ts`),
  key derived from `security.jwtSecret` – a new instance secret means entering them again.

## 7. WebDAV inbox

For scanners and phone apps that can save to WebDAV:

* Mounted at `/dav/inbox/` (built-in only). Authentication: Basic with user name + an API key that
  has the `upload` scope (no passwords over Basic).
* Write-only inbox: `OPTIONS`, `PROPFIND` (depth 0/1, lists only the inbox root and the user's
  library folders), `MKCOL` (allowed, maps to subfolder hints), `PUT` (→ `IngestService`), `DELETE`
  on not yet processed uploads. `GET` of stored documents is deliberately not offered. The archive is
  not a file share.
* `PUT` is streamed into the blob store's `tmp/`. The intake starts when the request completes,
  and many clients send a `PROPFIND` afterwards, which answers that the file is gone (processed).
* Implemented as a small Fastify plugin (the method set is tiny), so no extra WebDAV server is
  needed.

**Implemented (M6)** – `routes/dav.ts`: works in both modes (in companion mode the files are
forwarded to Paperless-ngx like uploads). `/dav/inbox/<library>/<a>/<b>/file.pdf` stores into that
library with the tags `a` and `b`; an unknown first folder is a tag as well. Empty first `PUT`s
(Windows), AppleDouble / `.DS_Store` / Office lock files, `LOCK`/`UNLOCK` (Finder, Windows) and
renames after the upload are accepted. A file put there in the last ten minutes answers `PROPFIND`,
everything else looks empty. Basic authentication takes an API key as the password; `401` carries
`WWW-Authenticate`. Settings → Archive → "WebDAV inbox" switches it off.

## 8. Mobile

* **PWA:** manifest + service worker (app shell only, no offline documents). The upload page uses
  `<input type="file" accept="application/pdf,image/*" capture>`. Phones offer the camera
  directly.
* **Share target** (Web Share Target API, Android Chrome / installed PWA): "Share → Paperless-AI"
  posts to `/share-target`, which shows the upload form with the file filled in.
* **Implemented (M6):** `manifest.webmanifest` (icons, `share_target` with `file`), a service worker
  that caches nothing (installability), `POST /share-target` → stored like an upload, then the
  inbox shows how many files arrived; without a session it goes to the sign-in page.
* **iOS:** a documented shortcut ("Get file → POST to /api/documents/upload with API key").
* Edge detection and perspective correction stay with scanner apps (Genius Scan, ScanSnap, …).
  They deliver PDFs through the REST upload, the `post_document` endpoint or WebDAV.

## 9. Limits and safety

* Size limit per file (setting), rate limit per API key on the upload routes.
* Type check by magic bytes, not by file name. PDFs are rendered by PDFium (WebAssembly, in the OCR
  worker process for OCR, in a worker thread for thumbnails), so a malformed PDF cannot take down
  the server process.
* Zip / archive files are not unpacked (rejected with a reason).
* File names are only stored as metadata. Paths are never built from them, because blobs are named
  by their hash.
