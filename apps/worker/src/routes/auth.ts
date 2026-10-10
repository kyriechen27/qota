import { Hono } from 'hono';
import type { AppEnv, GlobalRole } from '../env';
import { hashPassword, validatePasswordConfirmation, verifyPassword } from '../utils/password';
import { signJwt } from '../utils/jwt';
import { badRequest, conflict, unauthorized } from '../utils/errors';
import { requireUser } from '../middleware/auth';
import { audit } from '../lib/audit';
import { EFFECTIVE_GLOBAL_ROLE_SQL } from '../lib/global-roles';
import { registrationDisabled, registrationEmail, registrationEnabled } from '../lib/registration';

export const authRoutes = new Hono<AppEnv>();

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: GlobalRole;
  is_active: number;
  created_at: number;
  updated_at: number;
}

function dto(r: UserRow) {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    isActive: !!r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

authRoutes.get('/registration', async (c) => {
  c.header('Cache-Control', 'no-store, max-age=0');
  return c.json({ enabled: await registrationEnabled(c.env.DB) });
});

authRoutes.post('/register', async (c) => {
  if (!await registrationEnabled(c.env.DB)) throw registrationDisabled();
  const body = await c.req.json<{
    email?: unknown; password?: unknown; confirmPassword?: unknown; displayName?: unknown;
  }>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('registration details required');
  const email = registrationEmail(body.email);
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 128) {
    throw badRequest('password must contain 8-128 characters');
  }
  validatePasswordConfirmation(body.password, body.confirmPassword, true);
  if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') {
    throw badRequest('displayName must be a string');
  }
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  if (displayName.length > 128 || /[\u0000-\u001f\u007f]/.test(displayName)) throw badRequest('invalid displayName');
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) throw conflict('email already exists');
  const hash = await hashPassword(body.password);
  const now = Date.now();
  // Read the switch inside the write, after hashing. Concurrent signups use
  // the unique email constraint; neither race may create a privileged account.
  const result = await c.env.DB.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active, created_at, updated_at)
     SELECT ?, ?, ?, 'developer', 1, ?, ?
      WHERE EXISTS (SELECT 1 FROM registration_settings WHERE id = 1 AND enabled = 1)
     ON CONFLICT (email) DO NOTHING`,
  ).bind(email, hash, displayName || null, now, now).run();
  if (!result.meta.changes) {
    if (!await registrationEnabled(c.env.DB)) throw registrationDisabled();
    throw conflict('email already exists');
  }
  const id = Number(result.meta.last_row_id);
  await audit(c, { action: 'auth.register', actorType: 'user', actorId: id, targetType: 'user', targetId: id });
  return c.json({ ok: true }, 201);
});

authRoutes.post('/login', async (c) => {
  type LoginBody = { email?: string; password?: string };
  const body = (await c.req.json<LoginBody>().catch(() => ({} as LoginBody))) as LoginBody;
  const identifier = body.email?.trim();
  const password = body.password;
  if (!identifier || !password) throw badRequest('email or username and password required');

  const userSelectSql = `SELECT u.id, u.email, u.password_hash, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id`;
  const email = identifier.toLowerCase();
  const emailRow = await c.env.DB.prepare(
    `${userSelectSql}
      WHERE u.email = ?`,
  )
    .bind(email)
    .first<UserRow>();

  const candidates = emailRow
    ? [emailRow]
    : (
        await c.env.DB.prepare(
          `${userSelectSql}
            WHERE LOWER(u.display_name) = LOWER(?)
            ORDER BY u.id ASC`,
        )
          .bind(identifier)
          .all<UserRow>()
      ).results;

  let row: UserRow | null = null;
  for (const candidate of candidates) {
    if (!candidate.is_active) continue;
    if (await verifyPassword(password, candidate.password_hash)) {
      row = candidate;
      break;
    }
  }

  if (!row) {
    await audit(c, {
      actorType: 'system',
      action: 'auth.login.failed',
      meta: { identifier, userId: candidates[0]?.id },
    });
    throw unauthorized('invalid credentials');
  }

  const ttl = Number(c.env.JWT_TTL_SECONDS) || 43200;
  const token = await signJwt({ sub: row.id, email: row.email, role: row.role }, c.env.JWT_SECRET, ttl);
  await audit(c, { actorType: 'user', actorId: row.id, action: 'auth.login' });
  return c.json({ token, user: dto(row) });
});

authRoutes.get('/me', requireUser, async (c) => {
  const u = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.password_hash, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(u.id)
    .first<UserRow>();
  if (!row) throw unauthorized();
  return c.json(dto(row));
});

authRoutes.patch('/profile', requireUser, async (c) => {
  const u = c.get('user')!;
  type ProfileBody = { email?: string; displayName?: string | null };
  const body = (await c.req.json<ProfileBody>().catch(() => ({} as ProfileBody))) as ProfileBody;

  const sets: string[] = [];
  const args: unknown[] = [];

  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw badRequest('invalid email');
    }
    const dupe = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id <> ?')
      .bind(email, u.id)
      .first<{ id: number }>();
    if (dupe) throw conflict('email already in use');
    sets.push('email = ?');
    args.push(email);
  }

  if (body.displayName !== undefined) {
    const name = body.displayName === null ? '' : String(body.displayName).trim();
    if (name.length > 128) throw badRequest('display name too long');
    sets.push('display_name = ?');
    args.push(name.length ? name : null);
  }

  const selectSql =
    `SELECT u.id, u.email, u.password_hash, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`;

  if (sets.length === 0) {
    const cur = await c.env.DB.prepare(selectSql).bind(u.id).first<UserRow>();
    if (!cur) throw unauthorized();
    return c.json(dto(cur));
  }

  sets.push('updated_at = ?');
  args.push(Date.now());
  args.push(u.id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  await audit(c, { action: 'auth.profile_updated', meta: { fields: Object.keys(body) } });

  const row = await c.env.DB.prepare(selectSql).bind(u.id).first<UserRow>();
  return c.json(dto(row!));
});

authRoutes.post('/change-password', requireUser, async (c) => {
  const u = c.get('user')!;
  type ChangeBody = { oldPassword?: string; newPassword?: string; confirmPassword?: unknown };
  const body = (await c.req.json<ChangeBody>().catch(() => ({} as ChangeBody))) as ChangeBody;
  if (typeof body?.oldPassword !== 'string' || !body.oldPassword || typeof body.newPassword !== 'string' || body.newPassword.length < 8) {
    throw badRequest('oldPassword and newPassword (>=8 chars) required');
  }
  validatePasswordConfirmation(body.newPassword, body.confirmPassword);
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(u.id)
    .first<{ password_hash: string }>();
  if (!row) throw unauthorized();
  const ok = await verifyPassword(body.oldPassword, row.password_hash);
  if (!ok) throw unauthorized('invalid credentials');
  const hash = await hashPassword(body.newPassword);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(hash, Date.now(), u.id)
    .run();
  await audit(c, { action: 'auth.password_changed' });
  return c.json({ ok: true });
});
