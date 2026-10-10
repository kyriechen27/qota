// API tokens for non-user actors (devices + CI runners).
// Issuing & revoking requires manage_tokens on the target project.

import { Hono, type Context } from 'hono';
import type { AppEnv, AuthedApiToken } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, HttpError, notFound, unauthorized } from '../utils/errors';
import { requireProjectAccess } from '../lib/memberships';
import { sha256Hex } from '../utils/sha';
import { bytesToHex } from '../utils/encoding';
import { encryptSecret, decryptSecret } from '../utils/crypto';
import { audit } from '../lib/audit';
import { hasVersionRestrictions, normalizeTokenRestrictions, tokenVersionFilter } from '../lib/token-restrictions';

export const apiTokenRoutes = new Hono<AppEnv>();

apiTokenRoutes.use('*', requireUser);

interface TokenRow {
  id: number;
  project_id: number;
  name: string;
  token_prefix: string;
  kind: 'device' | 'ci';
  scope: 'download' | 'upload' | 'full';
  channel: string | null;
  special_version: string | null;
  version: string | null;
  version_id: number | null;
  created_by: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
  created_at: number;
  token_enc: string | null;
}

function dto(r: TokenRow) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    tokenPrefix: r.token_prefix,
    kind: r.kind,
    scope: r.scope,
    channel: r.channel,
    specialVersion: r.special_version,
    version: r.version,
    versionId: r.version_id,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    // Whether the full token can be re-revealed/copied (false for tokens issued
    // before token_enc existed). Never expose the ciphertext itself.
    hasSecret: !!r.token_enc,
  };
}

function generateToken(kind: 'device' | 'ci'): string {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  const prefix = kind === 'ci' ? 'qci_' : 'qd_';
  return `${prefix}${bytesToHex(buf)}`;
}

apiTokenRoutes.get('/', async (c) => {
  const projectIdQ = c.req.query('projectId');
  if (!projectIdQ) throw badRequest('projectId required');
  const projectId = Number(projectIdQ);
  if (!Number.isFinite(projectId)) throw badRequest('invalid projectId');
  const user = c.get('user')!;
  await requireProjectAccess(c.env.DB, user, projectId, 'manage_tokens');
  const rows = await c.env.DB.prepare(
    `SELECT id, project_id, name, token_prefix, kind, scope, channel, special_version, version, version_id, created_by, expires_at,
            last_used_at, last_used_ip, revoked_at, created_at, token_enc
       FROM api_tokens WHERE project_id = ? ORDER BY id DESC`,
  )
    .bind(projectId)
    .all<TokenRow>();
  return c.json((rows.results ?? []).map(dto));
});

apiTokenRoutes.post('/', async (c) => {
  const me = c.get('user')!;
  type CreateBody = {
    projectId?: number;
    name?: string;
    kind?: 'device' | 'ci';
    scope?: 'download' | 'upload' | 'full';
    channel?: string | null;
    specialVersion?: string | null;
    version?: string | null;
    versionId?: number | null;
    expiresAt?: number | null;
  };
  const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
  if (!body || typeof body.projectId !== 'number' || !Number.isSafeInteger(body.projectId) || body.projectId <= 0 || typeof body.name !== 'string' || !body.name.trim()) {
    throw badRequest('projectId and name required');
  }
  if (body.expiresAt !== undefined && body.expiresAt !== null && !Number.isSafeInteger(body.expiresAt)) {
    throw badRequest('expiresAt must be an integer timestamp or null');
  }
  const proj = await requireProjectAccess(c.env.DB, me, body.projectId, 'manage_tokens');
  const restrictions = normalizeTokenRestrictions(body);
  const filter = tokenVersionFilter(body.projectId, restrictions);
  const needsMatch = hasVersionRestrictions(restrictions);
  const matchSql = `EXISTS (SELECT 1 FROM versions v WHERE ${filter.sql} AND v.status IN ('ready', 'archived'))`;
  if (needsMatch) {
    const match = await c.env.DB.prepare(`SELECT ${matchSql} AS allowed`).bind(...filter.args).first<{ allowed: number }>();
    if (!match?.allowed) throw badRequest('token restrictions do not match a ready or archived file in this project');
  }
  const kind = body.kind === 'ci' ? 'ci' : 'device';
  const scope = body.scope === 'upload' || body.scope === 'full' ? body.scope : 'download';
  if (kind === 'device' && scope !== 'download') {
    throw badRequest('device tokens must have scope=download');
  }
  const token = generateToken(kind);
  const tokenHash = await sha256Hex(token);
  const tokenEnc = await encryptSecret(token, c.env.JWT_SECRET);
  const prefix = token.slice(0, 12);
  const now = Date.now();
  const r = await c.env.DB.prepare(
    `INSERT INTO api_tokens (project_id, name, token_hash, token_enc, token_prefix, kind, scope, channel,
                            special_version, version, version_id, created_by, expires_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${needsMatch ? `WHERE ${matchSql}` : ''}`,
  )
    .bind(
      body.projectId,
      body.name,
      tokenHash,
      tokenEnc,
      prefix,
      kind,
      scope,
      restrictions.channel,
      restrictions.specialVersion,
      restrictions.version,
      restrictions.versionId,
      me.id,
      body.expiresAt ?? null,
      now,
      ...(needsMatch ? filter.args : []),
    )
    .run();
  if (!r.meta.changes) throw conflict('token target changed; refresh the available versions before retrying');
  const id = Number(r.meta.last_row_id);
  const row = await c.env.DB.prepare(
    `SELECT id, project_id, name, token_prefix, kind, scope, channel, special_version, version, version_id, created_by, expires_at,
            last_used_at, last_used_ip, revoked_at, created_at, token_enc
       FROM api_tokens WHERE id = ?`,
  )
    .bind(id)
    .first<TokenRow>();
  await audit(c, {
    action: 'api_token.create',
    customerId: proj.customer_id,
    projectId: body.projectId,
    targetType: 'api_token',
    targetId: id,
    meta: { kind, scope, ...restrictions, name: body.name },
  });
  return c.json({ ...dto(row!), token }, 201);
});

