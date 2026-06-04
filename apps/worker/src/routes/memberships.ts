// Customer- and project-scoped role grants.
//
// - GET    /api/memberships?customerId=N|projectId=N        list grants on a scope
// - POST   /api/memberships         { userId, customerId|projectId, role }
// - PATCH  /api/memberships/:id     { role }
// - DELETE /api/memberships/:id

import { Hono } from 'hono';
import type { AppEnv, CustomerRole } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, notFound } from '../utils/errors';
import { requireCustomerAccess, requireProjectAccess } from '../lib/memberships';
import { audit } from '../lib/audit';

export const membershipRoutes = new Hono<AppEnv>();

membershipRoutes.use('*', requireUser);

const ROLES: CustomerRole[] = ['customer_admin', 'developer', 'viewer'];

function isRole(s: unknown): s is CustomerRole {
  return typeof s === 'string' && (ROLES as string[]).includes(s);
}

interface MembershipRow {
  id: number;
  user_id: number;
  customer_id: number;
  role: CustomerRole;
  created_by: number | null;
  created_at: number;
}

interface ProjectMembershipRow {
  id: number;
  user_id: number;
  project_id: number;
  role: CustomerRole;
  created_by: number | null;
  created_at: number;
}

function dtoCust(r: MembershipRow) {
  return {
    id: r.id,
    userId: r.user_id,
    customerId: r.customer_id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at,
    scope: 'customer' as const,
  };
}

function dtoProj(r: ProjectMembershipRow) {
  return {
    id: r.id,
    userId: r.user_id,
    projectId: r.project_id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at,
    scope: 'project' as const,
  };
}

// LIST: requires manage_members on the queried scope (or super_admin via implicit pass).
membershipRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const customerIdQ = c.req.query('customerId');
  const projectIdQ = c.req.query('projectId');
  if (customerIdQ) {
    const customerId = Number(customerIdQ);
    if (!Number.isFinite(customerId)) throw badRequest('invalid customerId');
    await requireCustomerAccess(c.env.DB, user, customerId, 'manage_members');
    const rows = await c.env.DB.prepare(
      `SELECT id, user_id, customer_id, role, created_by, created_at FROM memberships WHERE customer_id = ? ORDER BY id ASC`,
    )
      .bind(customerId)
      .all<MembershipRow>();
    return c.json((rows.results ?? []).map(dtoCust));
  }
  if (projectIdQ) {
    const projectId = Number(projectIdQ);
    if (!Number.isFinite(projectId)) throw badRequest('invalid projectId');
    await requireProjectAccess(c.env.DB, user, projectId, 'manage_members');
    const rows = await c.env.DB.prepare(
      `SELECT id, user_id, project_id, role, created_by, created_at FROM project_memberships WHERE project_id = ? ORDER BY id ASC`,
    )
      .bind(projectId)
      .all<ProjectMembershipRow>();
    return c.json((rows.results ?? []).map(dtoProj));
  }
  // Default: list the caller's own memberships
  const cust = await c.env.DB.prepare(
    'SELECT id, user_id, customer_id, role, created_by, created_at FROM memberships WHERE user_id = ?',
  )
    .bind(user.id)
    .all<MembershipRow>();
  const proj = await c.env.DB.prepare(
    'SELECT id, user_id, project_id, role, created_by, created_at FROM project_memberships WHERE user_id = ?',
  )
    .bind(user.id)
    .all<ProjectMembershipRow>();
  return c.json([
    ...(cust.results ?? []).map(dtoCust),
    ...(proj.results ?? []).map(dtoProj),
  ]);
});

