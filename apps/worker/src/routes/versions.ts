// Version metadata routes. Upload happens in routes/upload.ts (multipart
// to R2 S3 endpoint directly from browser/CLI). Download URL minting is
// in routes/download.ts. This file is list / get / patch metadata / delete.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, notFound } from '../utils/errors';
import { requireProjectAccess, visibleProjectIds } from '../lib/memberships';
import { makeStorage } from '../lib/s3';
import { audit } from '../lib/audit';
import { base64UrlEncode } from '../utils/encoding';
import { IS_CURRENT_SQL, NOTES_UNLOCKED_SQL, setCurrentVersion, clearUnusedCurrentVersions, syncLegacyCurrentVersion } from '../lib/current-versions';
import { withNotePermissions, requireNotesEdit, requireVersionNotesEdit, VERSION_NOTES_UNLOCKED_SQL, clearUnusedVersionMetadata, normalizeSpecialVersion } from '../lib/version-notes';

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
  can_edit_notes?: boolean;
  version_notes?: string | null;
  special_version?: string | null;
  can_edit_version_notes?: boolean;
  is_mandatory: number;
  is_current: number;
  min_version: string | null;
  max_version: string | null;
  rollout_percentage: number;
  device_group_id: number | null;
  download_count: number;
  public_slug: string | null;
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
    canEditNotes: !!r.can_edit_notes,
    versionNotes: r.version_notes ?? null,
    specialVersion: r.special_version ?? null,
    canEditVersionNotes: !!r.can_edit_version_notes,
    isMandatory: !!r.is_mandatory,
    isCurrent: !!r.is_current,
    minVersion: r.min_version,
    maxVersion: r.max_version,
    rolloutPercentage: r.rollout_percentage,
    deviceGroupId: r.device_group_id,
    downloadCount: r.download_count,
    publicSlug: r.public_slug,
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
  const where: string[] = ['v.project_id = ?'];
  const args: unknown[] = [projectId];
  if (!includePending) {
    where.push(`v.status != 'pending'`);
  }
  if (channel) {
    where.push('v.release_channel = ?');
    args.push(channel);
  }
  const rows = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size, v.sha256, v.content_type, v.notes,
            v.is_mandatory, ${IS_CURRENT_SQL} AS is_current, v.min_version, v.max_version, v.rollout_percentage, v.device_group_id, v.download_count, v.public_slug, v.uploaded_by, v.created_at, v.updated_at
       FROM versions v
       JOIN projects p ON p.id = v.project_id
      WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC`,
  )
    .bind(...args)
    .all<VersionRow>();
  return c.json((await withNotePermissions(c.env.DB, user, rows.results ?? [])).map(versionDto));
});

interface AccessibleRow extends VersionRow {
  project_code: string;
  project_name: string;
  customer_id: number;
  customer_code: string;
  customer_name: string;
}

function accessibleDto(r: AccessibleRow) {
  return {
    ...versionDto(r),
    projectCode: r.project_code,
    projectName: r.project_name,
    customerId: r.customer_id,
    customerCode: r.customer_code,
    customerName: r.customer_name,
  };
}

// Cross-project catalog — every ready version in every project the caller can
// access, in one call ("all the files I'm allowed to download"). Uses the same
// membership visibility as GET /api/projects. Registered before '/:id' so the
// literal path wins.
versionRoutes.get('/accessible', async (c) => {
  const user = c.get('user')!;
  const includeArchived = c.req.query('includeArchived') === '1';
  const visible = await visibleProjectIds(c.env.DB, user); // null = super_admin → all

  const where: string[] = [includeArchived ? `v.status != 'pending'` : `v.status = 'ready'`];
  const args: unknown[] = [];
  if (visible !== null) {
    if (visible.length === 0) return c.json([]);
    where.push('v.project_id IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(visible));
  }
  const rows = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size,
            v.sha256, v.content_type, v.notes, v.is_mandatory, ${IS_CURRENT_SQL} AS is_current, v.min_version, v.max_version,
            v.rollout_percentage, v.device_group_id, v.download_count, v.public_slug,
            v.uploaded_by, v.created_at, v.updated_at,
            p.code AS project_code, p.name AS project_name,
            c.id AS customer_id, c.code AS customer_code, c.name AS customer_name
       FROM versions v
       JOIN projects p ON p.id = v.project_id
       JOIN customers c ON c.id = p.customer_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name ASC, p.name ASC, v.created_at DESC`,
  )
    .bind(...args)
    .all<AccessibleRow>();
  return c.json((await withNotePermissions(c.env.DB, user, rows.results ?? [])).map(accessibleDto));
});

versionRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size, v.sha256, v.content_type, v.notes,
            v.is_mandatory, ${IS_CURRENT_SQL} AS is_current, v.min_version, v.max_version, v.rollout_percentage, v.device_group_id, v.download_count, v.public_slug, v.uploaded_by, v.created_at, v.updated_at
       FROM versions v
       JOIN projects p ON p.id = v.project_id
      WHERE v.id = ?`,
  )
    .bind(id)
    .first<VersionRow>();
  if (!row) throw notFound();
  await requireProjectAccess(c.env.DB, user, row.project_id, 'view');
  return c.json(versionDto((await withNotePermissions(c.env.DB, user, [row]))[0]!));
});

type GroupPatchBody = {
  projectId: number;
  version: string;
  notes?: string | null;
  versionNotes?: string | null;
  specialVersion?: string | null;
  isCurrent?: boolean;
  status?: 'ready' | 'archived';
};

function validateVersionPatch(body: { notes?: string | null; versionNotes?: string | null; isCurrent?: boolean; status?: string }) {
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    throw badRequest('notes must be a string or null');
  }
  if (body.versionNotes !== undefined && body.versionNotes !== null && typeof body.versionNotes !== 'string') {
    throw badRequest('versionNotes must be a string or null');
  }
  if (body.isCurrent !== undefined && typeof body.isCurrent !== 'boolean') {
    throw badRequest('isCurrent must be a boolean');
  }
  if (body.status !== undefined && body.status !== 'ready' && body.status !== 'archived') {
    throw badRequest('status must be ready or archived');
  }
}

// Label-level changes are atomic across all its channels. Literal mutation
// routes precede /:id so "group" is never parsed as an artifact id.
versionRoutes.patch('/group', async (c) => {
  const body = await c.req.json<GroupPatchBody>().catch(() => null);
  if (!body || !Number.isSafeInteger(body.projectId) || body.projectId <= 0) {
    throw badRequest('valid projectId required');
  }
  if (typeof body.version !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(body.version)) {
    throw badRequest('valid version required');
  }
  validateVersionPatch(body);
  if (body.specialVersion !== undefined) body.specialVersion = normalizeSpecialVersion(body.specialVersion);
  const proj = await requireProjectAccess(c.env.DB, c.get('user')!, body.projectId, 'manage_versions');
  const existing = await c.env.DB.prepare(
    `SELECT id, status, project_id, version, uploaded_by FROM versions WHERE project_id = ? AND version = ? AND status != 'pending'`,
  ).bind(body.projectId, body.version).all<{ id: number; status: VersionRow['status']; project_id: number; version: string; uploaded_by: number }>();
  const rows = existing.results ?? [];
  if (rows.length === 0) throw notFound('version not found');
  if (body.notes !== undefined) await requireNotesEdit(c.env.DB, c.get('user')!, rows);
  const editsParent = body.versionNotes !== undefined || body.specialVersion !== undefined;
  const versionCreator = editsParent
    ? await requireVersionNotesEdit(c.env.DB, c.get('user')!, rows[0]!)
    : undefined;
  const editsNotes = body.notes !== undefined || editsParent;
  // If the last file was deleted and this label recreated during validation,
  // a combined request must not act on the new creator's label.
  const creatorGuard = versionCreator === undefined ? '' : `AND EXISTS (
    SELECT 1 FROM version_metadata vm
     WHERE vm.project_id = versions.project_id AND vm.version = versions.version AND vm.created_by = ?
  )`;
  const creatorArgs = versionCreator === undefined ? [] : [versionCreator];
  if (body.isCurrent && (body.status === 'archived' ||
    (body.status !== 'ready' && !rows.some((row) => row.status === 'ready')))) {
    throw badRequest('only ready versions can be current');
  }
  const now = Date.now();
  const changes: D1PreparedStatement[] = [];
  const noteChangeIndexes: number[] = [];
  if (editsParent) {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (body.versionNotes !== undefined) {
      sets.push('notes = ?');
      args.push(body.versionNotes);
    }
    if (body.specialVersion !== undefined) {
      sets.push('special_version = ?');
      args.push(body.specialVersion);
    }
    noteChangeIndexes.push(changes.length);
    changes.push(c.env.DB.prepare(
      `UPDATE version_metadata SET ${sets.join(', ')}, updated_at = ?
        WHERE project_id = ? AND version = ? AND created_by = ? AND ${VERSION_NOTES_UNLOCKED_SQL}`,
    ).bind(...args, now, body.projectId, body.version, versionCreator));
  }
  if (body.notes !== undefined) {
    noteChangeIndexes.push(changes.length);
    changes.push(c.env.DB.prepare(
      `UPDATE versions SET notes = ?, updated_at = ?
        WHERE project_id = ? AND version = ? AND status != 'pending'
          AND id IN (${rows.map(() => '?').join(',')}) AND ${NOTES_UNLOCKED_SQL} ${creatorGuard}`,
    ).bind(body.notes, now, body.projectId, body.version, ...rows.map((row) => row.id), ...creatorArgs));
  }
  if (body.status !== undefined) {
    changes.push(c.env.DB.prepare(
      `UPDATE versions SET status = ?, updated_at = ? WHERE project_id = ? AND version = ? AND status = ?
        ${editsNotes ? `AND ${NOTES_UNLOCKED_SQL}` : ''} ${creatorGuard}`,
    ).bind(body.status, now, body.projectId, body.version, body.status === 'archived' ? 'ready' : 'archived', ...creatorArgs));
  }
  if (body.isCurrent !== undefined) {
    changes.push(setCurrentVersion(c.env.DB, body.projectId, body.version, body.isCurrent, editsNotes, versionCreator));
  }
  if (changes.length) {
    changes.push(clearUnusedCurrentVersions(c.env.DB, body.projectId));
    changes.push(syncLegacyCurrentVersion(c.env.DB, body.projectId, now));
    const result = await c.env.DB.batch(changes);
    if (noteChangeIndexes.some((index) => result[index]?.meta.changes === 0)) {
      throw conflict('version changed; cancel current usage before editing notes');
    }
    await audit(c, {
      action: 'version.group.update', customerId: proj.customer_id, projectId: body.projectId,
      targetType: 'version', meta: { version: body.version, fields: Object.keys(body).filter((key) => key !== 'projectId' && key !== 'version') },
    });
  }
  const updated = await c.env.DB.prepare(
    `SELECT v.*, ${IS_CURRENT_SQL} AS is_current FROM versions v
      WHERE v.project_id = ? AND v.version = ? ORDER BY v.created_at DESC, v.id DESC`,
  ).bind(body.projectId, body.version).all<VersionRow>();
  return c.json((await withNotePermissions(c.env.DB, c.get('user')!, updated.results ?? [])).map(versionDto));
});

versionRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const existing = await c.env.DB.prepare('SELECT project_id, version, status, uploaded_by FROM versions WHERE id = ?')
    .bind(id)
    .first<{ project_id: number; version: string; status: VersionRow['status']; uploaded_by: number }>();
  if (!existing) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, user, existing.project_id, 'manage_versions');
  type PatchBody = {
    notes?: string | null;
    isMandatory?: boolean;
    minVersion?: string | null;
    maxVersion?: string | null;
    rolloutPercentage?: number;
    isCurrent?: boolean;
    status?: 'ready' | 'archived';
  };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  validateVersionPatch(body);
  if (body.notes !== undefined) await requireNotesEdit(c.env.DB, user, [existing]);
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
    if (existing.status === 'pending') throw badRequest('pending uploads cannot be archived or restored');
    sets.push('status = ?');
    args.push(body.status);
  }
  if (body.isCurrent !== undefined) {
    const nextStatus = body.status ?? existing.status;
    if (body.isCurrent && nextStatus !== 'ready') throw badRequest('only ready versions can be current');
  }
  const now = Date.now();
  const changes: D1PreparedStatement[] = [];
  if (sets.length) {
    sets.push('updated_at = ?');
    args.push(now, id);
    changes.push(c.env.DB.prepare(
      `UPDATE versions SET ${sets.join(', ')} WHERE id = ? ${body.notes !== undefined ? `AND ${NOTES_UNLOCKED_SQL}` : ''}`,
    ).bind(...args));
  }
  if (body.isCurrent !== undefined) {
    changes.push(setCurrentVersion(c.env.DB, existing.project_id, existing.version, body.isCurrent, body.notes !== undefined));
  }
  if (changes.length) {
    changes.push(clearUnusedCurrentVersions(c.env.DB, existing.project_id));
    changes.push(syncLegacyCurrentVersion(c.env.DB, existing.project_id, now));
    const result = await c.env.DB.batch(changes);
    if (body.notes !== undefined && result[0]?.meta.changes === 0) {
      throw conflict('version changed; cancel current usage before editing notes');
    }
  }
  await audit(c, {
    action: 'version.update',
    customerId: proj.customer_id,
    projectId: existing.project_id,
    targetType: 'version',
    targetId: id,
    meta: { fields: Object.keys(body) },
  });
  const row = await c.env.DB.prepare(
    `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size, v.sha256, v.content_type, v.notes,
            v.is_mandatory, ${IS_CURRENT_SQL} AS is_current, v.min_version, v.max_version, v.rollout_percentage, v.device_group_id, v.download_count, v.public_slug, v.uploaded_by, v.created_at, v.updated_at
       FROM versions v
       JOIN projects p ON p.id = v.project_id
      WHERE v.id = ?`,
  )
    .bind(id)
    .first<VersionRow>();
  return c.json(versionDto((await withNotePermissions(c.env.DB, user, [row!]))[0]!));
});

// Enable token-less public download for a version: mints an unguessable
// capability slug. Idempotent — returns the existing slug if already public.
// The slug is consumed by the public route in routes/public.ts.
versionRoutes.post('/:id/public', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id, public_slug FROM versions WHERE id = ?')
    .bind(id)
    .first<{ project_id: number; public_slug: string | null }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, user, row.project_id, 'manage_versions');
  let slug = row.public_slug;
  if (!slug) {
    slug = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    await c.env.DB.prepare('UPDATE versions SET public_slug = ?, updated_at = ? WHERE id = ?')
      .bind(slug, Date.now(), id)
      .run();
    await audit(c, {
      action: 'version.public.enable',
      customerId: proj.customer_id,
      projectId: row.project_id,
      targetType: 'version',
      targetId: id,
    });
  }
  return c.json({ publicSlug: slug });
});

// Revoke public access — the previously shared link / QR stops working.
versionRoutes.delete('/:id/public', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id, public_slug FROM versions WHERE id = ?')
    .bind(id)
    .first<{ project_id: number; public_slug: string | null }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, user, row.project_id, 'manage_versions');
  if (row.public_slug) {
    await c.env.DB.prepare('UPDATE versions SET public_slug = NULL, updated_at = ? WHERE id = ?')
      .bind(Date.now(), id)
      .run();
    await audit(c, {
      action: 'version.public.disable',
      customerId: proj.customer_id,
      projectId: row.project_id,
      targetType: 'version',
      targetId: id,
    });
  }
  return c.json({ ok: true });
});

versionRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id, version, r2_key FROM versions WHERE id = ?')
    .bind(id)
    .first<{ project_id: number; version: string; r2_key: string }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_versions');
  const s3 = makeStorage(c.env);
  try {
    await s3.deleteObject(row.r2_key);
  } catch (e) {
    console.warn('[versions.delete] R2 delete failed (will still drop metadata):', e);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM versions WHERE id = ?').bind(id),
    clearUnusedVersionMetadata(c.env.DB, row.project_id, row.version),
    clearUnusedCurrentVersions(c.env.DB, row.project_id),
    syncLegacyCurrentVersion(c.env.DB, row.project_id, Date.now()),
  ]);
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
