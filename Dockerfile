# syntax=docker/dockerfile:1
# Single-image qota: Hono API (Node) + built web SPA, backed by SQLite + S3/MinIO.
# The SAME worker code also deploys to Cloudflare (Workers + D1 + R2) via wrangler.

# ---- build stage ----------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install deps (better-sqlite3 fetches a prebuilt binary for linux/glibc).
COPY . .
RUN npm ci

# Build the web SPA and bundle the Node server entry.
RUN npm run build \
 && npm run -w apps/worker build:node

# ---- runtime stage --------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    SQLITE_PATH=/app/data/qota.db

# node_modules carries the native better-sqlite3 binding; the rest of the
# server (hono, aws4fetch, @hono/node-server, shared types) is bundled.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist-node ./dist-node
COPY --from=build /app/apps/worker/migrations ./migrations
COPY --from=build /app/apps/web/dist ./web

RUN mkdir -p /app/data
EXPOSE 8080
CMD ["node", "dist-node/server.mjs"]
