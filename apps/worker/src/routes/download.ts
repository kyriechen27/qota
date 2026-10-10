// Download endpoints.
//
// Users (admin/dev/viewer):
//   POST /api/download/grant {versionId}
//     → { url, expiresAt, filename, size, sha256 }
//     The URL is a R2 presigned GET (TTL ~5min) for the file. Worker
//     records the grant in audit_logs.
//
// Devices (Bearer <api_token>):
//   GET /api/download/device/latest?channel=stable
//     → 302 redirect to the presigned URL (or JSON when ?format=json)
//   GET /api/download/device/version/:id
//     → 302 redirect

import { Hono, type Context } from 'hono';
import { IS_CURRENT_SQL } from '../lib/current-versions';
import type { AppEnv, AuthedApiToken } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, forbidden, notFound, unauthorized } from '../utils/errors';
import { requireProjectAccess } from '../lib/memberships';
import { makeStorage } from '../lib/s3';
import { audit } from '../lib/audit';
import { resolveApiToken } from './api-tokens';
import { downloadRestrictions, tokenVersionFilter } from '../lib/token-restrictions';

export const downloadRoutes = new Hono<AppEnv>();

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

// ============================================================
// User download grant
// ============================================================
downloadRoutes.post('/grant', requireUser, async (c) => {
  const me = c.get('user')!;
  type Body = { versionId?: number };
  const body = (await c.req.json<Body>().catch(() => ({} as Body))) as Body;
  if (!body.versionId) throw badRequest('versionId required');

  const row = await c.env.DB.prepare(
    `SELECT id, project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type
       FROM versions WHERE id = ?`,
  )
    .bind(body.versionId)
    .first<VersionRow>();
  if (!row) throw notFound();
  if (row.status !== 'ready') throw badRequest(`version is ${row.status}, not ready`);
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'download');

  const ttl = Number(c.env.DOWNLOAD_URL_TTL_SECONDS) || 300;
  const s3 = makeStorage(c.env);
  const url = await s3.signGetUrl(row.r2_key, ttl, {
    filename: row.filename,
    contentType: row.content_type ?? undefined,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE versions SET download_count = download_count + 1 WHERE id = ?').bind(row.id).run(),
  );

  await audit(c, {
    action: 'version.download.grant',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'version',
    targetId: row.id,
    meta: { channel: row.release_channel, version: row.version, ttl },
  });

  return c.json({
    url,
    expiresAt,
    filename: row.filename,
    size: row.size,
    sha256: row.sha256,
  });
});

// ============================================================
// Device download — Bearer <api_token>
// ============================================================
async function authDevice(c: Context<AppEnv>) {
  const auth = c.req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) throw unauthorized();
  const token = auth.slice('Bearer '.length).trim();
  const apiToken = await resolveApiToken(c, token);
  if (apiToken.scope !== 'download' && apiToken.scope !== 'full') {
    throw forbidden('token scope does not allow download');
  }
  c.set('apiToken', apiToken);
  return apiToken;
}

function deviceVersionFilter(c: Context<AppEnv>, token: AuthedApiToken, latest = false) {
  const restrictions = downloadRestrictions(token, c.req.query(), latest);
  const filter = tokenVersionFilter(token.projectId, restrictions);
  const filename = c.req.query('filename');
  if (filename !== undefined) {
    filter.sql += ' AND v.filename = ?';
    filter.args.push(filename);
  }
  return { ...filter, restrictions };
}

