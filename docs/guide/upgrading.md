# Upgrading

← [Documentation](README.md)

## Within 4.x

Pull the new image and start it again – database migrations run on start:

```bash
docker compose pull && docker compose up -d
```

An installation that uses Paperless-ngx stays in that mode. Nothing changes until you choose to [move to the built-in archive](built-in-archive.md#moving-from-paperless-ngx).

## Upgrading from 3.x

Keep your data volume and switch the image – everything else happens on the first start.

1. **Back up** the data volume (`docker volume ls` shows its exact name, often with the project name in front):
   ```bash
   docker compose stop paperless-ai
   docker run --rm -v paperless-ai_data:/data -v "$PWD":/backup alpine \
     tar czf /backup/paperless-ai-3x-backup.tgz -C /data .
   ```
2. **Update `docker-compose.yml`:** use `image: clusterzx/paperless-ai:latest` (or a fixed [version tag](https://hub.docker.com/r/clusterzx/paperless-ai/tags)), keep the volume `…:/app/data` and the port. Remove the 3.x lines `RAG_SERVICE_URL`, `PUID` and `PGID` (no longer used) and `RAG_SERVICE_ENABLED` (it would lock the setting in the UI).
3. **Start:** `docker compose pull && docker compose up -d`. The log (`docker compose logs -f paperless-ai`) shows `Migrated legacy data/.env configuration to data/config.json` and `Imported data from legacy documents.db` with the number of migrated users, documents and history entries.
4. **Sign in** with your previous username and password and review the settings – everything is prefilled; values set by environment variables are shown locked.

What is migrated: settings from `data/.env`, the user account, which documents were already processed (nothing is analysed again, no extra AI costs), the history including the original values (undo works for old changes too) and the token statistics. The search index for *Ask your archive* is rebuilt in the background; the first time, the built-in embedding model (~120 MB) is downloaded. The 3.x files (`.env`, `documents.db`) are left untouched, so you can switch back to the 3.x image – it just won't know about anything done in 4.x.

> [!WARNING]
> **If your 3.x instance was reachable from the internet** (without an additional login such as a VPN or an authenticating reverse proxy in front of it), it may have been taken over through its setup wizard (see [SECURITY.md](../../SECURITY.md)). 3.x only has one account, so the clearest sign is that **your previous username and password no longer work**, or that the settings contain a Paperless URL or AI endpoint you did not set. In that case:
> - do **not** migrate the old data – start with a new, empty data volume and run the setup again;
> - create a **new Paperless API token** for Paperless-AI and delete the old one, and replace the **API keys** of your AI provider;
> - check the Paperless-ngx logs for document access with the old token.
>
> In any case, don't expose a fresh installation to the internet before the setup is completed: until the first account exists, the setup wizard is open to everyone who can reach it.
