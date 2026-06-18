import { Hono } from 'hono';
import type { AppEnv, GlobalRole } from '../env';
import { requireAdmin, requireUser } from '../middleware/auth';
import { hashPassword } from '../utils/password';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { audit } from '../lib/audit';
import { baseGlobalRoleFor, EFFECTIVE_GLOBAL_ROLE_SQL, setUserGlobalRole } from '../lib/global-roles';

export const userRoutes = new Hono<AppEnv>();

userRoutes.use('*', requireUser, requireAdmin);

const ROLE_RANK: Record<GlobalRole, number> = { observer: 1, developer: 2, admin: 3, super_admin: 4 };
const ROLES: GlobalRole[] = ['super_admin', 'admin', 'developer', 'observer'];

function parseRole(role: unknown): GlobalRole {
  return typeof role === 'string' && (ROLES as string[]).includes(role) ? (role as GlobalRole) : 'developer';
}

// The top role may assign its own level and below; others assign strictly below.
function canAssignRole(actorRole: GlobalRole, targetRole: GlobalRole): boolean {
  const mine = ROLE_RANK[actorRole];
  const isTop = mine >= ROLE_RANK.super_admin;
  return isTop ? ROLE_RANK[targetRole] <= mine : ROLE_RANK[targetRole] < mine;
}

async function countSuperAdmins(db: AppEnv['Bindings']['DB'], activeOnly = false): Promise<number> {
  const sql = activeOnly
    ? `SELECT COUNT(*) AS n
         FROM users u
         LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
        WHERE ${EFFECTIVE_GLOBAL_ROLE_SQL} = 'super_admin' AND u.is_active = 1`
    : `SELECT COUNT(*) AS n
         FROM users u
         LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
        WHERE ${EFFECTIVE_GLOBAL_ROLE_SQL} = 'super_admin'`;
  const r = await db.prepare(sql).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

interface UserRow {
  id: number;
  email: string;
  display_name: string | null;
  role: GlobalRole;
  is_active: number;
  created_at: number;
  updated_at: number;
}

function dto(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

userRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      ORDER BY u.id ASC`,
  ).all<UserRow>();
  return c.json((rows.results ?? []).map(dto));
});

userRoutes.post('/', async (c) => {
  type CreateBody = {
    email?: string;
    password?: string;
    displayName?: string;
    role?: GlobalRole;
  };
  const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
  const email = body.email?.trim().toLowerCase();
  if (!email || !body.password || body.password.length < 8) {
    throw badRequest('email and password (>=8 chars) required');
  }
  const role = parseRole(body.role);
  const me = c.get('user')!;
  if (!canAssignRole(me.role, role)) {
    throw forbidden('cannot assign a role above your own');
  }
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) throw conflict('email already exists');
  const hash = await hashPassword(body.password);
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(email, hash, body.displayName ?? null, baseGlobalRoleFor(role), now, now)
    .run();
  const id = result.meta.last_row_id;
  await setUserGlobalRole(c.env.DB, id, role, me.id);
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(id)
    .first<UserRow>();
  await audit(c, { action: 'user.create', targetType: 'user', targetId: id, meta: { email, role } });
  return c.json(dto(row!), 201);
});

userRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  type PatchBody = {
    displayName?: string | null;
    role?: GlobalRole;
    isActive?: boolean;
    password?: string;
  };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  const me = c.get('user')!;
  const existing = await c.env.DB.prepare(
    `SELECT u.id, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role, u.is_active
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(id)
    .first<{ id: number; role: GlobalRole; is_active: number }>();
  if (!existing) throw notFound();
  if (!canAssignRole(me.role, existing.role)) {
    throw forbidden('cannot manage a role above or equal to your own');
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  let targetRole: GlobalRole | null = null;
  if (body.displayName !== undefined) {
    sets.push('display_name = ?');
    args.push(body.displayName);
  }
  if (body.role !== undefined) {
    targetRole = parseRole(body.role);
    if (!canAssignRole(me.role, targetRole)) {
      throw forbidden('cannot assign a role above your own');
    }
    // Never demote the last remaining super admin.
    if (existing.role === 'super_admin' && targetRole !== 'super_admin' && (await countSuperAdmins(c.env.DB)) <= 1) {
      throw badRequest('system must keep at least one super admin');
    }
  }
  if (body.isActive !== undefined) {
    // Never disable the last active super admin.
    if (
      body.isActive === false &&
      existing.role === 'super_admin' &&
      existing.is_active === 1 &&
      (await countSuperAdmins(c.env.DB, true)) <= 1
    ) {
      throw badRequest('system must keep at least one active super admin');
    }
    sets.push('is_active = ?');
    args.push(body.isActive ? 1 : 0);
  }
  if (body.password) {
    if (body.password.length < 8) throw badRequest('password too short');
    sets.push('password_hash = ?');
    args.push(await hashPassword(body.password));
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    args.push(Date.now());
    args.push(id);
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  }
  if (targetRole) await setUserGlobalRole(c.env.DB, id, targetRole, me.id);
  if (sets.length === 0 && !targetRole) return c.json({ ok: true });
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role,
            u.is_active, u.created_at, u.updated_at
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(id)
    .first<UserRow>();
  await audit(c, { action: 'user.update', targetType: 'user', targetId: id, meta: { fields: Object.keys(body) } });
  return c.json(dto(row!));
});

userRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const me = c.get('user')!;
  if (me.id === id) throw badRequest('cannot delete self');
  const target = await c.env.DB.prepare(
    `SELECT ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(id)
    .first<{ role: GlobalRole }>();
  if (!target) throw notFound();
  if (!canAssignRole(me.role, target.role)) {
    throw forbidden('cannot delete a role above or equal to your own');
  }
  if (target.role === 'super_admin' && (await countSuperAdmins(c.env.DB)) <= 1) {
    throw badRequest('system must keep at least one super admin');
  }
  const r = await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  if (r.meta.changes === 0) throw notFound();
  await audit(c, { action: 'user.delete', targetType: 'user', targetId: id });
  return c.json({ ok: true });
});