// CREATE grant
membershipRoutes.post('/', async (c) => {
  const me = c.get('user')!;
  type CreateBody = {
    userId?: number;
    customerId?: number;
    projectId?: number;
    role?: CustomerRole;
  };
  const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
  if (!body.userId || !isRole(body.role)) throw badRequest('userId and role required');
  const role = body.role;

  const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(body.userId).first();
  if (!targetUser) throw notFound('user not found');

  if (body.customerId && body.projectId) throw badRequest('specify exactly one of customerId or projectId');
  if (!body.customerId && !body.projectId) throw badRequest('customerId or projectId required');

  const now = Date.now();
  if (body.customerId) {
    await requireCustomerAccess(c.env.DB, me, body.customerId, 'manage_members');
    const dup = await c.env.DB.prepare(
      'SELECT id FROM memberships WHERE user_id = ? AND customer_id = ?',
    )
      .bind(body.userId, body.customerId)
      .first();
    if (dup) throw conflict('membership already exists; use PATCH to change role');
    const r = await c.env.DB.prepare(
      `INSERT INTO memberships (user_id, customer_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(body.userId, body.customerId, role, me.id, now)
      .run();
    const id = Number(r.meta.last_row_id);
    const row = await c.env.DB.prepare(
      'SELECT id, user_id, customer_id, role, created_by, created_at FROM memberships WHERE id = ?',
    )
      .bind(id)
      .first<MembershipRow>();
    await audit(c, {
      action: 'membership.create',
      customerId: body.customerId,
      targetType: 'membership',
      targetId: id,
      meta: { userId: body.userId, role, scope: 'customer' },
    });
    return c.json(dtoCust(row!), 201);
  }

  // project scope
  const projectId = body.projectId!;
  const project = await requireProjectAccess(c.env.DB, me, projectId, 'manage_members');
  const dup = await c.env.DB.prepare(
    'SELECT id FROM project_memberships WHERE user_id = ? AND project_id = ?',
  )
    .bind(body.userId, projectId)
    .first();
  if (dup) throw conflict('membership already exists; use PATCH to change role');
  const r = await c.env.DB.prepare(
    `INSERT INTO project_memberships (user_id, project_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(body.userId, projectId, role, me.id, now)
    .run();
  const id = Number(r.meta.last_row_id);
  const row = await c.env.DB.prepare(
    'SELECT id, user_id, project_id, role, created_by, created_at FROM project_memberships WHERE id = ?',
  )
    .bind(id)
    .first<ProjectMembershipRow>();
  await audit(c, {
    action: 'membership.create',
    customerId: project.customer_id,
    projectId,
    targetType: 'membership',
    targetId: id,
    meta: { userId: body.userId, role, scope: 'project' },
  });
  return c.json(dtoProj(row!), 201);
});

// PATCH role
membershipRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const scope = c.req.query('scope') ?? 'customer';
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  if (scope !== 'customer' && scope !== 'project') throw badRequest('scope must be customer or project');
  type PatchBody = { role?: CustomerRole };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  if (!isRole(body.role)) throw badRequest('role required');
  const me = c.get('user')!;

  if (scope === 'customer') {
    const row = await c.env.DB.prepare(
      'SELECT id, user_id, customer_id, role, created_by, created_at FROM memberships WHERE id = ?',
    )
      .bind(id)
      .first<MembershipRow>();
    if (!row) throw notFound();
    await requireCustomerAccess(c.env.DB, me, row.customer_id, 'manage_members');
    await c.env.DB.prepare('UPDATE memberships SET role = ? WHERE id = ?').bind(body.role, id).run();
    await audit(c, {
      action: 'membership.update',
      customerId: row.customer_id,
      targetType: 'membership',
      targetId: id,
      meta: { from: row.role, to: body.role, scope },
    });
    const updated = await c.env.DB.prepare(
      'SELECT id, user_id, customer_id, role, created_by, created_at FROM memberships WHERE id = ?',
    )
      .bind(id)
      .first<MembershipRow>();
    return c.json(dtoCust(updated!));
  }

  const row = await c.env.DB.prepare(
    'SELECT id, user_id, project_id, role, created_by, created_at FROM project_memberships WHERE id = ?',
  )
    .bind(id)
    .first<ProjectMembershipRow>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_members');
  await c.env.DB.prepare('UPDATE project_memberships SET role = ? WHERE id = ?').bind(body.role, id).run();
  await audit(c, {
    action: 'membership.update',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'membership',
    targetId: id,
    meta: { from: row.role, to: body.role, scope },
  });
  const updated = await c.env.DB.prepare(
    'SELECT id, user_id, project_id, role, created_by, created_at FROM project_memberships WHERE id = ?',
  )
    .bind(id)
    .first<ProjectMembershipRow>();
  return c.json(dtoProj(updated!));
});

// DELETE
membershipRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const scope = c.req.query('scope') ?? 'customer';
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  if (scope !== 'customer' && scope !== 'project') throw badRequest('scope must be customer or project');
  const me = c.get('user')!;
  if (scope === 'customer') {
    const row = await c.env.DB.prepare('SELECT customer_id FROM memberships WHERE id = ?')
      .bind(id)
      .first<{ customer_id: number }>();
    if (!row) throw notFound();
    await requireCustomerAccess(c.env.DB, me, row.customer_id, 'manage_members');
    await c.env.DB.prepare('DELETE FROM memberships WHERE id = ?').bind(id).run();
    await audit(c, {
      action: 'membership.delete',
      customerId: row.customer_id,
      targetType: 'membership',
      targetId: id,
      meta: { scope },
    });
    return c.json({ ok: true });
  }
  const row = await c.env.DB.prepare('SELECT project_id FROM project_memberships WHERE id = ?')
    .bind(id)
    .first<{ project_id: number }>();
  if (!row) throw notFound();
  const proj = await requireProjectAccess(c.env.DB, me, row.project_id, 'manage_members');
  await c.env.DB.prepare('DELETE FROM project_memberships WHERE id = ?').bind(id).run();
  await audit(c, {
    action: 'membership.delete',
    customerId: proj.customer_id,
    projectId: row.project_id,
    targetType: 'membership',
    targetId: id,
    meta: { scope },
  });
  return c.json({ ok: true });
});
