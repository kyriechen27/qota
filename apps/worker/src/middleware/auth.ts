import type { MiddlewareHandler } from 'hono';
import type { AppEnv, GlobalRole } from '../env';
import { verifyJwt } from '../utils/jwt';
import { unauthorized, forbidden } from '../utils/errors';

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
  const row = await c.env.DB.prepare('SELECT id, email, role, is_active FROM users WHERE id = ?')
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
