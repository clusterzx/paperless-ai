# syntax=docker/dockerfile:1

# VARIANT=cpu  (default) – runs everywhere, OCR and local embeddings on the CPU.
# VARIANT=cuda           – OCR on NVIDIA GPUs (linux/amd64, CUDA 13 + cuDNN 9, driver ≥ 580).
ARG VARIANT=cpu
ARG CUDA_IMAGE=nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04

# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
ARG VARIANT
WORKDIR /app
# CPU binaries of ONNX Runtime are bundled with the npm package; the CUDA provider is added below for VARIANT=cuda.
ENV ONNXRUNTIME_NODE_INSTALL=skip \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json .npmrc ./
# Install scripts are not needed: native modules (better-sqlite3, onnxruntime, sharp) ship prebuilt binaries.
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
 && find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-$ARCH.node" -delete \
 && rm -rf node_modules/@img/*linuxmusl* node_modules/@img/sharp-wasm32 \
 && find node_modules/@img -mindepth 1 -maxdepth 1 -name "*linux-*" ! -name "*linux-$ARCH" -exec rm -rf {} + \
 && rm -f node_modules/@hyzyla/pdfium/dist/*base64* node_modules/@hyzyla/pdfium/dist/index.esm.browser.js node_modules/@hyzyla/pdfium/dist/index.esm.cdn.js

# GPU variant: CUDA execution provider of ONNX Runtime (from NuGet, matches the onnxruntime-node version).
# TensorRT is not part of the image, so its provider is left out.
RUN if [ "$VARIANT" = "cuda" ]; then \
      ONNXRUNTIME_NODE_INSTALL=cuda12 node node_modules/onnxruntime-node/script/install.js \
      && rm -f node_modules/onnxruntime-node/bin/napi-v*/linux/*/libonnxruntime_providers_tensorrt.so \
      && ls node_modules/onnxruntime-node/bin/napi-v*/linux/x64/libonnxruntime_providers_cuda.so; \
    fi

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime-cpu

FROM ${CUDA_IMAGE} AS runtime-cuda
# Node.js from the official image (same version as the build stage).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
# No CUDA banner on every start.
ENTRYPOINT []

FROM runtime-${VARIANT}
ARG VARIANT
LABEL org.opencontainers.image.title="Paperless-AI" \
      org.opencontainers.image.description="AI-powered document classification, tagging, OCR and RAG chat for Paperless-ngx" \
      org.opencontainers.image.source="https://github.com/clusterzx/paperless-ai" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PAPERLESS_AI_PORT=3000 \
    PAPERLESS_AI_DATA_DIR=/app/data \
    PAPERLESS_AI_IMAGE_VARIANT=${VARIANT} \
    HF_HUB_DISABLE_TELEMETRY=1 \
    ORT_DISABLE_TELEMETRY=1

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
