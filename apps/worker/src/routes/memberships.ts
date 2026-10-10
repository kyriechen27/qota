// Customer- and project-scoped role grants.
//
// - GET    /api/memberships?customerId=N|projectId=N        list grants on a scope
// - POST   /api/memberships         { userId, customerId|projectId, role }
// - PATCH  /api/memberships/:id     { role }
// - DELETE /api/memberships/:id

import { Hono } from 'hono';
import type { AppEnv, CustomerRole } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { requireCustomerAccess, requireProjectAccess } from '../lib/memberships';
import { audit } from '../lib/audit';

export const membershipRoutes = new Hono<AppEnv>();

membershipRoutes.use('*', requireUser);

const ROLES: CustomerRole[] = ['customer_admin', 'developer', 'viewer'];

function isRole(s: unknown): s is CustomerRole {
  return typeof s === 'string' && (ROLES as string[]).includes(s);
}

function positiveId(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw badRequest(`invalid ${field}`);
  return value;
}

function queryId(value: string, field: string): number {
  if (!/^\d+$/.test(value)) throw badRequest(`invalid ${field}`);
  return positiveId(Number(value), field);
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
  if (customerIdQ !== undefined && projectIdQ !== undefined) throw badRequest('specify exactly one of customerId or projectId');
  if (customerIdQ !== undefined) {
    const customerId = queryId(customerIdQ, 'customerId');
    await requireCustomerAccess(c.env.DB, user, customerId, 'manage_members');
    const rows = await c.env.DB.prepare(
      `SELECT id, user_id, customer_id, role, created_by, created_at FROM memberships WHERE customer_id = ? ORDER BY id ASC`,
    )
      .bind(customerId)
      .all<MembershipRow>();
    return c.json((rows.results ?? []).map(dtoCust));
  }
  if (projectIdQ !== undefined) {
    const projectId = queryId(projectIdQ, 'projectId');
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

// Every requested project is independently authorized. A single guarded INSERT
// is atomic and fits D1's parameter limit even for the maximum of 200 projects.
membershipRoutes.post('/batch', async (c) => {
  const me = c.get('user')!;
  const body = await c.req.json<{ userId?: unknown; projectIds?: unknown; role?: unknown }>().catch(() => null);
  if (!body || !isRole(body.role)) throw badRequest('userId, projectIds and role required');
  const userId = positiveId(body.userId, 'userId');
  if (!Array.isArray(body.projectIds) || body.projectIds.length < 1 || body.projectIds.length > 200) {
    throw badRequest('projectIds must contain 1-200 distinct project ids');
  }
  const projectIds = body.projectIds.map((id) => positiveId(id, 'projectId'));
  if (new Set(projectIds).size !== projectIds.length) throw badRequest('projectIds must not contain duplicates');
  const role = body.role;
  const idsJson = JSON.stringify(projectIds);
  if (!await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()) throw notFound('user not found');

  const projects = await c.env.DB.prepare(`SELECT p.id, p.customer_id, COALESCE(pm.role, cm.role) AS role
    FROM projects p
    LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?
    LEFT JOIN memberships cm ON cm.customer_id = p.customer_id AND cm.user_id = ?
    WHERE p.id IN (SELECT value FROM json_each(?))`).bind(me.id, me.id, idsJson)
    .all<{ id: number; customer_id: number; role: CustomerRole | null }>();
  const projectMap = new Map((projects.results ?? []).map((project) => [project.id, project]));
  for (const id of projectIds) {
    const project = projectMap.get(id);
    if (!project) throw notFound('project not found');
    if (me.role !== 'admin' && me.role !== 'super_admin' && (me.role !== 'developer' || project.role !== 'customer_admin')) {
      throw forbidden(`no 'manage_members' permission on project ${id}`);
    }
  }
  const duplicate = await c.env.DB.prepare(`SELECT id FROM project_memberships
    WHERE user_id = ? AND project_id IN (SELECT value FROM json_each(?)) LIMIT 1`).bind(userId, idsJson).first();
  if (duplicate) throw conflict('membership already exists; use PATCH to change role');
  const now = Date.now();
  const result = await c.env.DB.prepare(`WITH
    requested AS MATERIALIZED (SELECT value AS project_id FROM json_each(?)),
    authorized AS MATERIALIZED (
      SELECT p.id FROM requested r JOIN projects p ON p.id = r.project_id
      JOIN users actor ON actor.id = ?
      LEFT JOIN user_global_roles gr ON gr.user_id = actor.id
      LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = actor.id
      LEFT JOIN memberships cm ON cm.customer_id = p.customer_id AND cm.user_id = actor.id
      WHERE actor.is_active = 1 AND (
        COALESCE(gr.role, actor.role) IN ('super_admin', 'admin') OR
        (COALESCE(gr.role, actor.role) = 'developer' AND COALESCE(pm.role, cm.role) = 'customer_admin')
      )
    ),
    eligible AS MATERIALIZED (
      SELECT 1 WHERE (SELECT COUNT(*) FROM authorized) = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM project_memberships existing
          JOIN requested r ON r.project_id = existing.project_id WHERE existing.user_id = ?)
    )
    INSERT INTO project_memberships (user_id, project_id, role, created_by, created_at)
    SELECT ?, requested.project_id, ?, ?, ? FROM requested CROSS JOIN eligible`)
    .bind(idsJson, me.id, projectIds.length, userId, userId, userId, role, me.id, now).run();
  if (result.meta.changes !== projectIds.length) throw conflict('memberships or permissions changed; refresh before retrying');
  const rows = await c.env.DB.prepare(`SELECT id, user_id, project_id, role, created_by, created_at
    FROM project_memberships WHERE user_id = ? AND project_id IN (SELECT value FROM json_each(?))`)
    .bind(userId, idsJson).all<ProjectMembershipRow>();
  const rowMap = new Map((rows.results ?? []).map((row) => [row.project_id, row]));
  // Keep one traceable audit event per project without spending one D1 query
  // per recipient scope. Like audit(), logging must not fail a successful grant.
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  try {
    await c.env.DB.prepare(`INSERT INTO audit_logs
      (ts, actor_type, actor_id, customer_id, project_id, action, target_type, target_id, ip, user_agent, meta)
      SELECT ?, 'user', ?, p.customer_id, pm.project_id, 'membership.create', 'membership', pm.id, ?, ?, ?
      FROM project_memberships pm JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id = ? AND pm.project_id IN (SELECT value FROM json_each(?))`)
      .bind(now, me.id, ip, c.req.header('user-agent') ?? null,
        JSON.stringify({ userId, role, scope: 'project', batchKey: crypto.randomUUID(), batchSize: projectIds.length }),
        userId, idsJson).run();
  } catch (error) {
    console.error('[audit] batch membership insert failed', error);
  }
  return c.json({ items: projectIds.map((id) => dtoProj(rowMap.get(id)!)) }, 201);
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
  if (!body || !isRole(body.role)) throw badRequest('userId and role required');
  const userId = positiveId(body.userId, 'userId');
  const role = body.role;

  const targetUser = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!targetUser) throw notFound('user not found');

  if ((body.customerId !== undefined) === (body.projectId !== undefined)) throw badRequest('specify exactly one of customerId or projectId');
  if (body.customerId !== undefined) positiveId(body.customerId, 'customerId');
  if (body.projectId !== undefined) positiveId(body.projectId, 'projectId');

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
  const id = queryId(c.req.param('id'), 'id');
  const scope = c.req.query('scope') ?? 'customer';
  if (scope !== 'customer' && scope !== 'project') throw badRequest('scope must be customer or project');
  type PatchBody = { role?: CustomerRole };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  if (!body || !isRole(body.role)) throw badRequest('role required');
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
  const id = queryId(c.req.param('id'), 'id');
  const scope = c.req.query('scope') ?? 'customer';
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
