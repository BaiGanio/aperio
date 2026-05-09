# Stage 1: install production deps only
FROM node:24-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: runtime image
FROM node:24-slim AS runtime
WORKDIR /app

# Non-root user
RUN addgroup --system aperio && adduser --system --ingroup aperio aperio

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=aperio:aperio . .

# Runtime state lives here (lock file, uploads, sessions, logs)
RUN mkdir -p var && chown aperio:aperio var

USER aperio

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "server.js"]

# docker compose -f docker/docker-compose.prod.yml up -d
