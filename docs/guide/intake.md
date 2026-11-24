# Getting documents in (built-in archive)

← [Documentation](README.md)

With Paperless-ngx as the archive, documents arrive through Paperless-ngx (its consume folder, mail rules, apps); uploads in Paperless-AI are handed to it. The channels below are those of the [built-in archive](built-in-archive.md).

Every file goes through the same intake: type check (PDF, images, text, HTML, e-mails and – with the [Office converter](built-in-archive.md#office-documents) – Office documents; see [File formats](built-in-archive.md#file-formats)), duplicate check (an identical file is stored once per library), text layer and thumbnail, then OCR when needed and the AI analysis. **Inbox → Recent intake** lists every attempt with its channel (`upload`, `api`, `webdav`, `folder`, `mail`, `share`) and status: `stored`, `duplicate`, `rejected` (type, size, rights – with the reason) or `failed` (a passing error, with **Retry**).

## Which library a file goes to

| Channel | Choice |
| --- | --- |
| Web upload | the *Library* field |
| REST | `libraryId=<id>` or `library=<name>` |
| WebDAV | the first folder: `/dav/inbox/<library>/…` |
| Watch folder of a library | that library |
| Main watch folder | its *Library* setting, or the first subfolder |
| E-mail | the account's library, or the library of the matching rule |
| Sharing from the phone, `post_document`, WebDAV root, REST without a library | the **default library** |

The default library: one of the libraries of the API key, if the key is limited to libraries; else the user's choice in *Settings → Account → Uploads*; else the oldest library they can add to.

## API key

Most channels authenticate with a personal API key: *Settings → API keys → New key*, permission **Upload documents**. Optionally tick libraries – the key then only sees those, and uploads without a library go there (e.g. one key per scanner or phone). The key is shown once.

## Web upload

*Inbox*: drag files into the drop zone or choose them; on phones the camera is offered. Choose the library, tags for the uploads, or *Do not analyse with the AI*.

## REST

```bash
curl -H "x-api-key: $KEY" -F file=@scan.pdf -F library=Family -F tags=Taxes,2024 \
  https://paperless-ai.example.com/api/documents/upload
```

Fields: `file` (several allowed), `libraryId` or `library`, `title`, `created` (YYYY-MM-DD), `tags` (comma-separated), `correspondent`, `documentType`, `skipAnalysis=true`, `prompt`. The answer lists each file with its status and document id. An `Idempotency-Key` header stores a request once (per user).

## Paperless-ngx compatible upload

Scanner apps and shortcuts that “upload to Paperless-ngx” can upload here:

```bash
curl -H "Authorization: Token $KEY" -F document=@scan.pdf -F title="Letter" \
  https://paperless-ai.example.com/api/documents/post_document/
```

The answer is the task id as in Paperless-ngx (a UUID string). The library is the default library of the key. Apps that need the whole Paperless-ngx API (tag lists, document views) connect to `https://paperless-ai.example.com/ngx` – see [Mobile apps](mobile-apps.md).

## WebDAV

Address `https://paperless-ai.example.com/dav/inbox/`, any user name, an API key with the upload permission as the password. *Settings → Archive → WebDAV inbox* switches it off.

- `/dav/inbox/<library>/<tag>/<tag>/file.pdf` stores into that library with those tags; an unknown first folder is a tag as well. A library you can only read is refused (403).
- The inbox looks empty: files stay visible for ten minutes after the upload, documents are never listed or downloaded.
- **Windows:** *Map network drive* → the address → *Connect using different credentials*. Windows sends the password over HTTPS only and allows files up to 50 MB by default.
- **macOS:** Finder → *Go → Connect to Server* (⌘K) → the address.
- **iPhone:** the Files app has no WebDAV – use an app with WebDAV support or the [shortcut](#ios-shortcut).

## Watch folders

Files put into a watch folder – by a scanner, an SMB/FTP share or by hand – are stored once they stopped changing (two looks, every 10 seconds by default), then deleted or moved to `.done/<date>/`. Refused files go to `.failed/` with a `.error.txt` next to them. Hidden files, `*.tmp`, `*.part` and `~$…` are ignored.

- **Main folder:** *Settings → Archive → Watch folder* (or `PAPERLESS_AI_CONSUME_DIR`), with its *Library* and what *Subfolders* mean: tags (`Taxes/scan.pdf` → tag “Taxes”), the library (`Family/Taxes/scan.pdf` → library “Family”, tag “Taxes”) or nothing.
- **Folders of a library:** *Libraries → library → Watch folders* (administrators add them – they are paths on the server). They store into their library only; a folder inside another watch folder belongs to the inner one.
- **Guard:** the data directory, the file storage, the program and system directories – and folders containing them – are refused: a watch folder imports and removes every file in it.
- **Problems** (folder missing, files that cannot be read, a folder that is not writable) are shown in red with the folder.

### Docker

The folder must be mounted into the container. The `docker-compose.yml` of the repository mounts `PAPERLESS_AI_SCANS_DIR` (default `./scans`) as `/scans`:

```yaml
    volumes:
      - paperless-ai_data:/app/data
      - /srv/scans:/scans
```

Watch folders then point at `/scans` or below (`/scans/family`). One mount can hold many folders (one per library). Paperless-AI runs without the right to override file permissions (`cap_drop: ALL`): files need to be readable and the folder writable for it – files of another user (SFTP, SMB) are fine as long as they are readable; if not, `chmod -R a+rwX /srv/scans`.

**Coolify** (and similar tools that deploy the compose file from the repository) fill in the default of `PAPERLESS_AI_SCANS_DIR` themselves: the folder is `/data/coolify/applications/<app id>/scans`. Use it, or replace it with a link to your folder and restart the container:

```bash
cd /data/coolify/applications/<app id> && rmdir scans && ln -s /srv/scans scans
```

## E-mail (IMAP)

*Libraries → library → E-mail* (administrators set accounts up): server, port, security, user name and password (stored encrypted), *Test connection*, then the folders (e.g. `INBOX`).

- **What is stored:** attachments that are documents – PDFs, images, text files, attached e-mails and, with the [Office converter](built-in-archive.md#office-documents), Office documents (without it they are left out). Logos, icons and pictures embedded in the text are left out (decided by their size); photos sent from a phone stay.
- **The e-mail itself:** a rule can also store the message as a document (`.eml`, title = subject, date = the day it was sent): *the attachments – or the e-mail when it has none* (e.g. bank statements sent as text) or *the attachments and the e-mail itself*. With the Office converter the e-mail is kept as a PDF as well.
- **Afterwards:** *Mark as read*, *Move to a folder* or *Delete*. Only the processed message is ever changed, and only when all its attachments were stored: an attachment that failed is tried again with the next check; a refused one (too large) leaves the message untouched and the account shows why. On servers without UIDPLUS a deletion only flags the message, a move falls back to marking it read.
- **Only e-mails that arrive from now on:** the first check skips the messages already in the folders. Without it, all of them are imported – read or not – and then marked, moved or deleted. Use *Mark as read* while trying it out.
- **Rules** (the first match applies; empty sender and subject match every message): sender / subject contains → tags, *store only* (no analysis), *ignore*, **into another library** – one mailbox for several libraries – and whether the e-mail itself is stored. One account per mailbox.
- Checked every 5 minutes (*Settings → Archive*, `PAPERLESS_AI_MAIL_POLL`) or with *Check now*.

## Phone

- **Android:** open Paperless-AI in Chrome, sign in, menu → *Install app* (needs HTTPS). Share a PDF or photo → *Paperless-AI*: it goes to your default library.
- **Any phone:** *Inbox* offers the camera; on the iPhone add the page to the home screen (Safari → Share → *Add to Home Screen*).

### iOS shortcut

1. *Shortcuts* → **+**; in the details (ⓘ) turn on *Show in Share Sheet* (input: files, PDFs, images).
2. Action **Get Contents of URL**: URL `https://paperless-ai.example.com/api/documents/upload`, method **POST**, header `x-api-key` = your key, request body **Form** with a field of type **File**, key `file`, value *Shortcut Input*. Optionally a text field `library` with the name of a library.
3. Share a PDF → your shortcut. The key is stored in the shortcut in plain text – give it the upload permission only.
