# API

← [Documentation](README.md)

The REST API is documented at `/api-docs` (OpenAPI) of your instance.

**Authentication:** a personal API key (*Settings → API keys*, with the permissions it needs) in the header `x-api-key`, as `Authorization: Bearer …`, or – for apps made for Paperless-ngx – as `Authorization: Token …`. WebDAV clients send it as the password of HTTP Basic authentication; Paperless-ngx sends the key of its remote OCR engine to the [OCR API server](ocr.md#ocr-api-server) as `Ocp-Apim-Subscription-Key`. The global key of earlier versions (*Settings → API & webhooks*) keeps working with administrator rights.

**Sign-in for apps:** native apps don't need a key copied by hand. `POST /api/auth/token` with `{ "username", "password", "deviceName": "Pixel 9" }` returns `{ "token": "pai_…", "keyId", "scopes", "user" }` – a personal API key named *App: Pixel 9*, shown only this once. The app keeps it (Keychain / Keystore) and sends it as `Authorization: Bearer …`; the user sees and revokes it under *Settings → API keys*.

- **Two-factor authentication:** send `code` along (code of the authenticator app or a recovery code), or take the answer `{ "twoFactor": true, "ticket": "…" }` and send `{ "ticket", "code", "deviceName" }`.
- **Permissions:** read, write, delete, metadata, upload and chat by default; `"scopes": [...]` asks for fewer. Never administration, MCP, webhooks or the OCR API – an app key of an administrator does not administer either.
- **Sign-out:** `DELETE /api/auth/token` with the key revokes it (any key may do this, whatever its permissions).
- **Display name and role:** `GET /api/session` with the key.
- Refused when signing in with a password is switched off (`403`, `password_login_disabled`) – then create a key under *Settings → API keys*.

**Permissions of a key:** read, change, delete documents, manage labels, upload, ask & chat, MCP, webhook, OCR API, administration – plus libraries, expiry and requests per minute (`429` with `Retry-After` above it). The table is in [AI agents (MCP)](mcp.md#permissions-of-api-keys).

**MCP server:** `/mcp` for AI agents – see [AI agents (MCP)](mcp.md).

**Kept from 3.x:** the endpoints used by the Paperless-AI browser extension and by scripts written for 3.x (`/chat/init/:id`, `/chat/message`, `/api/scan/now`, `/api/webhook/document`, `/api/rag/ask`, …).

**Uploads:** `POST /api/documents/upload` and the Paperless-ngx compatible `POST /api/documents/post_document/` – see [Getting documents in](intake.md).

**Paperless-ngx compatible API:** `/ngx/api/…` (built-in archive) – for the apps and scripts made for Paperless-ngx, see [Mobile apps](mobile-apps.md).

## Sync clients

For clients that mirror the archive (one-way sync, backups) or check before an upload whether a file is already there:

- **Checksums:** `GET /api/documents` and `GET /api/documents/:id` include `original_sha256`, `archive_sha256` (archived PDF of Office documents and e-mails) and `sha256` – the file `GET /api/documents/:id/file` sends. `GET /api/documents/:id/versions` has the `sha256` of every version. Built-in archive only; with Paperless-ngx they are `null`.
- **File:** `GET /api/documents/:id/file` sends `ETag: "<sha256>"` and `Repr-Digest`. With `If-None-Match` an unchanged file is answered with `304 Not Modified` (built-in archive: without reading the file).
- **Changes:** `GET /api/documents?modifiedFrom=2026-11-27T10:00:00Z` – documents whose metadata, text or file changed since then (also a date: `2026-11-27`). `modified` changes with every edit; compare `sha256` to see whether the file changed.
- **Deletions:** `GET /api/documents/ids` returns the ids of all documents the key can read (`{ "ids": [1, 2, …] }`, ascending, with the same filters as the list). A document the client has that is missing there was deleted, or the key can no longer read it.

A sync run: fetch the ids, then the documents changed since the last run (`modifiedFrom`, paged with `cursor`), download those whose `sha256` differs, remove local documents that are no longer in the ids.
