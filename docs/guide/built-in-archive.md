# Built-in archive

← [Documentation](README.md)

Paperless-AI can be the archive itself – no Paperless-ngx, Redis or Postgres needed. Choose *Built-in archive* in the setup (or set `PAPERLESS_AI_ARCHIVE=builtin`). Installations that use Paperless-ngx keep running as they are; they can [move over](#moving-from-paperless-ngx) at any time.

What it brings: upload, watch folders, e-mail (IMAP), a WebDAV inbox and sharing from the phone ([Getting documents in](intake.md)); full-text search built for 200,000+ documents; file versions with text comparison; a change log with undo for every change; a trash; libraries with members and roles for families and teams; exports in the Paperless-ngx format or as plain folders.

## Storage

Files are stored content-addressed in `data/library` – or on another disk with `PAPERLESS_AI_STORAGE_DIR`; the database stays in `data/` (keep it on a local disk). *Settings → Archive* shows the storage, runs the maintenance (integrity check, cleanup) and sets the defaults (largest file, days in the trash).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `PAPERLESS_AI_ARCHIVE` | `builtin` or `paperless` |
| `PAPERLESS_AI_STORAGE_DIR` | where the files go (default `data/library`) |
| `PAPERLESS_AI_CONSUME_DIR` | main watch folder (see [watch folders](intake.md#watch-folders)); not inside the data directory or the file storage |
| `PAPERLESS_AI_CONSUME_POLL` | seconds between two looks at the watch folders (default `10`) |
| `PAPERLESS_AI_MAIL_POLL` | minutes between two checks of the e-mail accounts (default `5`) |
| `PAPERLESS_AI_MAX_UPLOAD_MB` | largest file (default `200`) |
| `PAPERLESS_AI_SCANS_DIR` | `docker-compose.yml` of the repository: host folder that appears as `/scans` in the container (default `./scans`) |
| `PAPERLESS_AI_EXPORT_DIR` | another directory exports may be written to (e.g. a mounted volume); default: only below `data/exports` |
| `PAPERLESS_AI_SMTP_HOST`, `_PORT`, `_SECURITY`, `_USER`, `_PASSWORD`, `_FROM` | e-mail for workflow notifications |
| `PAPERLESS_AI_URL` | public address, used in links of e-mails and webhooks |

## Libraries, users and roles

- **Libraries** keep documents apart (e.g. *Family*, *Club*, one per person). Tags, correspondents, document types and custom fields belong to a library. Library names are unique.
- **Roles** per library: *owner* (members and settings of the library; sees its watch folders and mail accounts), *editor* (add and change documents), *viewer* (read). Groups can be members; with single sign-on the groups of your identity provider can be used.
- **Users and groups** are managed by administrators in *Settings → Users & groups*; members are added to a library in *Libraries → library → Members*. Administrators are not automatically members of every library – a private library stays private.
- A library always keeps an owner who can sign in: a user or group that is its only owner cannot be deleted until it has another one.
- **Where uploads go** without a chosen library: the user's *default library* (*Settings → Account → Uploads*), else the oldest library they can add to. An API key can be limited to libraries (*Settings → API keys*) – uploads with it go there.

## Versions, change log, trash

- **Versions:** upload a new file to a document (document page → tab *Versions*); the texts of two versions can be compared, an older one made current again. Per library: keep at most n versions, delete old ones, analyse again on a new version.
- **Change log with undo:** every change (by you, the AI, a workflow) is logged on the document and in *History*, and can be undone.
- **Trash:** deleted documents stay in *Trash* for 30 days by default (per library) and can be restored.

## Moving from Paperless-ngx

Administrators of an installation that uses Paperless-ngx see *Move to built-in archive* in the menu:

1. **Analyse** – what is in Paperless-ngx, how much space it needs, what cannot be taken over.
2. **Plan** – how permissions become libraries and people; a preview shows who will see what.
3. **Import** – documents keep their Paperless-ngx ids, so the AI history, OCR results, calendar and *Ask your archive* stay valid (no new analysis, no new costs). Paperless-ngx is only read. The API token should see all documents (a superuser).
4. **Sync** – changes in Paperless-ngx can be taken over as often as needed.
5. **Switch to the built-in archive** – without a restart. Switching back is possible as long as Paperless-ngx exists.

An installation that already uses the built-in archive gets *Import from Paperless-ngx* instead: documents are imported with new ids and are not analysed again unless chosen. On the command line: `paperless-ai migrate analyse | plan | start | sync | status | cutover | discard`.

## Export

*Settings → Archive → Export* writes everything in the format of the Paperless-ngx exporter (to import into Paperless-ngx) or as plain folders, below `data/exports` or `PAPERLESS_AI_EXPORT_DIR`. On the command line:

```bash
docker compose exec paperless-ai node dist/server/cli.js export --format plain --out /app/data/exports/all
```

Design documents of the built-in archive: [docs/standalone](../standalone/README.md).
