import { Hono } from 'hono';
import type { AppEnv, GlobalRole } from '../env';
import { hashPassword, verifyPassword } from '../utils/password';
import { signJwt } from '../utils/jwt';
import { badRequest, conflict, unauthorized } from '../utils/errors';
import { requireUser } from '../middleware/auth';
import { audit } from '../lib/audit';
import { EFFECTIVE_GLOBAL_ROLE_SQL } from '../lib/global-roles';

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

authRoutes.post('/login', async (c) => {
  type LoginBody = { email?: string; password?: string };
  const body = (await c.req.json<LoginBody>().catch(() => ({} as LoginBody))) as LoginBody;
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) throw badRequest('email and password required');

  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.password_hash, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.email = ?`,
  )
    .bind(email)
    .first<UserRow>();
  if (!row || !row.is_active) {
    await audit(c, { actorType: 'system', action: 'auth.login.failed', meta: { email } });
    throw unauthorized('invalid credentials');
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    await audit(c, { actorType: 'system', action: 'auth.login.failed', meta: { email, userId: row.id } });
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
  type ChangeBody = { oldPassword?: string; newPassword?: string };
  const body = (await c.req.json<ChangeBody>().catch(() => ({} as ChangeBody))) as ChangeBody;
  if (!body.oldPassword || !body.newPassword || body.newPassword.length < 8) {
    throw badRequest('oldPassword and newPassword (>=8 chars) required');
  }
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
