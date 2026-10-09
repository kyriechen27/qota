// Multipart upload orchestration.
//
// Flow (called from browser/CLI):
//   POST /api/upload/init       → opens R2 multipart, returns sessionId/uploadId/partSize
//   POST /api/upload/sign-part  → returns a presigned PUT URL for one part
//   POST /api/upload/complete   → finalizes upload, creates ready version row
//   POST /api/upload/abort      → aborts multipart, marks session aborted
//
//   GET  /api/upload/sessions?projectId=N   → list in-progress sessions (for resume)
//   GET  /api/upload/sessions/:id           → session detail + uploaded parts

import { Hono } from 'hono';
import type { AppEnv, AuthedUser } from '../env';
import type { D1Database } from '@cloudflare/workers-types';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { requireProjectAccess } from '../lib/memberships';
import { makeStorage, type StorageBackend } from '../lib/s3';
import { audit } from '../lib/audit';
import { versionDto } from './versions';
import { IS_CURRENT_SQL } from '../lib/current-versions';
import { requireNotesEdit, withNotePermissions } from '../lib/version-notes';

export const uploadRoutes = new Hono<AppEnv>();

uploadRoutes.use('*', requireUser);

const VERSION_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const DEFAULT_PART_SIZE = 16 * 1024 * 1024; // 16 MB
const MIN_PART_SIZE = 5 * 1024 * 1024;       // S3 spec floor (last part may be smaller)
const MAX_PART_SIZE = 64 * 1024 * 1024;      // 64 MB cap
const MAX_PARTS = 10_000;

function clampPartSize(hint: number | undefined, totalSize: number): number {
  let p = hint && hint > 0 ? hint : DEFAULT_PART_SIZE;
  p = Math.max(MIN_PART_SIZE, Math.min(MAX_PART_SIZE, p));
  // Ensure part_count fits under MAX_PARTS
  const minByCount = Math.ceil(totalSize / MAX_PARTS);
  if (minByCount > p) p = Math.min(MAX_PART_SIZE, minByCount);
  return p;
}

function r2KeyFor(customerCode: string, projectCode: string, channel: string, version: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 160) || 'file';
  // Each upload owns its object. Equal/sanitized filenames and concurrent
  // replacements must never overwrite an object still served by a version.
  return `${customerCode}/${projectCode}/${channel}/${version}/${crypto.randomUUID()}/${safe}`;
}

async function deleteObjectBestEffort(storage: StorageBackend, key: string) {
  try {
    await storage.deleteObject(key);
  } catch (e) {
    console.warn('[upload.complete] old object delete failed:', e);
  }
}

interface SessionRow {
  id: number;
  project_id: number;
  version_id: number | null;
  r2_key: string;
  filename: string;
  total_size: number;
  part_size: number;
  upload_id: string;
  expected_sha256: string | null;
  release_channel: string;
  target_version: string;
  content_type: string | null;
  notes: string | null;
  version_notes: string | null;
  has_version_notes: number;
  is_mandatory: number;
  min_version: string | null;
  max_version: string | null;
  rollout_percentage: number;
  status: 'in_progress' | 'completed' | 'aborted' | 'failed';
  initiated_by: number;
  created_at: number;
  completed_at: number | null;
}