// Reveal (decrypt) the full token so it can be re-copied from the dashboard.
// Requires manage_tokens, and is audited. 404 for tokens issued before token_enc
// existed (only their hash is known) — those must be re-issued to enable copy.
apiTokenRoutes.get('/:id/reveal', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id, token_enc FROM api_tokens WHERE id = ?')
    .bind(id)
    .first<{ project_id: number; token_enc: string | null }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_tokens');
  if (!row.token_enc) {
    throw notFound('token secret not stored (issued before copy was enabled) — re-issue the token');
  }
  const token = await decryptSecret(row.token_enc, c.env.JWT_SECRET);
  if (!token) throw new HttpError(500, 'decrypt_failed', 'failed to decrypt token');
  await audit(c, {
    action: 'api_token.reveal',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'api_token',
    targetId: id,
  });
  return c.json({ token });
});

apiTokenRoutes.post('/:id/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id FROM api_tokens WHERE id = ?')
    .bind(id)
    .first<{ project_id: number }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_tokens');
  await c.env.DB.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').bind(Date.now(), id).run();
  await audit(c, {
    action: 'api_token.revoke',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'api_token',
    targetId: id,
  });
  return c.json({ ok: true });
});

apiTokenRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  const row = await c.env.DB.prepare('SELECT project_id FROM api_tokens WHERE id = ?')
    .bind(id)
    .first<{ project_id: number }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_tokens');
  await c.env.DB.prepare('DELETE FROM api_tokens WHERE id = ?').bind(id).run();
  await audit(c, {
    action: 'api_token.delete',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'api_token',
    targetId: id,
  });
  return c.json({ ok: true });
});

/** Helper used by download routes — validates a raw bearer token and
 *  returns the decoded api_token row, plus touches last_used_at. */
export async function resolveApiToken(c: Context<AppEnv>, rawToken: string): Promise<AuthedApiToken> {
  const hash = await sha256Hex(rawToken);
  const row = await c.env.DB.prepare(
    `SELECT id, project_id, kind, scope, channel, special_version, version, version_id, expires_at, revoked_at
       FROM api_tokens WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{
      id: number;
      project_id: number;
      kind: 'device' | 'ci';
      scope: 'download' | 'upload' | 'full';
      channel: string | null;
      special_version: string | null;
      version: string | null;
      version_id: number | null;
      expires_at: number | null;
      revoked_at: number | null;
    }>();
  if (!row) throw unauthorized('invalid api token');
  if (row.revoked_at) throw unauthorized('token revoked');
  if (row.expires_at && row.expires_at < Date.now()) throw unauthorized('token expired');
  const ip =
    c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?')
      .bind(Date.now(), ip, row.id)
      .run(),
  );
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    scope: row.scope,
    channel: row.channel || null,
    specialVersion: row.special_version,
    version: row.version,
    versionId: row.version_id,
  };
}
