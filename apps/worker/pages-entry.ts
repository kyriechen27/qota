// Cloudflare Pages "advanced mode" entry. `npm run pages:build` bundles this
// (with all npm deps + the migration SQL inlined) into apps/web/dist/_worker.js,
// and that built dir is committed to the repo.
//
// Like remote-file, this lets Cloudflare Pages deploy with an EMPTY build command
// (it just serves the committed apps/web/dist). Setup is then 100% dashboard —
// nothing is hardcoded into the build: D1 (DB), R2 (BUCKET) and JWT_SECRET all come
// from the Pages bindings/secrets at runtime. On first request the schema is
// auto-created (see ensureSchema) and the admin auto-seeded, so a fresh deploy —
// or anyone reusing this project — only needs to bind DB + BUCKET and set
// JWT_SECRET. No CLI migrations, no database id in any file.
//
// Routing: /api/* → the Hono app; everything else → the static SPA via ASSETS.

import app from './src/index';
import type { Bindings } from './src/env';
import migration0001 from './migrations/0001_init.sql';
import migration0002 from './migrations/0002_download_count.sql';
import migration0003 from './migrations/0003_public_versions.sql';

interface PagesEnv extends Bindings {
  ASSETS: Fetcher;
}

// Split a .sql file into individual statements: strip comments, drop PRAGMA
// (D1 manages foreign keys itself) and blank statements.
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA/i.test(s));
}

let schemaReady = false;

// Auto-create the D1 schema on a fresh database (no `users` table yet). Guarded
// per isolate; safe to run again (it no-ops once the schema exists). New schema
// changes after launch still use `wrangler d1 migrations apply` — this only
// bootstraps an empty DB so first deploy / project reuse needs zero CLI.
async function ensureSchema(env: PagesEnv): Promise<void> {
  if (schemaReady) return;
  const existing = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).first();
  if (!existing) {
    for (const stmt of [...statements(migration0001), ...statements(migration0002), ...statements(migration0003)]) {
      await env.DB.prepare(stmt).run();
    }
    schemaReady = true;
    console.log('[schema] initialized D1 tables on first run');
    return;
  }
  // Existing DB: apply additive post-launch migrations idempotently so a fresh
  // deploy needs zero CLI (same spirit as the bootstrap above). Each step is a
  // no-op once its column exists.
  await ensurePublicSlug(env);
  schemaReady = true;
}

// 0003 — versions.public_slug. ALTER TABLE ADD COLUMN rewrites the table's
// stored schema in sqlite_master, so the column name appears there afterwards;
// that's our idempotency check (no PRAGMA, works on D1 + SQLite).
async function ensurePublicSlug(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'versions'",
  ).first<{ sql: string }>();
  if (row && typeof row.sql === 'string' && !row.sql.includes('public_slug')) {
    for (const stmt of statements(migration0003)) {
      await env.DB.prepare(stmt).run();
    }
    console.log('[schema] added versions.public_slug');
  }
}

export default {
  async fetch(request: Request, env: PagesEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (env.DB) {
        try {
          await ensureSchema(env);
        } catch (e) {
          console.error('[schema] ensureSchema failed (will retry next request):', e);
        }
      }
      return app.fetch(request, env, ctx);
    }
    const asset = await env.ASSETS.fetch(request);
    // SPA fallback: serve index.html for unknown client-side routes.
    if (
      asset.status === 404 &&
      request.method === 'GET' &&
      (request.headers.get('accept') || '').includes('text/html')
    ) {
      return env.ASSETS.fetch(new URL('/index.html', url.origin));
    }
    return asset;
  },
};
