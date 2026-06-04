// Version metadata routes. Upload happens in routes/upload.ts (multipart
// to R2 S3 endpoint directly from browser/CLI). Download URL minting is
// in routes/download.ts. This file is list / get / patch metadata / delete.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, notFound } from '../utils/errors';
import { requireProjectAccess } from '../lib/memberships';
import { makeStorage } from '../lib/s3';
import { audit } from '../lib/audit';

export const versionRoutes = new Hono<AppEnv>();

versionRoutes.use('*', requireUser);

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
  notes: string | null;
  is_mandatory: number;
  min_version: string | null;
  max_version: string | null;
  rollout_percentage: number;
  device_group_id: number | null;
  download_count: number;
  uploaded_by: number;
  created_at: number;
  updated_at: number;
}

export function versionDto(r: VersionRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    version: r.version,
    releaseChannel: r.release_channel,
    status: r.status,
    r2Key: r.r2_key,
    filename: r.filename,
    size: r.size,
    sha256: r.sha256,
    contentType: r.content_type,
    notes: r.notes,
    isMandatory: !!r.is_mandatory,
    minVersion: r.min_version,
    maxVersion: r.max_version,
    rolloutPercentage: r.rollout_percentage,
    deviceGroupId: r.device_group_id,
    downloadCount: r.download_count,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

versionRoutes.get('/', async (c) => {
  const projectIdQ = c.req.query('projectId');
  if (!projectIdQ) throw badRequest('projectId required');
  const projectId = Number(projectIdQ);
  if (!Number.isFinite(projectId)) throw badRequest('invalid projectId');
  const user = c.get('user')!;
  await requireProjectAccess(c.env.DB, user, projectId, 'view');
  const includePending = c.req.query('includePending') === '1';
  const channel = c.req.query('channel');
  const where: string[] = ['project_id = ?'];
  const args: unknown[] = [projectId];
  if (!includePending) {
    where.push(`status != 'pending'`);
  }
  if (channel) {
    where.push('release_channel = ?');
    args.push(channel);
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type, notes,
            is_mandatory, min_version, max_version, rollout_percentage, device_group_id, download_count, uploaded_by, created_at, updated_at
       FROM versions WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
  )
    .bind(...args)
    .all<VersionRow>();
  return c.json((rows.results ?? []).map(versionDto));
});

versionRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT id, project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type, notes,
            is_mandatory, min_version, max_version, rollout_percentage, device_group_id, download_count, uploaded_by, created_at, updated_at
       FROM versions WHERE id = ?`,
  )
    .bind(id)
    .first<VersionRow>();
  if (!row) throw notFound();
  await requireProjectAccess(c.env.DB, user, row.project_id, 'view');
  return c.json(versionDto(row));
});

versionRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const existing = await c.env.DB.prepare('SELECT project_id FROM versions WHERE id = ?')
    .bind(id)
    .first<{ project_id: number }>();
  if (!existing) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, user, existing.project_id, 'manage_versions');
  type PatchBody = {
    notes?: string | null;
    isMandatory?: boolean;
    minVersion?: string | null;
    maxVersion?: string | null;
    rolloutPercentage?: number;
    status?: 'ready' | 'archived';
  };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.notes !== undefined) {
    sets.push('notes = ?');
    args.push(body.notes);
  }
  if (body.isMandatory !== undefined) {
    sets.push('is_mandatory = ?');
    args.push(body.isMandatory ? 1 : 0);
  }
  if (body.minVersion !== undefined) {
    sets.push('min_version = ?');
    args.push(body.minVersion);
  }
  if (body.maxVersion !== undefined) {
    sets.push('max_version = ?');
    args.push(body.maxVersion);
  }
  if (body.rolloutPercentage !== undefined) {
    const pct = Math.max(0, Math.min(100, Math.floor(body.rolloutPercentage)));
    sets.push('rollout_percentage = ?');
    args.push(pct);
  }
  if (body.status !== undefined) {
    if (body.status !== 'ready' && body.status !== 'archived') throw badRequest('status must be ready or archived');
    sets.push('status = ?');
    args.push(body.status);
  }
  if (sets.length === 0) return c.json({ ok: true });
  sets.push('updated_at = ?');
  args.push(Date.now());
  args.push(id);
  await c.env.DB.prepare(`UPDATE versions SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  await audit(c, {
    action: 'version.update',
    customerId: proj.customer_id,
    projectId: existing.project_id,
    targetType: 'version',
    targetId: id,
    meta: { fields: Object.keys(body) },
  });
  const row = await c.env.DB.prepare(
    `SELECT id, project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type, notes,
            is_mandatory, min_version, max_version, rollout_percentage, device_group_id, download_count, uploaded_by, created_at, updated_at
       FROM versions WHERE id = ?`,
  )
    .bind(id)
    .first<VersionRow>();
  return c.json(versionDto(row!));
});

versionRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id, r2_key FROM versions WHERE id = ?')
    .bind(id)
    .first<{ project_id: number; r2_key: string }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_versions');
  const s3 = makeStorage(c.env);
  try {
    await s3.deleteObject(row.r2_key);
  } catch (e) {
    console.warn('[versions.delete] R2 delete failed (will still drop metadata):', e);
  }
  await c.env.DB.prepare('DELETE FROM versions WHERE id = ?').bind(id).run();
  await audit(c, {
    action: 'version.delete',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'version',
    targetId: id,
    meta: { r2Key: row.r2_key },
  });
  return c.json({ ok: true });
});