function sessionDto(r: SessionRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    versionId: r.version_id,
    r2Key: r.r2_key,
    filename: r.filename,
    totalSize: r.total_size,
    partSize: r.part_size,
    uploadId: r.upload_id,
    expectedSha256: r.expected_sha256,
    releaseChannel: r.release_channel,
    targetVersion: r.target_version,
    contentType: r.content_type,
    notes: r.notes,
    ...(r.has_version_notes ? { versionNotes: r.version_notes } : {}),
    isMandatory: !!r.is_mandatory,
    minVersion: r.min_version,
    maxVersion: r.max_version,
    rolloutPercentage: r.rollout_percentage,
    status: r.status,
    initiatedBy: r.initiated_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

async function uploadNotesPermission(
  db: D1Database, user: AuthedUser, projectId: number, version: string,
  hasVersionNotes: boolean, versionNotes: string | null,
  uploadedBy = user.id,
) {
  const [permission] = await withNotePermissions(db, user, [
    { project_id: projectId, version, uploaded_by: uploadedBy },
  ]);
  if (hasVersionNotes && permission!.version_notes !== versionNotes) {
    if (permission!.notes_locked) throw conflict('cancel current usage before editing version notes');
    if (permission!.version_notes_creator !== null && !permission!.can_edit_version_notes) {
      throw forbidden('only the version creator or an administrator can edit version notes');
    }
  }
  return permission!;
}

// ============================================================
// POST /api/upload/init
// ============================================================
uploadRoutes.post('/init', async (c) => {
  const me = c.get('user')!;
  type InitBody = {
    projectId?: number;
    filename?: string;
    totalSize?: number;
    contentType?: string | null;
    version?: string;
    releaseChannel?: string;
    notes?: string | null;
    versionNotes?: string | null;
    isMandatory?: boolean;
    minVersion?: string | null;
    maxVersion?: string | null;
    rolloutPercentage?: number;
    overwriteExisting?: boolean;
    expectedSha256?: string;
    partSizeHint?: number;
  };
  const body = (await c.req.json<InitBody>().catch(() => ({} as InitBody))) as InitBody;

  if (!body.projectId) throw badRequest('projectId required');
  if (typeof body.filename !== 'string' || !body.filename || body.filename.includes('\0')) {
    throw badRequest('filename required');
  }
  if (!Number.isFinite(body.totalSize) || (body.totalSize ?? 0) <= 0) {
    throw badRequest('totalSize must be a positive integer');
  }
  if (!body.version || !VERSION_RE.test(body.version)) {
    throw badRequest('version must match [A-Za-z0-9._+-], 1-64 chars');
  }
  const channel = body.releaseChannel || 'stable';
  if (!CHANNEL_RE.test(channel)) throw badRequest('releaseChannel invalid');
  if (body.expectedSha256 && !SHA256_RE.test(body.expectedSha256)) {
    throw badRequest('expectedSha256 must be hex sha-256');
  }
  if (body.rolloutPercentage !== undefined) {
    const v = Number(body.rolloutPercentage);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw badRequest('rolloutPercentage 0..100');
  }

  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    throw badRequest('notes must be a string or null');
  }
  if (body.versionNotes !== undefined && body.versionNotes !== null && typeof body.versionNotes !== 'string') {
    throw badRequest('versionNotes must be a string or null');
  }
  const project = await requireProjectAccess(c.env.DB, me, body.projectId, 'upload');
  const customer = await c.env.DB.prepare('SELECT code FROM customers WHERE id = ?')
    .bind(project.customer_id)
    .first<{ code: string }>();
  if (!customer) throw notFound('customer not found');

  const existing = await c.env.DB.prepare(
    `SELECT id, r2_key, project_id, version, notes, uploaded_by FROM versions
      WHERE project_id = ? AND version = ? AND release_channel = ? AND filename = ?`,
  )
    .bind(body.projectId, body.version, channel, body.filename)
    .first<{ id: number; r2_key: string; project_id: number; version: string; notes: string | null; uploaded_by: number }>();
  if (existing && !body.overwriteExisting) throw conflict('filename already exists for this version and channel');
  const notes = body.notes === undefined ? existing?.notes ?? null : body.notes;
  if (existing && existing.notes !== notes) await requireNotesEdit(c.env.DB, me, [existing]);
  await uploadNotesPermission(c.env.DB, me, body.projectId, body.version,
    body.versionNotes !== undefined, body.versionNotes ?? null);

  const totalSize = body.totalSize!;
  const partSize = clampPartSize(body.partSizeHint, totalSize);
  const partCount = Math.ceil(totalSize / partSize);
  if (partCount > MAX_PARTS) throw badRequest('too many parts; increase partSizeHint');

  const key = r2KeyFor(customer.code, project.code, channel, body.version, body.filename);
  const s3 = makeStorage(c.env);
  const uploadId = await s3.createMultipartUpload(key, body.contentType || 'application/octet-stream');

  const now = Date.now();
  const r = await c.env.DB.prepare(
    `INSERT INTO upload_sessions
       (project_id, r2_key, filename, total_size, part_size, upload_id, expected_sha256, release_channel,
        target_version, content_type, notes, version_notes, has_version_notes, is_mandatory, min_version, max_version, rollout_percentage, version_id,
        status, initiated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
  )
    .bind(
      body.projectId,
      key,
      body.filename,
      totalSize,
      partSize,
      uploadId,
      body.expectedSha256 ?? null,
      channel,
      body.version,
      body.contentType ?? null,
      notes,
      body.versionNotes ?? null,
      body.versionNotes === undefined ? 0 : 1,
      body.isMandatory ? 1 : 0,
      body.minVersion ?? null,
      body.maxVersion ?? null,
      body.rolloutPercentage === undefined ? 100 : Math.floor(body.rolloutPercentage),
      existing?.id ?? null,
      me.id,
      now,
    )
    .run();
  const sessionId = Number(r.meta.last_row_id);

  await audit(c, {
    action: 'version.upload.init',
    customerId: project.customer_id,
    projectId: body.projectId,
    targetType: 'upload_session',
    targetId: sessionId,
    meta: { key, totalSize, partSize, partCount, version: body.version, channel, overwriteVersionId: existing?.id },
  });

  return c.json({
    sessionId,
    uploadId,
    key,
    partSize,
    partCount,
    uploadedParts: [],
  });
});

// ============================================================
// POST /api/upload/sign-part
// ============================================================
uploadRoutes.post('/sign-part', async (c) => {
  const me = c.get('user')!;
  type Body = { sessionId?: number; partNumber?: number };
  const body = (await c.req.json<Body>().catch(() => ({} as Body))) as Body;
  if (!body.sessionId || !body.partNumber) throw badRequest('sessionId and partNumber required');
  const session = await c.env.DB.prepare(
    `SELECT id, project_id, r2_key, upload_id, status, total_size, part_size FROM upload_sessions WHERE id = ?`,
  )
    .bind(body.sessionId)
    .first<{
      id: number;
      project_id: number;
      r2_key: string;
      upload_id: string;
      status: string;
      total_size: number;
      part_size: number;
    }>();
  if (!session) throw notFound('session not found');
  if (session.status !== 'in_progress') throw badRequest(`session not in_progress (status=${session.status})`);
  await requireProjectAccess(c.env.DB, me, session.project_id, 'upload');

  const partCount = Math.ceil(session.total_size / session.part_size);
  if (body.partNumber < 1 || body.partNumber > partCount) {
    throw badRequest(`partNumber must be 1..${partCount}`);
  }
  const ttl = Number(c.env.UPLOAD_PART_URL_TTL_SECONDS) || 600;
  const s3 = makeStorage(c.env);
  const url = await s3.signPartUrl(session.r2_key, session.upload_id, body.partNumber, ttl);
  return c.json({ url, expiresAt: Math.floor(Date.now() / 1000) + ttl });
});

// ============================================================
// POST /api/upload/complete
// ============================================================
uploadRoutes.post('/complete', async (c) => {
  const me = c.get('user')!;
  type Body = {
    sessionId?: number;
    parts?: { partNumber: number; etag: string; size: number }[];
    sha256?: string;
  };
  const body = (await c.req.json<Body>().catch(() => ({} as Body))) as Body;
  if (!body.sessionId || !body.parts || !Array.isArray(body.parts) || body.parts.length === 0) {
    throw badRequest('sessionId and parts[] required');
  }
  if (body.sha256 && !SHA256_RE.test(body.sha256)) throw badRequest('sha256 must be hex');
  const session = await c.env.DB.prepare(
    `SELECT * FROM upload_sessions WHERE id = ?`,
  )
    .bind(body.sessionId)
    .first<SessionRow>();
  if (!session) throw notFound('session not found');
  if (session.status !== 'in_progress') {
    throw badRequest(`session not in_progress (status=${session.status})`);
  }
  const project = await requireProjectAccess(c.env.DB, me, session.project_id, 'upload');
  if (session.expected_sha256 && body.sha256 && session.expected_sha256.toLowerCase() !== body.sha256.toLowerCase()) {
    throw badRequest('sha256 mismatch with init expectedSha256');
  }

  // Recheck on completion: current usage and permissions may have changed
  // since initialization. Deny changed notes before completing the object.
  const overwriteTarget = session.version_id ? await c.env.DB.prepare(
    'SELECT project_id, version, notes, uploaded_by FROM versions WHERE id = ? AND project_id = ?',
  ).bind(session.version_id, session.project_id)
    .first<{ project_id: number; version: string; notes: string | null; uploaded_by: number }>() : null;
  if (session.version_id && !overwriteTarget) throw conflict('overwrite target version no longer exists');
  if (overwriteTarget && overwriteTarget.notes !== session.notes) {
    await requireNotesEdit(c.env.DB, me, [overwriteTarget]);
  }
  await uploadNotesPermission(c.env.DB, me, session.project_id, session.target_version,
    !!session.has_version_notes, session.version_notes);

  const s3 = makeStorage(c.env);
  let completeRes: { etag: string };
  try {
    completeRes = await s3.completeMultipartUpload(
      session.r2_key,
      session.upload_id,
      body.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );
  } catch (e) {
    await c.env.DB.prepare('UPDATE upload_sessions SET status = ? WHERE id = ?')
      .bind('failed', session.id)
      .run();
    await audit(c, {
      action: 'version.upload.failed',
      customerId: project.customer_id,
      projectId: session.project_id,
      targetType: 'upload_session',
      targetId: session.id,
      meta: { error: String(e) },
    });
    throw e;
  }

  try {
    // Record parts (best-effort idempotent)
    const now = Date.now();
    for (const p of body.parts) {
      await c.env.DB.prepare(
        `INSERT OR REPLACE INTO upload_parts (session_id, part_number, etag, size, uploaded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(session.id, p.partNumber, p.etag, p.size, now)
        .run();
    }

    // Verify R2 object exists and get authoritative size
    const head = await s3.headObject(session.r2_key);
    if (!head) throw conflict('object missing after complete');
    if (head.size !== session.total_size) {
      // Don't fail the request: R2 sometimes reports a slightly different content-length
      // header during eventual consistency, but record a warning in audit.
      console.warn('[upload.complete] size mismatch', { expected: session.total_size, actual: head.size });
    }

    const sha256 = body.sha256 ?? session.expected_sha256 ?? null;
    let versionId = session.version_id ?? 0;
    const existing = session.version_id ? await c.env.DB.prepare('SELECT r2_key, project_id, version, notes, uploaded_by FROM versions WHERE id = ? AND project_id = ?')
        .bind(session.version_id, session.project_id)
        .first<{ r2_key: string; project_id: number; version: string; notes: string | null; uploaded_by: number }>() : null;
    if (session.version_id && !existing) throw conflict('overwrite target version no longer exists');
    if (existing && existing.notes !== session.notes) await requireNotesEdit(c.env.DB, me, [existing]);
    const notesPermission = await uploadNotesPermission(c.env.DB, me, session.project_id, session.target_version,
      !!session.has_version_notes, session.version_notes, existing?.uploaded_by);
    const oldKey = existing?.r2_key ?? null;

    // Both writes use the same live predicate inside one transaction. A
    // competing filename, changed overwrite target or newly current label
    // therefore cannot save parent notes without also publishing this file.
    const unlocked = `NOT EXISTS (
      SELECT 1 FROM project_current_versions WHERE project_id = ? AND version = ?
    )`;
    const guards = [`EXISTS (SELECT 1 FROM upload_sessions WHERE id = ? AND status = 'in_progress')`];
    const guardArgs: unknown[] = [session.id];
    if (existing) {
      guards.push(`EXISTS (
        SELECT 1 FROM versions v WHERE v.id = ? AND v.project_id = ? AND v.uploaded_by = ? AND v.r2_key = ?
          AND (v.notes IS ? OR (? = 1 AND ${unlocked}))
      )`);
      guardArgs.push(session.version_id, session.project_id, existing.uploaded_by, existing.r2_key,
        session.notes, notesPermission.can_edit_notes ? 1 : 0, session.project_id, session.target_version);
    } else {
      guards.push(`NOT EXISTS (
        SELECT 1 FROM versions WHERE project_id = ? AND version = ? AND release_channel = ? AND filename = ?
      )`);
      guardArgs.push(session.project_id, session.target_version, session.release_channel, session.filename);
    }
    if (session.has_version_notes) {
      guards.push(`(
        NOT EXISTS (SELECT 1 FROM version_metadata WHERE project_id = ? AND version = ?)
        OR EXISTS (
          SELECT 1 FROM version_metadata vm WHERE vm.project_id = ? AND vm.version = ?
            AND (vm.notes IS ? OR (? = 1 AND vm.created_by = ? AND ${unlocked}))
        )
      )`);
      guardArgs.push(session.project_id, session.target_version, session.project_id, session.target_version,
        session.version_notes, notesPermission.can_edit_version_notes ? 1 : 0,
        notesPermission.version_notes_creator ?? -1, session.project_id, session.target_version);
    }
    const guardSql = guards.join(' AND ');
    const metadataWrite = c.env.DB.prepare(
      `INSERT INTO version_metadata (project_id, version, notes, created_by, created_at, updated_at)
       SELECT ?, ?, ?, COALESCE((
         SELECT uploaded_by FROM versions WHERE project_id = ? AND version = ? ORDER BY created_at, id LIMIT 1
       ), ?), ?, ? WHERE ${guardSql}
       ON CONFLICT (project_id, version) DO UPDATE SET notes = excluded.notes, updated_at = excluded.updated_at
       WHERE ? = 1 AND version_metadata.notes IS NOT excluded.notes`,
    ).bind(session.project_id, session.target_version, session.has_version_notes ? session.version_notes : null,
      session.project_id, session.target_version, session.initiated_by, now, now,
      ...guardArgs, session.has_version_notes ? 1 : 0);

    const artifactWrite = existing
      ? c.env.DB.prepare(
        `UPDATE versions
            SET status = 'ready',
                r2_key = ?,
                filename = ?,
                size = ?,
                sha256 = ?,
                content_type = ?,
                notes = ?,
                is_mandatory = ?,
                min_version = ?,
                max_version = ?,
                rollout_percentage = ?,
                created_at = ?,
                updated_at = ?
          WHERE id = ? AND ${guardSql}`,
      )
        .bind(
          session.r2_key,
          session.filename,
          session.total_size,
          sha256,
          session.content_type,
          session.notes,
          session.is_mandatory,
          session.min_version,
          session.max_version,
          session.rollout_percentage,
          now,
          now,
          session.version_id,
          ...guardArgs,
        )
      : c.env.DB.prepare(
        `INSERT INTO versions
           (project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type, notes,
            is_mandatory, min_version, max_version, rollout_percentage, device_group_id,
            uploaded_by, created_at, updated_at)
         SELECT ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ? WHERE ${guardSql}
         ON CONFLICT (project_id, version, release_channel, filename) DO NOTHING`,
      )
        .bind(
          session.project_id,
          session.target_version,
          session.release_channel,
          session.r2_key,
          session.filename,
          session.total_size,
          sha256,
          session.content_type,
          session.notes,
          session.is_mandatory,
          session.min_version,
          session.max_version,
          session.rollout_percentage,
          session.initiated_by,
          now,
          now,
          ...guardArgs,
        );
    const completeSession = c.env.DB.prepare(
      `UPDATE upload_sessions SET status = 'completed', completed_at = ?, version_id = (
         SELECT id FROM versions WHERE project_id = ? AND r2_key = ? LIMIT 1
       ) WHERE id = ? AND status = 'in_progress' AND changes() = 1`,
    ).bind(now, session.project_id, session.r2_key, session.id);
    // changes() links the session transition to the preceding artifact write,
    // including legacy sessions whose object key may match the existing file.
    const [, artifactResult] = await c.env.DB.batch([metadataWrite, artifactWrite, completeSession]);
    if (!artifactResult || artifactResult.meta.changes === 0) {
      throw conflict('version or filename changed; refresh before retrying the upload');
    }
    if (!existing) versionId = Number(artifactResult.meta.last_row_id);

    await audit(c, {
      action: 'version.upload.complete',
      customerId: project.customer_id,
      projectId: session.project_id,
      targetType: 'version',
      targetId: versionId,
      meta: {
        sessionId: session.id,
        key: session.r2_key,
        size: session.total_size,
        sha256,
        etag: completeRes.etag,
        parts: body.parts.length,
        overwritten: !!session.version_id,
      },
    });

    if (oldKey && oldKey !== session.r2_key) void deleteObjectBestEffort(s3, oldKey);

    const ver = await c.env.DB.prepare(
      `SELECT v.id, v.project_id, v.version, v.release_channel, v.status, v.r2_key, v.filename, v.size, v.sha256, v.content_type, v.notes,
              v.is_mandatory, ${IS_CURRENT_SQL} AS is_current, v.min_version, v.max_version, v.rollout_percentage, v.device_group_id, v.download_count, v.public_slug, v.uploaded_by, v.created_at, v.updated_at
         FROM versions v
         JOIN projects p ON p.id = v.project_id
        WHERE v.id = ?`,
    )
      .bind(versionId)
      .first<any>();
    return c.json(versionDto((await withNotePermissions(c.env.DB, me, [ver]))[0]), 201);
  } catch (error) {
    // Object completion can succeed while a concurrent metadata write wins.
    // Delete only this session's unattached object, never a published artifact
    // (including legacy sessions that used the old deterministic storage key).
    const referenced = await c.env.DB.prepare('SELECT id FROM versions WHERE r2_key = ? LIMIT 1')
      .bind(session.r2_key).first<{ id: number }>();
    if (!referenced) {
      const sharedSession = await c.env.DB.prepare(
        `SELECT id FROM upload_sessions WHERE r2_key = ? AND id != ? AND status = 'in_progress' LIMIT 1`,
      ).bind(session.r2_key, session.id).first<{ id: number }>();
      if (!sharedSession) await deleteObjectBestEffort(s3, session.r2_key);
      await c.env.DB.prepare(`UPDATE upload_sessions SET status = 'failed' WHERE id = ? AND status = 'in_progress'`)
        .bind(session.id).run();
    }
    throw error;
  }
});

