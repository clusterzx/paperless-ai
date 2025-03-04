# Stage 1: Build Stage
FROM node:22-slim AS build

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl && \
    rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package*.json ./

# Install dependencies with caching optimization
RUN npm ci --only=production && npm cache clean --force

# Copy application source code
COPY . .

# Stage 2: Runtime Stage (Final Minimal Image)
FROM node:22-slim

WORKDIR /app

# Copy only necessary files from build stage
COPY --from=build --chown=root:1000 /app /app

# Change ownership to root and the group to 1000 (node user)
RUN chown -R root:1000 /app

# Change permissions of /app to 770 to allow execution from root & node user
RUN chmod -R 770 /app

# Install PM2 process manager globally
RUN npm install pm2 -g

# Configure persistent data volume
VOLUME ["/app/data"]

# Configure application port - but the actual port is determined by PAPERLESS_AI_PORT
EXPOSE ${PAPERLESS_AI_PORT:-3000}

# Add health check with dynamic port
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PAPERLESS_AI_PORT:-3000}/health || exit 1

# Set production environment
ENV NODE_ENV=production

# Start application with PM2
CMD ["pm2-runtime", "ecosystem.config.js"]