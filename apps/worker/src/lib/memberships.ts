// Permission resolver for the multi-tenant role model.
//
// Roles:
//   - users.role = 'super_admin'  → implicit access to everything
//   - users.role = 'admin'        → global management except super-admin users
//   - users.role = 'observer'     → global read/download only
//   - users.role = 'developer'    → no global access; relies on memberships
//
// Customer-scoped roles (in `memberships` and `project_memberships` tables):
//   - customer_admin → full control of the customer/project, incl. membership mgmt
//   - developer      → upload + view + download + delete versions
//   - viewer         → view + download only
//
// `project_memberships`, when present, takes precedence over the customer-level
// membership for that specific project.

import type { D1Database } from '@cloudflare/workers-types';
import type { AuthedUser, CustomerRole } from '../env';
import { forbidden, notFound } from '../utils/errors';

export type Action =
  | 'view'
  | 'download'
  | 'upload'
  | 'manage_versions'   // delete / archive existing versions
  | 'manage_tokens'     // issue & revoke api_tokens
  | 'manage_members'    // grant / revoke memberships on this customer/project
  | 'manage_projects'   // create / edit / delete projects under a customer
  | 'manage_customer';  // edit / delete the customer itself

const ROLE_GRANTS: Record<CustomerRole, ReadonlySet<Action>> = {
  customer_admin: new Set<Action>([
    'view',
    'download',
    'upload',
    'manage_versions',
    'manage_tokens',
    'manage_members',
    'manage_projects',
    'manage_customer',
  ]),
  developer: new Set<Action>([
    'view',
    'download',
    'upload',
    'manage_versions',
    'manage_tokens',
  ]),
  viewer: new Set<Action>(['view', 'download']),
};

const GLOBAL_ADMIN_ACTIONS = new Set<Action>([
  'view',
  'download',
  'upload',
  'manage_versions',
  'manage_tokens',
  'manage_members',
  'manage_projects',
  'manage_customer',
]);

const GLOBAL_OBSERVER_ACTIONS = new Set<Action>(['view', 'download']);

function globalRoleHas(user: AuthedUser, action: Action): boolean | null {
  if (user.role === 'super_admin') return true;
  if (user.role === 'admin') return GLOBAL_ADMIN_ACTIONS.has(action);
  if (user.role === 'observer') return GLOBAL_OBSERVER_ACTIONS.has(action);
  return null;
}

export function roleHas(role: CustomerRole, action: Action): boolean {
  return ROLE_GRANTS[role].has(action);
}

export async function effectiveRoleOnCustomer(
  db: D1Database,
  userId: number,
  customerId: number,
): Promise<CustomerRole | null> {
  const row = await db
    .prepare('SELECT role FROM memberships WHERE user_id = ? AND customer_id = ?')
    .bind(userId, customerId)
    .first<{ role: CustomerRole }>();
  return row?.role ?? null;
}

export async function effectiveRoleOnProject(
  db: D1Database,
  userId: number,
  projectId: number,
): Promise<CustomerRole | null> {
  // project-level override wins
  const proj = await db
    .prepare('SELECT role FROM project_memberships WHERE user_id = ? AND project_id = ?')
    .bind(userId, projectId)
    .first<{ role: CustomerRole }>();
  if (proj) return proj.role;
  const cust = await db
    .prepare(
      `SELECT m.role
         FROM memberships m
         JOIN projects p ON p.customer_id = m.customer_id
        WHERE m.user_id = ? AND p.id = ?`,
    )
    .bind(userId, projectId)
    .first<{ role: CustomerRole }>();
  return cust?.role ?? null;
}

export async function canDoOnCustomer(
  db: D1Database,
  user: AuthedUser,
  customerId: number,
  action: Action,
): Promise<boolean> {
  const global = globalRoleHas(user, action);
  if (global !== null) return global;
  const role = await effectiveRoleOnCustomer(db, user.id, customerId);
  return !!role && roleHas(role, action);
}

export async function canDoOnProject(
  db: D1Database,
  user: AuthedUser,
  projectId: number,
  action: Action,
): Promise<boolean> {
  const global = globalRoleHas(user, action);
  if (global !== null) return global;
  const role = await effectiveRoleOnProject(db, user.id, projectId);
  return !!role && roleHas(role, action);
}

/** Loads the project row; throws 404 or 403. */
export async function requireProjectAccess(
  db: D1Database,
  user: AuthedUser,
  projectId: number,
  action: Action,
): Promise<{ id: number; customer_id: number; code: string; name: string; default_channel: string }> {
  const row = await db
    .prepare('SELECT id, customer_id, code, name, default_channel FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ id: number; customer_id: number; code: string; name: string; default_channel: string }>();
  if (!row) throw notFound('project not found');
  const ok = await canDoOnProject(db, user, projectId, action);
  if (!ok) throw forbidden(`no '${action}' permission on project ${projectId}`);
  return row;
}

/** Loads the customer row; throws 404 or 403. */
export async function requireCustomerAccess(
  db: D1Database,
  user: AuthedUser,
  customerId: number,
  action: Action,
): Promise<{ id: number; code: string; name: string }> {
  const row = await db
    .prepare('SELECT id, code, name FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ id: number; code: string; name: string }>();
  if (!row) throw notFound('customer not found');
  const ok = await canDoOnCustomer(db, user, customerId, action);
  if (!ok) throw forbidden(`no '${action}' permission on customer ${customerId}`);
  return row;
}

/** Customer ids the user can see (null = no filter, i.e. global role can see all). */
export async function visibleCustomerIds(
  db: D1Database,
  user: AuthedUser,
): Promise<number[] | null> {
  if (user.role === 'super_admin' || user.role === 'admin' || user.role === 'observer') return null;
  const direct = await db
    .prepare('SELECT customer_id FROM memberships WHERE user_id = ?')
    .bind(user.id)
    .all<{ customer_id: number }>();
  const viaProj = await db
    .prepare(
      `SELECT DISTINCT p.customer_id
         FROM project_memberships pm
         JOIN projects p ON p.id = pm.project_id
        WHERE pm.user_id = ?`,
    )
    .bind(user.id)
    .all<{ customer_id: number }>();
  const ids = new Set<number>();
  for (const r of direct.results ?? []) ids.add(r.customer_id);
  for (const r of viaProj.results ?? []) ids.add(r.customer_id);
  return [...ids];
}

/** Project ids the user can see. */
export async function visibleProjectIds(
  db: D1Database,
  user: AuthedUser,
): Promise<number[] | null> {
  if (user.role === 'super_admin' || user.role === 'admin' || user.role === 'observer') return null;
  const rows = await db
    .prepare(
      `SELECT DISTINCT p.id FROM projects p
        WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ?1 AND m.customer_id = p.customer_id)
           OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.user_id = ?1 AND pm.project_id = p.id)`,
    )
    .bind(user.id)
    .all<{ id: number }>();
  return (rows.results ?? []).map((r) => r.id);
}
