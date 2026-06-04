// Node.js entrypoint — lets the SAME Hono worker run outside Cloudflare
// (Docker / bare metal). It:
//   1. builds the `Bindings` env from process.env,
//   2. backs `DB` with a local SQLite file via the D1-compatible adapter,
//   3. runs migrations + seeds a first admin on boot,
//   4. serves the built web SPA and proxies /api/* into the Hono app.
//
// On Cloudflare nothing here is used — wrangler still bundles src/index.ts.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import apiApp from '../src/index.ts';
import { createSqliteD1 } from './d1-sqlite.mjs';
import { runMigrations } from './migrate.mjs';
import { makeLocalStorage } from './local-storage.mjs';

// ---- load .env / .dev.vars (so dev:node reuses the same config as wrangler) -
// Looks in cwd (apps/worker) and the repo root. Existing process.env wins.
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
for (const f of ['.dev.vars', '.env', '../../.env']) loadEnvFile(resolve(f));

// ---- paths & config -------------------------------------------------------
const PORT = Number(process.env.PORT) || 8080;
const SQLITE_PATH = resolve(process.env.SQLITE_PATH || './data/qota.db');
const MIGRATIONS_DIR = resolve(process.env.MIGRATIONS_DIR || './migrations');
const WEB_DIST = resolve(process.env.WEB_DIST || './web');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is required. Set a long random value (openssl rand -hex 32).');
    process.exit(1);
  }
  JWT_SECRET = 'dev-insecure-secret-change-me';
  console.warn('[dev] JWT_SECRET not set — using an insecure dev secret. Do NOT use in production.');
}

mkdirSync(dirname(SQLITE_PATH), { recursive: true });

const db = createSqliteD1(SQLITE_PATH);
runMigrations(db, MIGRATIONS_DIR);
seedAdmin(db);

// ---- storage backend ------------------------------------------------------
// Default to a local folder (zero external deps — no S3/MinIO required). If
// S3/R2 is configured (or STORAGE_DRIVER=s3) the worker uses the S3 client and
// presigned URLs instead. STORAGE_DRIVER=local forces the folder even when S3
// vars are present. (On Cloudflare there's no filesystem, so a bucket is
// always required there — see apps/worker/src/lib/s3.ts.)
const STORAGE_DIR = resolve(process.env.STORAGE_DIR || './data/blobs');
const s3Configured =
  !!process.env.S3_ENDPOINT ||
  (!!process.env.R2_ACCOUNT_ID && !process.env.R2_ACCOUNT_ID.includes('REPLACE'));
const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || (s3Configured ? 's3' : 'local')).toLowerCase();
const BUCKET = process.env.S3_BUCKET || process.env.R2_BUCKET_NAME || 'qota-ota';

let storage; // undefined → the app falls back to the S3/R2 client via makeStorage()
if (STORAGE_DRIVER === 'local') {
  mkdirSync(STORAGE_DIR, { recursive: true });
  storage = makeLocalStorage({ baseDir: STORAGE_DIR, bucket: BUCKET, secret: JWT_SECRET });
}

// ---- env passed to the Hono app as c.env ----------------------------------
const env = {
  DB: db,
  STORAGE: storage,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  JWT_TTL_SECONDS: process.env.JWT_TTL_SECONDS || '43200',
  DOWNLOAD_URL_TTL_SECONDS: process.env.DOWNLOAD_URL_TTL_SECONDS || '300',
  UPLOAD_PART_URL_TTL_SECONDS: process.env.UPLOAD_PART_URL_TTL_SECONDS || '600',
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
  R2_BUCKET_NAME: BUCKET,
  JWT_SECRET,
  R2_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '',
  R2_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '',
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
  S3_REGION: process.env.S3_REGION,
};

// Workers give handlers an executionCtx; emulate the bits the app uses.
const execCtx = {
  waitUntil(p) {
    Promise.resolve(p).catch((e) => console.error('[waitUntil]', e));
  },
  passThroughOnException() {},
};

// ---- static web (SPA) + API delegation ------------------------------------
const indexHtmlPath = join(WEB_DIST, 'index.html');
const hasWeb = existsSync(indexHtmlPath);
if (!hasWeb) console.warn(`[web] no SPA found at ${indexHtmlPath} — serving API only`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(path) {
  const dot = path.lastIndexOf('.');
  return (dot >= 0 && MIME[path.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

function serveWeb(c) {
  if (!hasWeb) return c.json({ error: 'not_found' }, 404);
  const pathname = decodeURIComponent(new URL(c.req.url).pathname);
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = normalize(join(WEB_DIST, rel));
  if (full.startsWith(normalize(WEB_DIST)) && existsSync(full) && statSync(full).isFile()) {
    return new Response(readFileSync(full), { headers: { 'content-type': mimeFor(full) } });
  }
  // SPA fallback — any unknown non-API path renders index.html.
  return new Response(readFileSync(indexHtmlPath), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const root = new Hono();
root.all('/api', (c) => apiApp.fetch(c.req.raw, env, execCtx));
root.all('/api/*', (c) => apiApp.fetch(c.req.raw, env, execCtx));
root.get('*', serveWeb);

serve({ fetch: root.fetch, port: PORT }, (info) => {
  console.log(`qota listening on http://0.0.0.0:${info.port}`);
  console.log(`  db:         ${SQLITE_PATH}`);
  console.log(`  web:        ${hasWeb ? WEB_DIST : '(none)'}`);
  console.log(
    `  storage:    ${
      STORAGE_DRIVER === 'local' ? `local folder (${STORAGE_DIR})` : `s3 (${env.S3_ENDPOINT || `r2:${env.R2_ACCOUNT_ID}`})`
    }`,
  );
});

// ---- first-run admin seed -------------------------------------------------
function seedAdmin(d1) {
  const { n } = d1._db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  const displayName = process.env.ADMIN_NAME || 'Admin';
  const now = Date.now();
  d1._db
    .prepare(
      `INSERT INTO users (email, password_hash, display_name, role, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'super_admin', 1, ?, ?)`,
    )
    .run(email, hashPassword(password), displayName, now, now);
  console.log(`[seed] created initial admin: ${email} / ${password}`);
  console.log('[seed] change this password immediately after first login.');
}

// Mirrors apps/worker/src/utils/password.ts → "pbkdf2$<iters>$<salt>$<hash>".
function hashPassword(password) {
  const iterations = 100_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `pbkdf2$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