// ============================================================
// POST /api/upload/abort
// ============================================================
uploadRoutes.post('/abort', async (c) => {
  const me = c.get('user')!;
  type Body = { sessionId?: number };
  const body = (await c.req.json<Body>().catch(() => ({} as Body))) as Body;
  if (!body.sessionId) throw badRequest('sessionId required');
  const session = await c.env.DB.prepare(
    `SELECT id, project_id, r2_key, upload_id, status FROM upload_sessions WHERE id = ?`,
  )
    .bind(body.sessionId)
    .first<{ id: number; project_id: number; r2_key: string; upload_id: string; status: string }>();
  if (!session) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, session.project_id, 'upload');
  if (session.status === 'in_progress') {
    const s3 = makeStorage(c.env);
    try {
      await s3.abortMultipartUpload(session.r2_key, session.upload_id);
    } catch (e) {
      console.warn('[upload.abort] S3 abort failed', e);
    }
    await c.env.DB.prepare('UPDATE upload_sessions SET status = ? WHERE id = ?')
      .bind('aborted', session.id)
      .run();
  }
  await audit(c, {
    action: 'version.upload.abort',
    customerId: proj.customer_id,
    projectId: session.project_id,
    targetType: 'upload_session',
    targetId: session.id,
  });
  return c.json({ ok: true });
});

