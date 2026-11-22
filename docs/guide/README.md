# Paperless-AI documentation

← [Back to the README](../../README.md)

**Getting started**

- [Installation](installation.md) – Docker Compose, image variants (CPU / NVIDIA), the Paperless-ngx API user, instant processing, reverse proxy
- [Upgrading](upgrading.md) – within 4.x and from 3.x
- [Configuration](configuration.md) – all environment variables

**Using it**

- [Built-in archive](built-in-archive.md) – without Paperless-ngx: libraries and roles, versions, trash, moving from Paperless-ngx, export
- [Getting documents in](intake.md) – upload, REST, WebDAV, watch folders, e-mail, phone (built-in archive)
- [Mobile apps](mobile-apps.md) – Swift Paperless, Paperless Mobile and other Paperless-ngx apps with the built-in archive
- [Search, tags and metadata](search-and-metadata.md) – search syntax, find duplicates, sorting, custom fields
- [Prompt rules](prompt-rules.md) – other prompts and settings per kind of document
- [OCR](ocr.md) – reading scans locally with PaddleOCR
- [Ask your archive](ask-your-archive.md) – embeddings, embedding prompts, smart search terms
- [Calendar](calendar.md) – appointments, due dates and deadlines, iCal subscription
- Workflows – triggers, conditions, actions: see [docs/standalone/workflows.md](../standalone/workflows.md)

**Setup details**

- [Single sign-on](single-sign-on.md) – OpenID Connect (Authentik, Keycloak, Authelia …)
- [Local models](local-models.md) – Ollama, vLLM, llama.cpp, LM Studio
- [Self-signed certificates](certificates.md)
- [API](api.md)
- [Development](development.md)
