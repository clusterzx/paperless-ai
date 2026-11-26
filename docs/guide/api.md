# API

← [Documentation](README.md)

The REST API is documented at `/api-docs` (OpenAPI) of your instance.

**Authentication:** a personal API key (*Settings → API keys*, with the permissions it needs) in the header `x-api-key`, as `Authorization: Bearer …`, or – for apps made for Paperless-ngx – as `Authorization: Token …`. WebDAV clients send it as the password of HTTP Basic authentication; Paperless-ngx sends the key of its remote OCR engine to the [OCR API server](ocr.md#ocr-api-server) as `Ocp-Apim-Subscription-Key`. The global key of earlier versions (*Settings → API & webhooks*) keeps working with administrator rights.

**Permissions of a key:** read, change, delete documents, manage labels, upload, ask & chat, MCP, webhook, OCR API, administration – plus libraries, expiry and requests per minute (`429` with `Retry-After` above it). The table is in [AI agents (MCP)](mcp.md#permissions-of-api-keys).

**MCP server:** `/mcp` for AI agents – see [AI agents (MCP)](mcp.md).

**Kept from 3.x:** the endpoints used by the Paperless-AI browser extension and by scripts written for 3.x (`/chat/init/:id`, `/chat/message`, `/api/scan/now`, `/api/webhook/document`, `/api/rag/ask`, …).

**Uploads:** `POST /api/documents/upload` and the Paperless-ngx compatible `POST /api/documents/post_document/` – see [Getting documents in](intake.md).

**Paperless-ngx compatible API:** `/ngx/api/…` (built-in archive) – for the apps and scripts made for Paperless-ngx, see [Mobile apps](mobile-apps.md).
