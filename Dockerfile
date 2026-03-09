# Use a slim Node.js (LTS) image as base
FROM node:22-slim as builder

WORKDIR /app

# Install system dependencies and clean up in single layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    python3-venv \
    make \
    g++ \
    curl \
    wget && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies for RAG service in a virtual environment
COPY requirements.txt /app/
ENV PATH="/app/venv/bin:$PATH"
RUN python3 -m venv /app/venv && pip install --upgrade pip && pip install --no-cache-dir -r requirements.txt

# Copy package files for dependency installation
COPY package*.json ./

# Install node dependencies with clean install
RUN npm ci --only=production && npm cache clean --force

FROM node:22-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-distutils \
        libpython3-stdlib \
        libexpat1 \
        curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/venv /app/venv
ENV PATH="/app/venv/bin:$PATH"

RUN npm install pm2 -g

COPY --from=builder /app/node_modules /app/node_modules

# Copy application source code
COPY . .

# Make startup script executable
RUN chmod +x start-services.sh

# Configure persistent data volume
VOLUME ["/app/data"]

# Configure application port - aber der tatsächliche Port wird durch PAPERLESS_AI_PORT bestimmt
EXPOSE ${PAPERLESS_AI_PORT:-3000}

# Add health check with dynamic port
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PAPERLESS_AI_PORT:-3000}/health || exit 1

# Set production environment
ENV NODE_ENV=production

# Start both Node.js and Python services using our script
CMD ["./start-services.sh"]
