# Deploying qota

qota runs from **one TypeScript codebase** on two targets:

| | Runtime | Database | Storage | Web |
|---|---|---|---|---|
| **Cloudflare** | Pages Functions (or Workers) | D1 | R2 (S3 API) | Pages |
| **Docker / self-host** | Node (`@hono/node-server`) | SQLite (`better-sqlite3`) | Local folder (default) · MinIO/any S3 (opt-in) | served by the Node server |

## Storage backends

The Node runtime picks a backend automatically:

- **Local folder (default)** — no external service. Files are stored under
  `STORAGE_DIR` (`./data/blobs`, or `/app/data/blobs` in Docker) and the Node
  server serves uploads/downloads itself via short-lived signed `/api/storage/*`
  URLs. Used whenever no S3/R2 is configured.
- **S3 / R2 / MinIO** — used when `S3_ENDPOINT` (or a real `R2_ACCOUNT_ID`) is set.
  The browser/devices transfer bytes directly to object storage via presigned URLs.

Force either with `STORAGE_DRIVER=local|s3`. **Cloudflare always uses the R2 bucket**
— Workers have no local disk, so the folder backend exists only on Node.

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
- File upload/download works out of the box — files go to a local folder
  (`apps/worker/data/blobs`), no S3 needed. To use MinIO/S3 instead, set
  `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`.

**2. Wrangler (emulates Cloudflare locally: Workers + D1 + R2)**

```bash
npm run dev   # wrangler dev on :8787 + Vite on :5173
```
Needs `apps/worker/.dev.vars` (JWT_SECRET + R2 creds). Use this when you specifically
want to test Cloudflare behaviour.

---

## Option A — Docker (self-hosted)

Bundles the API, the built web SPA and SQLite into `docker compose`. Storage
defaults to a local folder — **no MinIO needed**.

```bash
cp .env.example .env
# edit .env: set JWT_SECRET (openssl rand -hex 32); optionally ADMIN_EMAIL/ADMIN_PASSWORD
docker compose up -d --build
```

- App: http://localhost:8080
- First-run admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` only when the DB is empty.
- SQLite **and** uploaded files persist in the `qota-data` volume (`/app/data`).

**Want MinIO/S3 instead?** Uncomment the `S3_*` block in `.env`, then start the
bundled MinIO via its profile:

```bash
docker compose --profile minio up -d --build
```

- MinIO console: http://localhost:9001 (user/pass from `.env`); objects in `minio-data`.
- **Presigned-URL note:** the browser and devices receive presigned S3 URLs signed for
  `S3_PUBLIC_ENDPOINT`, which must be reachable by them. Locally that's
  `http://localhost:9000`. On a server, set it to your public MinIO/S3 URL
  (e.g. `https://s3.example.com`) while the app talks to MinIO internally via `S3_ENDPOINT`.
  (The local-folder backend has no such split — it serves files from the app's own origin.)

Run the bundled server without compose:

```bash
npm ci
npm run build                      # web -> apps/web/dist
npm run -w apps/worker build:node  # server -> apps/worker/dist-node/server.mjs

# Local-folder storage (default — no S3 needed):
JWT_SECRET=... STORAGE_DIR=./data/blobs \
  WEB_DIST=apps/web/dist MIGRATIONS_DIR=apps/worker/migrations \
  npm run -w apps/worker start:node

# …or against an existing S3/MinIO/R2:
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
| `STORAGE_DRIVER` | auto (`local` unless S3 is set) | force `local` or `s3` |
| `STORAGE_DIR` | `./data/blobs` | local-folder backend: where files are stored |
| `S3_ENDPOINT` | R2 from `R2_ACCOUNT_ID` | endpoint the server calls (selects the `s3` driver) |
| `S3_PUBLIC_ENDPOINT` | = `S3_ENDPOINT` | endpoint embedded in presigned URLs |
| `S3_REGION` | `auto` | use `us-east-1` for MinIO |
| `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | also accepts the `R2_*` names |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / `admin12345` | first-run seed only |

> The `S3_*` vars apply only to the `s3` driver. With them unset the server uses the
> local-folder backend, and only `JWT_SECRET` + the paths above are needed.

---

## Option B — Cloudflare Pages (connect Git → auto-deploy, no build command)

qota deploys as a single **Cloudflare Pages** project, the same way as the
`remote-file` project: the **build output is committed to the repo**, so Cloudflare
serves it directly with an **EMPTY build command** — no `npm install` / build runs on
Cloudflare. `apps/web/dist` holds the static SPA plus `_worker.js` (the whole Hono API
bundled by [`apps/worker/pages-entry.ts`](apps/worker/pages-entry.ts), Cloudflare Pages
"advanced mode"). The API and SPA share one origin, so the front-end's relative
`/api/...` calls work with no cross-domain config.

> **The one trade-off:** because the artifacts are committed, you must rebuild and commit
> them before pushing whenever the app or web changes:
> ```bash
> npm run pages:build        # builds apps/web/dist + bundles _worker.js
> git add -A && git commit && git push
> ```

### One-time setup

```bash
npx wrangler login
npx wrangler d1 create qota-db          # → put the database_id into the root wrangler.toml
npx wrangler r2 bucket create qota-ota  # → put your account id into R2_ACCOUNT_ID
# create an R2 S3 API token (Dashboard → R2 → Manage API Tokens) for the keys below
npm run d1:migrate:remote               # apply schema to the remote D1
```

Then **Cloudflare Pages → Create project → Connect to Git**, pick this repo and set:

```text
Build command:           (leave EMPTY)
Build output directory:  apps/web/dist
```

In the Pages project settings add:

- **D1 database binding** — variable name `DB` → database `qota-db` (also declared in
  [`wrangler.toml`](wrangler.toml))
- **Secrets / vars** — `JWT_SECRET` (required), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  (required); optional `ADMIN_PASSWORD` (defaults to `admin12345`)

Deploy. On first request the API auto-creates the admin (`ADMIN_EMAIL` / `ADMIN_PASSWORD`,
default `admin@example.com` / `admin12345` — **change it immediately**).

**After that, every `git push` deploys the committed `apps/web/dist`.** Remember to run
`npm run pages:build` first (above). New D1 migrations also need `npm run d1:migrate:remote`.

> R2 is required on Cloudflare (no local disk). Browsers/devices transfer bytes directly
> to R2 via presigned URLs, so set **R2 CORS** to allow your Pages domain (and device origins).

### Local preview of the Pages build

```bash
echo 'JWT_SECRET="dev-secret"' > .dev.vars   # gitignored; local-only
npm run d1:migrate:local
npm run pages:dev                            # builds + wrangler pages dev (http://localhost:8788)
```

### CLI deploy (no Git integration)

```bash
npm run pages:deploy   # rebuilds, then `wrangler pages deploy apps/web/dist`
```

## Option C — Standalone Worker + Pages (the original split)

Prefer a separate Worker (API) and Pages (web)? That still works via
[`apps/worker/wrangler.toml`](apps/worker/wrangler.toml):

```bash
npm -w apps/worker run db:migrate:remote
npm -w apps/worker run deploy            # Worker (Workers + D1 + R2)
npm run build && npm -w apps/web run deploy   # web (Pages)
```

Secrets via `wrangler secret put` (`JWT_SECRET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`).
Note: with this split the Worker and Pages are on different domains, so the SPA's relative
`/api` won't reach the Worker without a custom-domain route or a `VITE_API_BASE` change —
which is exactly why Option B (single Pages project) is simpler.
