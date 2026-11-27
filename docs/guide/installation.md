# Installation

← [Documentation](README.md)

## Docker Compose

```yaml
# docker-compose.yml
services:
  paperless-ai:
    image: clusterzx/paperless-ai:latest
    container_name: paperless-ai
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - TZ=Europe/Berlin # your time zone: schedules, dates, logs
      # - TRUST_PROXY=1  # behind a reverse proxy (Traefik, Caddy, nginx, Coolify …)
    volumes:
      - paperless-ai_data:/app/data
      # Built-in archive: a folder for your scanner – set /scans as the watch folder in Settings → Archive
      - ./scans:/scans
    extra_hosts:
      - "host.docker.internal:host-gateway" # to reach Ollama on the Docker host

volumes:
  paperless-ai_data:
```

```bash
docker compose up -d
```

Open `http://<your-server>:3000`. The setup wizard asks for your account, the archive (Paperless-ngx or the [built-in archive](built-in-archive.md)), the AI provider and the processing options. No restart is needed afterwards.

> [!IMPORTANT]
> Until the first account exists, the setup wizard is open to everyone who can reach it. Complete the setup before the instance is reachable from other networks, and keep Paperless-AI in your local network or behind a VPN or an authenticating reverse proxy.

**Setup code:** when credentials are set before the first account exists – the Paperless-ngx token, an AI key, the OIDC client secret or the SMTP password as [environment variables](configuration.md), or a `data/.env` of 3.x – the wizard first asks for a setup code, so that nobody else can create the administrator who gets them. The code is in the log (`docker logs paperless-ai`) and in `data/setup-code`; it is no longer needed once the first account exists. The first account created by single sign-on needs it as well.

- **`/scans`** is only needed for the [built-in archive](built-in-archive.md) with a scanner or another program that drops files into a folder ([watch folders](intake.md#watch-folders)); with Paperless-ngx as the archive you can leave the line out. Any host folder works, e.g. `/srv/scans:/scans` or a NAS share.
- **`TZ`** sets the time zone of schedules, dates and logs (default: UTC).
- The `docker-compose.yml` of the repository builds the image from source, with the same folders (the host folder of `/scans` is `PAPERLESS_AI_SCANS_DIR`).

## Image variants

| Tag | For |
| --- | --- |
| `latest` (= `latest-cpu`), `4.x.y` | default – amd64 and arm64, OCR and local embeddings on the CPU |
| `latest-cuda`, `4.x.y-cuda` | NVIDIA GPU for OCR (amd64, CUDA 13 + cuDNN 9). Needs the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) and a driver ≥ 580; falls back to the CPU when no GPU is found |

```yaml
    image: clusterzx/paperless-ai:latest-cuda
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

## Paperless-ngx API user

With Paperless-ngx as the archive, create a dedicated user in Paperless-ngx with permission to *view* and *change* documents, tags, correspondents, document types and custom fields, and use its API token (*Profile → API Auth Token*). Only documents this user may change are processed.

## Instant processing with a Paperless-ngx workflow

Without it, new documents are picked up by the scheduled scan. To process them as soon as Paperless-ngx has consumed them:

1. Paperless-ngx → *Workflows* → *Add workflow*, trigger **Document Added**
2. Action **Webhook**: URL `http://paperless-ai:3000/api/webhook/document`, *Use parameters for webhook body*, parameter `url` = `{{ doc_url }}` (older Paperless-ngx versions write placeholders with single braces: `{doc_url}`; if the placeholder arrives unreplaced, Paperless-AI answers 400 and its log says so)
3. Header `x-api-key: <API key from Settings → API & webhooks>`

## Behind a reverse proxy

Set `TRUST_PROXY=1` (the number of proxy hops) so that client addresses (login rate limit) and secure cookies work. For [single sign-on](single-sign-on.md), the redirect URI is taken from the `X-Forwarded-Proto` / `X-Forwarded-Host` headers; set `PAPERLESS_AI_URL` if Paperless-AI sees another address than your browser.

Certificates of your own CA: see [Self-signed certificates](certificates.md).

## Next steps

- [Upgrading](upgrading.md) – from 3.x, and within 4.x
- [Configuration](configuration.md) – environment variables
- [Built-in archive](built-in-archive.md) – run without Paperless-ngx
