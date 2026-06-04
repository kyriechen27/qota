# Deploying qota

qota runs from **one TypeScript codebase** on two targets:

| | Runtime | Database | Storage | Web |
|---|---|---|---|---|
| **Cloudflare** | Workers | D1 | R2 (S3 API) | Pages |
| **Docker / self-host** | Node (`@hono/node-server`) | SQLite (`better-sqlite3`) | MinIO or any S3 | served by the Node server |

The worker source (`apps/worker/src`) is identical for both. The Node target adds a
thin adapter layer in `apps/worker/node/` (a D1-compatible wrapper over SQLite, a
migration runner, and the Node entrypoint) — Cloudflare never uses those files.

---

## Local development (no Docker)

Two options — both run on your machine, no container needed:

**1. Node + SQLite (matches the Docker runtime, no Cloudflare/wrangler needed)**

```bash
npm install
npm run dev:node
```
- Web (Vite + HMR): http://localhost:5173  → proxies `/api` to the Node server on :8080
- API (Node + SQLite, hot-reload via tsx): http://localhost:8080
- SQLite auto-migrates and seeds `admin@example.com / admin12345` on first run.
- `JWT_SECRET` is optional in dev (an insecure dev secret is used; set one for real use).
- File upload/download needs an S3 endpoint — set `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/
  `S3_SECRET_ACCESS_KEY` (point at a local MinIO or any bucket). Everything else
  (auth, account, versions list, download counts) works without S3.

**2. Wrangler (emulates Cloudflare locally: Workers + D1 + R2)**

```bash
npm run dev   # wrangler dev on :8787 + Vite on :5173
```
Needs `apps/worker/.dev.vars` (JWT_SECRET + R2 creds). Use this when you specifically
want to test Cloudflare behaviour.

---

## Option A — Docker (self-hosted)

Bundles the API, the built web SPA, SQLite and MinIO into `docker compose`.

```bash
cp .env.example .env
# edit .env: set JWT_SECRET (openssl rand -hex 32); optionally ADMIN_EMAIL/ADMIN_PASSWORD
docker compose up -d --build
```

- App:            http://localhost:8080
- MinIO console:  http://localhost:9001  (user/pass from `.env`)
- First-run admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` only when the DB is empty.
- SQLite persists in the `qota-data` volume; objects in `minio-data`.

**Presigned-URL note:** the browser and devices receive presigned S3 URLs signed for
`S3_PUBLIC_ENDPOINT`. It must be reachable by them. Locally that's `http://localhost:9000`
(default). On a server, set it to your public MinIO/S3 URL (e.g. `https://s3.example.com`),
while the app keeps talking to MinIO internally via `S3_ENDPOINT`.

Run the bundled server without compose (e.g. against an existing S3):

```bash
npm ci
npm run build                      # web -> apps/web/dist
npm run -w apps/worker build:node  # server -> apps/worker/dist-node/server.mjs
JWT_SECRET=... S3_ENDPOINT=https://s3.example.com S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  S3_BUCKET=qota-ota WEB_DIST=apps/web/dist MIGRATIONS_DIR=apps/worker/migrations \
  npm run -w apps/worker start:node
```

### Node env vars
| var | default | notes |
|---|---|---|
| `JWT_SECRET` | — (required) | session signing key |
| `PORT` | `8080` | |
| `SQLITE_PATH` | `./data/qota.db` | |
| `WEB_DIST` | `./web` | built SPA dir (`apps/web/dist`) |
| `MIGRATIONS_DIR` | `./migrations` | reuses the same D1 `.sql` files |
| `S3_ENDPOINT` | R2 from `R2_ACCOUNT_ID` | endpoint the server calls |
| `S3_PUBLIC_ENDPOINT` | = `S3_ENDPOINT` | endpoint embedded in presigned URLs |
| `S3_REGION` | `auto` | use `us-east-1` for MinIO |
| `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | also accepts the `R2_*` names |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / `admin12345` | first-run seed only |

---

## Option B — Cloudflare (unchanged)

```bash
# worker (Workers + D1 + R2)
npm -w apps/worker run db:migrate:remote
npm -w apps/worker run deploy
# web (Pages)
npm run build && npm -w apps/web run deploy
```

Secrets via `wrangler secret put` (`JWT_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`);
vars/D1/bucket in `apps/worker/wrangler.toml`. The `S3_*` overrides are not needed on
Cloudflare — storage falls back to the R2 endpoint derived from `R2_ACCOUNT_ID`.
