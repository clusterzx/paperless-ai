# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app
# CPU binaries of ONNX Runtime are bundled with the npm package; skip the optional CUDA download.
ENV ONNXRUNTIME_NODE_INSTALL=skip \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json .npmrc ./
# Install scripts are not needed: native modules (better-sqlite3, onnxruntime) ship prebuilt binaries.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src
RUN npm run build

# Production dependencies only, without binaries for other platforms.
ARG TARGETARCH
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf node_modules/onnxruntime-web \
 && ARCH=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
 && find node_modules/onnxruntime-node/bin/napi-v*/ -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find node_modules/onnxruntime-node/bin/napi-v*/linux -mindepth 1 -maxdepth 1 ! -name "$ARCH" -exec rm -rf {} + \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
 && find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-$ARCH.node" -delete

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Paperless-AI" \
      org.opencontainers.image.description="AI-powered document classification, tagging and RAG chat for Paperless-ngx" \
      org.opencontainers.image.source="https://github.com/clusterzx/paperless-ai" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PAPERLESS_AI_PORT=3000 \
    PAPERLESS_AI_DATA_DIR=/app/data \
    HF_HUB_DISABLE_TELEMETRY=1

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PAPERLESS_AI_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node handles SIGTERM itself (graceful shutdown); no process manager needed.
CMD ["node", "dist/server/index.js"]
