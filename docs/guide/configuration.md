# Configuration

← [Documentation](README.md)

Everything can be configured in the web interface. Settings are stored in `data/config.json`.
Environment variables **override** stored settings (the UI shows them as locked) – handy for Docker deployments. The variable names of 3.x are still supported.

| Variable | Setting |
| --- | --- |
| `PAPERLESS_AI_PORT` | HTTP port (default `3000`) |
| `PAPERLESS_AI_HOST` | address the server listens on (default `0.0.0.0`, all interfaces) |
| `TZ` | time zone, e.g. `Europe/Berlin` – the times of `SCAN_INTERVAL`, dates without a time zone and the log (default UTC) |
| `PAPERLESS_AI_DATA_DIR` | data directory (default `./data`, `/app/data` in Docker) |
| `PAPERLESS_AI_RESET_2FA` | username – switches off two-factor authentication of that account at the next start (phone lost and no recovery codes left); remove it afterwards |
| `PAPERLESS_API_URL` (or `PAPERLESS_URL`), `PAPERLESS_API_TOKEN` | Paperless-ngx URL (with or without `/api`) and token – `PAPERLESS_API_URL` wins when both are set |
| `PAPERLESS_PUBLIC_URL` | URL for links opened in the browser (optional) |
| `AI_PROVIDER` | `openai`, `anthropic`, `ollama`, `custom`, `azure` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | Anthropic (Claude); the base URL only for a gateway/proxy |
| `OLLAMA_API_URL`, `OLLAMA_MODEL`, `OLLAMA_KEEP_ALIVE` | Ollama |
| `OLLAMA_NUM_CTX` (or `OLLAMA_CONTEXT_SIZE`), `OLLAMA_THINK`, `OLLAMA_UNLOAD_WHEN_IDLE` | Ollama context size (`0` = per document), thinking (`auto`, `off`, `on`, `low`, `medium`, `high`), unload when the queue is empty |
| `CUSTOM_BASE_URL`, `CUSTOM_API_KEY`, `CUSTOM_MODEL`, `CUSTOM_EXTRA_BODY` | OpenAI-compatible provider; extra request parameters as JSON |
| `AZURE_ENDPOINT`, `AZURE_API_KEY`, `AZURE_DEPLOYMENT_NAME`, `AZURE_API_VERSION` | Azure OpenAI |
| `TOKEN_LIMIT`, `RESPONSE_TOKENS`, `AI_TEMPERATURE`, `AI_TIMEOUT_SECONDS` | model limits |
| `SCAN_INTERVAL`, `DISABLE_AUTOMATIC_PROCESSING`, `PROCESSING_CONCURRENCY` | scheduling |
| `PROCESS_PREDEFINED_DOCUMENTS`, `TAGS`, `REMOVE_TRIGGER_TAGS` | only process tagged documents |
| `EXCLUDE_TAGS` | never process documents with one of these tags automatically (comma-separated) – also not when the Paperless workflow webhook sends them; manual review and the OCR page still work |
| `ADD_AI_PROCESSED_TAG`, `AI_PROCESSED_TAG_NAME` | mark processed documents |
| `USE_PROMPT_TAGS`, `PROMPT_TAGS`, `USE_EXISTING_DATA`, `SYSTEM_PROMPT` | prompt |
| `OVERWRITE_CORRESPONDENT`, `SHARE_CREATED_OBJECTS` | replace existing correspondents (default off); create tags/correspondents/types without owner (default on) |
| `ACTIVATE_TAGGING`, `ACTIVATE_CORRESPONDENTS`, `ACTIVATE_DOCUMENT_TYPE`, `ACTIVATE_TITLE`, `ACTIVATE_CUSTOM_FIELDS`, `ACTIVATE_DOCUMENT_DATE` | enabled functions |
| `RESTRICT_TO_EXISTING_TAGS`, `RESTRICT_TO_EXISTING_CORRESPONDENTS`, `RESTRICT_TO_EXISTING_DOCUMENT_TYPES` | restrictions |
| `CUSTOM_FIELDS` | custom fields (JSON, format of 3.x) |
| `PROMPT_RULES` | [prompt rules](prompt-rules.md) as JSON (locks them in the web interface) |
| `EXTERNAL_API_ENABLED`, `EXTERNAL_API_URL`, `EXTERNAL_API_METHOD`, `EXTERNAL_API_HEADERS`, `EXTERNAL_API_BODY`, `EXTERNAL_API_TIMEOUT`, `EXTERNAL_API_TRANSFORM` | external data; the transform is JavaScript that runs in a sandbox (QuickJS in WebAssembly): it sees only the response, not files, network or the server – 2 s, 64 MB |
| `RAG_ENABLED` (or `RAG_SERVICE_ENABLED`), `RAG_EMBEDDING_PROVIDER`, `RAG_EMBEDDING_MODEL`, `RAG_QUERY_EXPANSION` | ask your archive |
| `RAG_QUERY_PROMPT`, `RAG_DOCUMENT_PROMPT` | [embedding prompts](ask-your-archive.md#embedding-prompts) for questions (`{query}`) and passages (`{text}`, `{title}`); empty = automatic |
| `ACTIVATE_CALENDAR` | find appointments, due dates and deadlines for the calendar (default off) |
| `OCR_ENABLED`, `OCR_MODE` (`manual`, `missing`, `poor`, `always`), `OCR_WRITE_BACK` | OCR on/off, when it runs automatically, replace the text in Paperless (default on) |
| `OCR_API_SERVER` | [OCR API server](ocr.md#ocr-api-server): other apps – Paperless-ngx as its remote OCR engine – send files to be read (default off; works without `OCR_ENABLED`) |
| `OCR_SEARCHABLE_PDF` | lay the OCR text into the PDF as an invisible text layer: archive PDF in the built-in archive, new version in Paperless-ngx ([searchable PDF](ocr.md#searchable-pdf), default off) |
| `OCR_LANGUAGE` (`latin`, `en`, `multi`, `cyrillic`, `eslav`, `greek`, `arabic`, `devanagari`, `korean`, `thai`, `tamil`, `telugu`), `OCR_QUALITY` (`fast`, `balanced`, `accurate`) | OCR model |
| `OCR_MODEL_VERSION` (`v5`, `v6`), `OCR_MODEL_SIZE` (`tiny`, `small`, `medium`) | OCR models: PP-OCRv5 (default, all languages) or [PP-OCRv6](ocr.md#models-pp-ocrv5-or-pp-ocrv6) in a size (Latin script, Chinese, Japanese – other languages keep v5) |
| `OCR_DEVICE` (`auto`, `cpu`, `cuda`), `OCR_THREADS`, `OCR_MAX_PAGES` | OCR hardware and limits (`0` threads = automatic, `0` pages = all) |
| `OCR_RELEASE` (`auto`, `document`, `idle`) | When the OCR models are unloaded and their memory is freed: `auto` = on the GPU after each document (before the AI analysis), on the CPU after 10 idle minutes |
| `API_KEY`, `JWT_SECRET` | secrets (generated automatically when unset; use at least 32 random characters for `JWT_SECRET`) |
| `LOG_LEVEL`, `LOG_FORMAT=json` | operations |
| `TRUST_PROXY` | behind a reverse proxy: number of proxy hops (usually `1`) or the proxy addresses – needed for correct client IPs (login rate limit) and secure cookies; off by default |
| `PAPERLESS_AI_URL` | address of Paperless-AI as the browser opens it (e.g. `https://paperless-ai.example.com`) – used for the single sign-on redirect URI; default: the address of the request (behind a proxy from its `X-Forwarded-Proto`/`-Host`) |
| `OIDC_ENABLED`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | [single sign-on](single-sign-on.md) with an OpenID Connect provider (the secret stays empty for a public client) |
| `OIDC_ALLOWED_GROUPS`, `OIDC_GROUPS_CLAIM`, `OIDC_SCOPES` | only members of these groups may sign in (comma-separated, empty = everyone the provider lets through); claim with the groups (default `groups`); scopes (default `openid profile email`) |
| `OIDC_ADMIN_GROUPS`, `OIDC_SYNC_GROUPS` | members of these groups are administrators, everyone else members – set at every sign-in (comma-separated, empty = the roles are set in Paperless-AI); take over the provider's groups as groups of Paperless-AI (default on) |
| `OIDC_AUTO_CREATE`, `OIDC_USERNAME_CLAIM`, `OIDC_BUTTON_LABEL`, `OIDC_PROVIDER_LOGOUT` | create accounts on the first sign-in (default on), claim for their names (default `preferred_username`), label of the login button, sign out at the provider too (default on) |
| `PASSWORD_LOGIN` | `false` = sign in with single sign-on only (takes effect only while single sign-on is set up) |
| `PAPERLESS_AI_SMTP_HOST`, `_PORT`, `_SECURITY`, `_USER`, `_PASSWORD`, `_FROM` | e-mail server for notifications of workflows (both archives) |
| `PAPERLESS_AI_READERS`, `PAPERLESS_AI_VECTOR_WORKER` | worker threads for database reads (default `min(4, CPUs)`, `0` = none); `0` runs the vector search of *Ask your archive* in the main thread (default: a worker) |

Empty variables (e.g. `OPENAI_API_KEY=` left in a compose file) are ignored, so they never replace what you configured in the web interface.

The variables of the [built-in archive](built-in-archive.md#environment-variables) (`PAPERLESS_AI_ARCHIVE`, `PAPERLESS_AI_STORAGE_DIR`, `PAPERLESS_AI_CONSUME_DIR`, `PAPERLESS_AI_SCANS_DIR`, `PAPERLESS_AI_EXPORT_DIR` …) are listed in its guide, those of the MCP bridge (`PAPERLESS_AI_URL`, `PAPERLESS_AI_API_KEY`) in [AI agents (MCP)](mcp.md).
