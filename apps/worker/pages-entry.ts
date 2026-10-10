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
import migration0004 from './migrations/0004_api_token_secret.sql';
import migration0005 from './migrations/0005_current_version.sql';
import migration0006 from './migrations/0006_global_roles.sql';
import migration0007 from './migrations/0007_current_versions.sql';
import migration0008 from './migrations/0008_multiple_files.sql';
import migration0009 from './migrations/0009_version_metadata.sql';
import migration0010 from './migrations/0010_upload_version_notes.sql';
import migration0011 from './migrations/0011_special_version.sql';
import migration0012 from './migrations/0012_announcements.sql';
import migration0013 from './migrations/0013_mail.sql';
import migration0014 from './migrations/0014_api_token_restrictions.sql';
import migration0015 from './migrations/0015_customer_hierarchy.sql';

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
    for (const stmt of [
      ...statements(migration0001),
      ...statements(migration0002),
      ...statements(migration0003),
      ...statements(migration0004),
      ...statements(migration0005),
      ...statements(migration0007),
    ]) {
      await env.DB.prepare(stmt).run();
    }
    await ensureMultipleFiles(env);
    await ensureVersionMetadata(env);
    await ensureUploadVersionNotes(env);
    await ensureSpecialVersion(env);
    await ensureAnnouncements(env);
    await ensureMail(env);
    await ensureTokenRestrictions(env);
    await ensureCustomerHierarchy(env);
    schemaReady = true;
    console.log('[schema] initialized D1 tables on first run');
    return;
  }
  // Existing DB: apply additive post-launch migrations idempotently so a fresh
  // deploy needs zero CLI (same spirit as the bootstrap above). Each step is a
  // no-op once its column exists.
  await ensureColumn(env, 'versions', 'public_slug', statements(migration0003));
  await ensureColumn(env, 'api_tokens', 'token_enc', statements(migration0004));
  await ensureColumn(env, 'projects', 'current_version', statements(migration0005));
  await ensureGlobalRoles(env, statements(migration0006));
  await ensureCurrentVersions(env);
  await ensureMultipleFiles(env);
  await ensureVersionMetadata(env);
  await ensureUploadVersionNotes(env);
  await ensureSpecialVersion(env);
  await ensureAnnouncements(env);
  await ensureMail(env);
  await ensureTokenRestrictions(env);
  await ensureCustomerHierarchy(env);
  schemaReady = true;
}

// Apply an additive column-migration only if the column is missing. ALTER TABLE
// ADD COLUMN rewrites the table's stored schema in sqlite_master, so the column
// name appears there afterwards — that's our idempotency check (no PRAGMA; works
// on D1 + SQLite).
async function ensureColumn(env: PagesEnv, table: string, column: string, stmts: string[]): Promise<void> {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(table)
    .first<{ sql: string }>();
  if (row && typeof row.sql === 'string' && !row.sql.includes(column)) {
    for (const stmt of stmts) await env.DB.prepare(stmt).run();
    console.log(`[schema] added ${table}.${column}`);
  }
}

async function ensureGlobalRoles(env: PagesEnv, stmts: string[]): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_global_roles'",
  ).first();
  if (!row) {
    for (const stmt of stmts) await env.DB.prepare(stmt).run();
    console.log('[schema] added user_global_roles');
  }
}

async function ensureCurrentVersions(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_current_versions'",
  ).first();
  if (!row) {
    await env.DB.batch(statements(migration0007).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added project_current_versions');
  }
}

async function ensureMultipleFiles(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_versions_file'",
  ).first();
  if (!row) {
    // Rebuild and restore dependent references in one atomic transaction.
    await env.DB.batch(statements(migration0008).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] enabled multiple files per version and channel');
  }
}

async function ensureVersionMetadata(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'version_metadata'",
  ).first();
  if (!row) {
    await env.DB.batch(statements(migration0009).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added independent version notes');
  }
}

async function ensureUploadVersionNotes(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'upload_sessions'")
    .first<{ sql: string }>();
  if (row && !row.sql.includes('has_version_notes')) {
    await env.DB.batch(statements(migration0010).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added upload version notes');
  }
}

async function ensureSpecialVersion(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'upload_sessions'")
    .first<{ sql: string }>();
  if (row && !row.sql.includes('has_special_version')) {
    await env.DB.batch(statements(migration0011).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added optional special version');
  }
}

async function ensureAnnouncements(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'announcements'").first();
  if (!row) {
    await env.DB.batch(statements(migration0012).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added project announcements');
  }
}

async function ensureMail(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mail_settings'").first();
  if (!row) {
    await env.DB.batch(statements(migration0013).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added SMTP settings and announcement notifications');
  }
}

async function ensureTokenRestrictions(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_tokens'").first<{ sql: string }>();
  if (row && !row.sql.includes('special_version')) {
    await env.DB.batch(statements(migration0014).map((stmt) => env.DB.prepare(stmt)));
    console.log('[schema] added API token version restrictions');
  }
}

async function ensureCustomerHierarchy(env: PagesEnv): Promise<void> {
  const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'").first<{ sql: string }>();
  if (row && !row.sql.includes('parent_id')) {
    // This migration contains triggers. Explicit boundaries preserve the
    // semicolons inside BEGIN/END while keeping the upgrade one atomic batch.
    const sql = migration0015.split(/^-- statement-breakpoint\s*$/m).map((statement) => statement.trim()).filter(Boolean);
    await env.DB.batch(sql.map((statement) => env.DB.prepare(statement)));
    console.log('[schema] added customer hierarchy');
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
