# Stage 1: install production deps only
FROM node:24-trixie-slim AS deps
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev
# The ARM64 prebuilt better-sqlite3 binary can require a newer glibc than this
# slim image provides. Remove it and compile directly against this image's libc.
RUN rm -rf node_modules/better-sqlite3/prebuilds \
    && cd node_modules/better-sqlite3 \
    && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild

# Stage 2: runtime image
FROM node:24-trixie-slim AS runtime
WORKDIR /app

# Non-root user
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system aperio \
    && adduser --system --ingroup aperio aperio

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=aperio:aperio . .

# Runtime state lives here (lock file, engine, models, uploads, sessions, logs).
# Keeping the engine and model cache below /app/var makes a recreated container
# agree with the persisted bootstrap.lock instead of losing its local AI runtime.
RUN mkdir -p var/home var/cache/transformers var/llamacpp var/models \
    && chown -R aperio:aperio /app /app/var

# The first-run setup wizard creates .env, and lib/helpers/envFile.js writes it
# to <install dir>/.env — here /app. The production Compose file and the k8s
# Deployment run this image with a read-only root filesystem, so that write
# would fail with EROFS and /api/setup/config would 400 forever on a fresh
# deployment. Point .env at the writable var/ volume instead: the symlink lives
# on the read-only layer but the write lands on the volume, which also means the
# file now survives container recreation. .dockerignore excludes .env, so this
# shadows nothing, and a dangling symlink reads as absent to existsSync() — the
# wizard's "never overwrite an existing .env" guard still behaves correctly.
RUN ln -s var/.env .env

USER aperio

ENV NODE_ENV=production
ENV PORT=31337
ENV HOST=0.0.0.0
ENV HOME=/app/var/home
ENV XDG_CACHE_HOME=/app/var/cache
ENV TRANSFORMERS_CACHE=/app/var/cache/transformers
ENV LLAMACPP_VENDOR_DIR=/app/var/llamacpp
ENV LLAMA_CACHE=/app/var/models

EXPOSE 31337

CMD ["node", "server.js"]

# docker compose --project-directory . -f docker/docker-compose.yml up -d
# docker compose --project-directory . -f docker/docker-compose.yml down -v
# npm run migrate
# npm run start:local
