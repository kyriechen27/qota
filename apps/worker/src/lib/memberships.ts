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
// Project overrides win. Otherwise the closest customer grant, starting at
// the project's customer and walking toward the root, applies to descendants.

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

// Arguments are trusted SQL expressions/placeholders, never request values.
// Reuse this in inline permission guards so a nearer viewer cannot be bypassed
// by selecting a more privileged ancestor. The path guard also tolerates a
// malformed legacy cycle without allowing an unbounded recursive query.
export function customerMembershipIdSql(customerIdSql: string, userIdSql: string): string {
  return `(WITH RECURSIVE lineage(id, parent_id, depth, path) AS (
    SELECT ancestor_customer.id, ancestor_customer.parent_id, 0, '/' || ancestor_customer.id || '/'
      FROM customers ancestor_customer WHERE ancestor_customer.id = ${customerIdSql}
    UNION ALL
    SELECT parent.id, parent.parent_id, lineage.depth + 1, lineage.path || parent.id || '/'
      FROM customers parent JOIN lineage ON parent.id = lineage.parent_id
     WHERE instr(lineage.path, '/' || parent.id || '/') = 0
  )
  SELECT inherited.id FROM lineage JOIN memberships inherited ON inherited.customer_id = lineage.id
   WHERE inherited.user_id = ${userIdSql} ORDER BY lineage.depth ASC LIMIT 1)`;
}

// All customer roles permit viewing. Descendant expansion therefore only needs
// membership existence, while mutations use the nearest-role resolver above.
// UNION, rather than UNION ALL, terminates even if legacy data contains a cycle.
export function inheritedCustomerIdsSql(userIdSql: string): string {
  return `(WITH RECURSIVE inherited_customers(id) AS (
    SELECT customer_id FROM memberships WHERE user_id = ${userIdSql}
    UNION
    SELECT child.id FROM customers child JOIN inherited_customers parent ON child.parent_id = parent.id
  ) SELECT id FROM inherited_customers)`;
}

// Live mutation guard for work that may await external storage after its initial
// permission check. Optional ownership is used by notes: scoped administrators
// may edit any uploader's notes, while developers may only edit their own.
export function projectAccessSql(
  projectIdSql: string,
  userIdSql: string,
  action: Action,
  ownerIdSql?: string,
): string {
  const roles = (Object.keys(ROLE_GRANTS) as CustomerRole[])
    .filter((role) => roleHas(role, action)).map((role) => `'${role}'`).join(', ');
  return `EXISTS (
    SELECT 1 FROM users permission_user JOIN projects permission_project ON permission_project.id = ${projectIdSql}
    LEFT JOIN user_global_roles permission_global ON permission_global.user_id = permission_user.id
    LEFT JOIN project_memberships permission_pm
      ON permission_pm.project_id = permission_project.id AND permission_pm.user_id = permission_user.id
    LEFT JOIN memberships permission_cm
      ON permission_cm.id = ${customerMembershipIdSql('permission_project.customer_id', 'permission_user.id')}
    WHERE permission_user.id = ${userIdSql} AND permission_user.is_active = 1 AND (
      COALESCE(permission_global.role, permission_user.role) IN ('super_admin', 'admin')
      ${GLOBAL_OBSERVER_ACTIONS.has(action) ? "OR COALESCE(permission_global.role, permission_user.role) = 'observer'" : ''}
      OR (COALESCE(permission_global.role, permission_user.role) = 'developer'
        AND COALESCE(permission_pm.role, permission_cm.role) IN (${roles})
        ${ownerIdSql ? `AND (permission_user.id = ${ownerIdSql} OR COALESCE(permission_pm.role, permission_cm.role) = 'customer_admin')` : ''})
    )
  )`;
}

export async function effectiveRoleOnCustomer(
  db: D1Database,
  userId: number,
  customerId: number,
): Promise<CustomerRole | null> {
  const row = await db
    .prepare(`SELECT role FROM memberships WHERE id = ${customerMembershipIdSql('?', '?')}`)
    .bind(customerId, userId)
    .first<{ role: CustomerRole }>();
  return row?.role ?? null;
}

export async function effectiveRoleOnProject(
  db: D1Database,
  userId: number,
  projectId: number,
): Promise<CustomerRole | null> {
  const row = await db.prepare(`SELECT COALESCE(pm.role, cm.role) AS role FROM projects p
    LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?
    LEFT JOIN memberships cm ON cm.id = ${customerMembershipIdSql('p.customer_id', '?')}
    WHERE p.id = ?`).bind(userId, userId, projectId).first<{ role: CustomerRole | null }>();
  return row?.role ?? null;
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
  const rows = await db.prepare(`SELECT id FROM customers WHERE id IN ${inheritedCustomerIdsSql('?')}
    UNION SELECT p.customer_id AS id FROM project_memberships pm
      JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ?`)
    .bind(user.id, user.id).all<{ id: number }>();
  return (rows.results ?? []).map((row) => row.id);
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
        WHERE p.customer_id IN ${inheritedCustomerIdsSql('?')}
           OR EXISTS (SELECT 1 FROM project_memberships pm WHERE pm.user_id = ? AND pm.project_id = p.id)`,
    )
    .bind(user.id, user.id)
    .all<{ id: number }>();
  return (rows.results ?? []).map((r) => r.id);
}
