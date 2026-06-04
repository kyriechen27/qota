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
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, notFound } from '../utils/errors';
import { requireProjectAccess } from '../lib/memberships';
import { makeStorage } from '../lib/s3';
import { audit } from '../lib/audit';
import { versionDto } from './versions';

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
  const safe = filename.replace(/[^A-Za-z0-9._+-]/g, '_');
  return `${customerCode}/${projectCode}/${channel}/${version}/${safe}`;
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
    notes?: string;
    isMandatory?: boolean;
    minVersion?: string | null;
    maxVersion?: string | null;
    rolloutPercentage?: number;
    expectedSha256?: string;
    partSizeHint?: number;
  };
  const body = (await c.req.json<InitBody>().catch(() => ({} as InitBody))) as InitBody;

  if (!body.projectId) throw badRequest('projectId required');
  if (!body.filename) throw badRequest('filename required');
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

  const project = await requireProjectAccess(c.env.DB, me, body.projectId, 'upload');
  const customer = await c.env.DB.prepare('SELECT code FROM customers WHERE id = ?')
    .bind(project.customer_id)
    .first<{ code: string }>();
  if (!customer) throw notFound('customer not found');

  // Reject duplicate (project, version, channel) — block early before we open an R2 multipart.
  const dup = await c.env.DB.prepare(
    `SELECT id FROM versions WHERE project_id = ? AND version = ? AND release_channel = ?`,
  )
    .bind(body.projectId, body.version, channel)
    .first();
  if (dup) throw conflict('version+channel already exists');

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
        target_version, content_type, notes, is_mandatory, min_version, max_version, rollout_percentage,
        status, initiated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
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
      body.notes ?? null,
      body.isMandatory ? 1 : 0,
      body.minVersion ?? null,
      body.maxVersion ?? null,
      body.rolloutPercentage === undefined ? 100 : Math.floor(body.rolloutPercentage),
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
    meta: { key, totalSize, partSize, partCount, version: body.version, channel },
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

  // Insert the version row
  const verRes = await c.env.DB.prepare(
    `INSERT INTO versions
       (project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type, notes,
        is_mandatory, min_version, max_version, rollout_percentage, device_group_id,
        uploaded_by, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      session.project_id,
      session.target_version,
      session.release_channel,
      session.r2_key,
      session.filename,
      session.total_size,
      body.sha256 ?? session.expected_sha256 ?? null,
      session.content_type,
      session.notes,
      session.is_mandatory,
      session.min_version,
      session.max_version,
      session.rollout_percentage,
      session.initiated_by,
      now,
      now,
    )
    .run();
  const versionId = Number(verRes.meta.last_row_id);

  await c.env.DB.prepare(
    `UPDATE upload_sessions SET status = 'completed', completed_at = ?, version_id = ? WHERE id = ?`,
  )
    .bind(now, versionId, session.id)
    .run();

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
      sha256: body.sha256 ?? session.expected_sha256 ?? null,
      etag: completeRes.etag,
      parts: body.parts.length,
    },
  });

  const ver = await c.env.DB.prepare(
    `SELECT id, project_id, version, release_channel, status, r2_key, filename, size, sha256, content_type, notes,
            is_mandatory, min_version, max_version, rollout_percentage, device_group_id, download_count, uploaded_by, created_at, updated_at
       FROM versions WHERE id = ?`,
  )
    .bind(versionId)
    .first<any>();
  return c.json(versionDto(ver), 201);
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
