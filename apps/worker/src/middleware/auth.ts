import type { MiddlewareHandler } from 'hono';
import type { AppEnv, GlobalRole } from '../env';
import { verifyJwt } from '../utils/jwt';
import { unauthorized, forbidden } from '../utils/errors';
import { EFFECTIVE_GLOBAL_ROLE_SQL } from '../lib/global-roles';

interface JwtPayload {
  sub: number;
  email: string;
  role: GlobalRole;
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) throw unauthorized();
  const token = auth.slice('Bearer '.length).trim();
  const payload = await verifyJwt<JwtPayload>(token, c.env.JWT_SECRET);
  if (!payload || typeof payload.sub !== 'number' || !payload.email || !payload.role) {
    throw unauthorized();
  }
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, ${EFFECTIVE_GLOBAL_ROLE_SQL} AS role, u.is_active
       FROM users u
       LEFT JOIN user_global_roles ugr ON ugr.user_id = u.id
      WHERE u.id = ?`,
  )
    .bind(payload.sub)
    .first<{ id: number; email: string; role: GlobalRole; is_active: number }>();
  if (!row || !row.is_active) throw unauthorized('account disabled');
  c.set('user', { id: row.id, email: row.email, role: row.role });
  await next();
};

export const requireSuperAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (user.role !== 'super_admin') throw forbidden('super_admin only');
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw unauthorized();
  if (user.role !== 'super_admin' && user.role !== 'admin') throw forbidden('admin only');
  await next();
};