// ============================================================
// GET /api/upload/sessions?projectId=N
// ============================================================
uploadRoutes.get('/sessions', async (c) => {
  const projectIdQ = c.req.query('projectId');
  if (!projectIdQ) throw badRequest('projectId required');
  const projectId = Number(projectIdQ);
  if (!Number.isFinite(projectId)) throw badRequest('invalid projectId');
  const me = c.get('user')!;
  await requireProjectAccess(c.env.DB, me, projectId, 'upload');
  const status = c.req.query('status');
  const where: string[] = ['project_id = ?'];
  const args: unknown[] = [projectId];
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  const rows = await c.env.DB.prepare(
    `SELECT * FROM upload_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(...args)
    .all<SessionRow>();
  return c.json((rows.results ?? []).map(sessionDto));
});

// ============================================================
// GET /api/upload/sessions/:id  (session detail + uploaded parts for resume)
// ============================================================
uploadRoutes.get('/sessions/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  const row = await c.env.DB.prepare(`SELECT * FROM upload_sessions WHERE id = ?`)
    .bind(id)
    .first<SessionRow>();
  if (!row) throw notFound();
  await requireProjectAccess(c.env.DB, me, row.project_id, 'upload');
  const parts = await c.env.DB.prepare(
    'SELECT part_number, etag, size, uploaded_at FROM upload_parts WHERE session_id = ? ORDER BY part_number',
  )
    .bind(id)
    .all<{ part_number: number; etag: string; size: number; uploaded_at: number }>();
  return c.json({
    ...sessionDto(row),
    uploadedParts: (parts.results ?? []).map((p) => ({
      partNumber: p.part_number,
      etag: p.etag,
      size: p.size,
      uploadedAt: p.uploaded_at,
    })),
  });
});
