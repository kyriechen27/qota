import type { D1Database } from '@cloudflare/workers-types';
import type { GlobalRole } from '../env';

export const EFFECTIVE_GLOBAL_ROLE_SQL = 'COALESCE(ugr.role, u.role)';
export const GLOBAL_ROLE_OVERRIDE_VALUES: GlobalRole[] = ['admin', 'observer'];

export function baseGlobalRoleFor(role: GlobalRole): 'super_admin' | 'developer' {
  return role === 'super_admin' ? 'super_admin' : 'developer';
}

export function usesGlobalRoleOverride(role: GlobalRole): boolean {
  return role !== baseGlobalRoleFor(role);
}

export async function setUserGlobalRole(
  db: D1Database,
  userId: number,
  role: GlobalRole,
  updatedBy: number | null,
): Promise<void> {
  const now = Date.now();
  await db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?')
    .bind(baseGlobalRoleFor(role), now, userId)
    .run();

  if (!usesGlobalRoleOverride(role)) {
    await db.prepare('DELETE FROM user_global_roles WHERE user_id = ?').bind(userId).run();
    return;
  }

  await db.prepare(
    `INSERT INTO user_global_roles (user_id, role, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       role = excluded.role,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  )
    .bind(userId, role, now, updatedBy)
    .run();
}