async function redirectOrJson(c: Context<AppEnv>, row: VersionRow, ttl: number) {
  const s3 = makeStorage(c.env);
  const url = await s3.signGetUrl(row.r2_key, ttl, {
    filename: row.filename,
    contentType: row.content_type ?? undefined,
  });

  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE versions SET download_count = download_count + 1 WHERE id = ?').bind(row.id).run(),
  );

  // Audit (also records IP/UA via audit helper)
  const project = await c.env.DB.prepare('SELECT customer_id FROM projects WHERE id = ?')
    .bind(row.project_id)
    .first<{ customer_id: number }>();
  await audit(c, {
    action: 'version.download.device',
    customerId: project?.customer_id ?? null,
    projectId: row.project_id,
    targetType: 'version',
    targetId: row.id,
    meta: { channel: row.release_channel, version: row.version },
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
}

downloadRoutes.get('/device/latest', async (c) => {
  const dev = await authDevice(c);
  const filter = deviceVersionFilter(c, dev, true);

  // Optionally verify customer/project codes match
  const customerCode = c.req.query('customer');
  const projectCode = c.req.query('project');
  if (customerCode || projectCode) {
    const p = await c.env.DB.prepare(
      `SELECT p.id, p.code AS p_code, c.code AS c_code FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`,
    )
      .bind(dev.projectId)
      .first<{ id: number; p_code: string; c_code: string }>();
    if (!p) throw notFound();
    if (customerCode && p.c_code !== customerCode) throw forbidden('customer mismatch');
    if (projectCode && p.p_code !== projectCode) throw forbidden('project mismatch');
  }

  const row = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size, v.sha256, v.content_type
       FROM versions v
      WHERE ${filter.sql} AND v.status = 'ready'
      ORDER BY ${IS_CURRENT_SQL} DESC, v.created_at DESC, v.id DESC LIMIT 1`,
  )
    .bind(...filter.args)
    .first<VersionRow>();
  if (!row) throw notFound('no ready versions match this token and the requested filters');

  const ttl = Number(c.env.DOWNLOAD_URL_TTL_SECONDS) || 300;
  return redirectOrJson(c, row, ttl);
});

// List every ready version this token can pull (the intersection of every
// restriction). Lets a device/CI enumerate all available files, then
// fetch any via /device/version/:id. Bearer <api_token>.
downloadRoutes.get('/device/list', async (c) => {
  const dev = await authDevice(c);
  const filter = deviceVersionFilter(c, dev);
  const rows = await c.env.DB.prepare(
    `SELECT v.id, v.version, v.release_channel, v.filename, v.size, v.sha256, v.content_type, v.is_mandatory,
            ${IS_CURRENT_SQL} AS is_current, v.created_at
      FROM versions v
      JOIN projects p ON p.id = v.project_id
      WHERE ${filter.sql} AND v.status = 'ready'
      ORDER BY is_current DESC, v.created_at DESC, v.id DESC`,
  )
    .bind(...filter.args)
    .all<{
      id: number;
      version: string;
      release_channel: string;
      filename: string;
      size: number;
      sha256: string | null;
      content_type: string | null;
      is_mandatory: number;
      is_current: number;
      created_at: number;
    }>();
  const proj = await c.env.DB.prepare(
    `SELECT p.code AS p_code, p.name AS p_name, c.code AS c_code, c.name AS c_name
       FROM projects p JOIN customers c ON c.id = p.customer_id WHERE p.id = ?`,
  )
    .bind(dev.projectId)
    .first<{ p_code: string; p_name: string; c_code: string; c_name: string }>();

  const versions = (rows.results ?? []).map((r) => ({
    id: r.id,
    version: r.version,
    channel: r.release_channel,
    filename: r.filename,
    size: r.size,
    sha256: r.sha256,
    contentType: r.content_type,
    isMandatory: !!r.is_mandatory,
    isCurrent: !!r.is_current,
    createdAt: r.created_at,
    download: `/api/download/device/version/${r.id}`,
  }));
  return c.json({
    project: {
      id: dev.projectId,
      code: proj?.p_code ?? null,
      name: proj?.p_name ?? null,
      customerCode: proj?.c_code ?? null,
      customerName: proj?.c_name ?? null,
    },
    channel: filter.restrictions.channel,
    specialVersion: filter.restrictions.specialVersion,
    version: filter.restrictions.version,
    versionId: filter.restrictions.versionId,
    count: versions.length,
    versions,
  });
});

downloadRoutes.get('/device/version/:id', async (c) => {
  const rawId = c.req.param('id');
  const id = Number(rawId);
  if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id <= 0) throw badRequest('invalid id');
  const dev = await authDevice(c);
  const filter = deviceVersionFilter(c, dev);
  const row = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size, v.sha256, v.content_type
       FROM versions v WHERE v.id = ? AND ${filter.sql}`,
  )
    .bind(id, ...filter.args)
    .first<VersionRow>();
  if (!row) {
    // Keep existing 403/404 semantics without ever signing an excluded file.
    const exists = await c.env.DB.prepare('SELECT id FROM versions WHERE id = ?').bind(id).first();
    if (!exists) throw notFound();
    throw forbidden('file not allowed for this token or the requested filters');
  }
  if (row.status !== 'ready') throw badRequest(`version is ${row.status}, not ready`);
  const ttl = Number(c.env.DOWNLOAD_URL_TTL_SECONDS) || 300;
  return redirectOrJson(c, row, ttl);
});
