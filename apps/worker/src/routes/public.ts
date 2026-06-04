// Public, token-less download links.
//
// A version can be made publicly downloadable (POST /api/versions/:id/public),
// which mints an unguessable `public_slug`. This route resolves that slug to a
// fresh, short-lived storage URL and 302-redirects to it — so a printed/shared
// QR code keeps working indefinitely (until revoked) even though each underlying
// signed URL is short-lived. There is intentionally NO public upload: this group
// is GET-only and requires no auth (the slug itself is the capability).

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { notFound } from '../utils/errors';
import { makeStorage } from '../lib/s3';
import { audit } from '../lib/audit';

export const publicRoutes = new Hono<AppEnv>();

interface VersionRow {
  id: number;
  project_id: number;
  version: string;
  release_channel: string;
  status: 'pending' | 'ready' | 'archived';
  r2_key: string;
  filename: string;
  size: number;
  sha256: string | null;
  content_type: string | null;
}

// GET /api/public/download/:slug  → 302 to the artifact (or JSON with ?format=json)
publicRoutes.get('/download/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!slug) throw notFound();

  const row = await c.env.DB.prepare(
    `SELECT id, project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type
       FROM versions WHERE public_slug = ?`,
  )
    .bind(slug)
    .first<VersionRow>();
  // One opaque 404 whether the slug is unknown, revoked (NULL), or the version
  // isn't ready — don't leak which versions exist or their state.
  if (!row || row.status !== 'ready') throw notFound();

  const ttl = Number(c.env.DOWNLOAD_URL_TTL_SECONDS) || 300;
  const s3 = makeStorage(c.env);
  const url = await s3.signGetUrl(row.r2_key, ttl, {
    filename: row.filename,
    contentType: row.content_type ?? undefined,
  });

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE versions SET download_count = download_count + 1 WHERE id = ?').bind(row.id).run(),
  );

  const project = await c.env.DB.prepare('SELECT customer_id FROM projects WHERE id = ?')
    .bind(row.project_id)
    .first<{ customer_id: number }>();
  await audit(c, {
    action: 'version.download.public',
    actorType: 'system',
    customerId: project?.customer_id ?? null,
    projectId: row.project_id,
    targetType: 'version',
    targetId: row.id,
    meta: { channel: row.release_channel, version: row.version, slug },
  });

  if (c.req.query('format') === 'json') {
    return c.json({
      url,
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
      versionId: row.id,
      version: row.version,
      channel: row.release_channel,
      filename: row.filename,
      size: row.size,
      sha256: row.sha256,
    });
  }
  return c.redirect(url, 302);
});
