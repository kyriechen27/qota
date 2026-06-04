import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest, conflict, notFound } from '../utils/errors';
import {
  visibleProjectIds,
  requireProjectAccess,
  requireCustomerAccess,
} from '../lib/memberships';
import { audit } from '../lib/audit';
import { generateUniqueCode, projectCodeTaken } from '../utils/slug';

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.use('*', requireUser);

interface ProjectRow {
  id: number;
  customer_id: number;
  code: string;
  name: string;
  description: string | null;
  default_channel: string;
  created_at: number;
  updated_at: number;
}

function dto(r: ProjectRow) {
  return {
    id: r.id,
    customerId: r.customer_id,
    code: r.code,
    name: r.name,
    description: r.description,
    defaultChannel: r.default_channel,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

projectRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const customerIdQ = c.req.query('customerId');
  const customerId = customerIdQ ? Number(customerIdQ) : undefined;
  if (customerIdQ && !Number.isFinite(customerId)) throw badRequest('invalid customerId');

  const visible = await visibleProjectIds(c.env.DB, user);
  const conditions: string[] = [];
  const args: unknown[] = [];
  if (customerId !== undefined) {
    conditions.push('customer_id = ?');
    args.push(customerId);
  }
  if (visible !== null) {
    if (visible.length === 0) return c.json([]);
    conditions.push(`id IN (${visible.map(() => '?').join(',')})`);
    args.push(...visible);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await c.env.DB.prepare(
    `SELECT id, customer_id, code, name, description, default_channel, created_at, updated_at FROM projects ${where} ORDER BY name ASC`,
  )
    .bind(...args)
    .all<ProjectRow>();
  return c.json((rows.results ?? []).map(dto));
});

projectRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  await requireProjectAccess(c.env.DB, user, id, 'view');
  const row = await c.env.DB.prepare(
    'SELECT id, customer_id, code, name, description, default_channel, created_at, updated_at FROM projects WHERE id = ?',
  )
    .bind(id)
    .first<ProjectRow>();
  return c.json(dto(row!));
});

projectRoutes.post('/', async (c) => {
  type CreateBody = {
    customerId?: number;
    code?: string;
    name?: string;
    description?: string;
    defaultChannel?: string;
  };
  const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
  if (!body.customerId || !body.name) {
    throw badRequest('customerId and name required');
  }
  if (body.defaultChannel && !CHANNEL_RE.test(body.defaultChannel)) {
    throw badRequest('defaultChannel invalid');
  }
  const user = c.get('user')!;
  await requireCustomerAccess(c.env.DB, user, body.customerId, 'manage_projects');

  const customerId = body.customerId;
  let code: string;
  if (body.code) {
    if (!CODE_RE.test(body.code)) throw badRequest('code must match [a-z0-9_-]');
    if (await projectCodeTaken(c.env.DB, customerId, body.code)) {
      throw conflict('code already exists for this customer');
    }
    code = body.code;
  } else {
    code = await generateUniqueCode(body.name, 'project', (cd) => projectCodeTaken(c.env.DB, customerId, cd));
  }

  const now = Date.now();
  const r = await c.env.DB.prepare(
    `INSERT INTO projects (customer_id, code, name, description, default_channel, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      customerId,
      code,
      body.name,
      body.description ?? null,
      body.defaultChannel ?? 'stable',
      now,
      now,
    )
    .run();
  const id = Number(r.meta.last_row_id);
  const row = await c.env.DB.prepare(
    'SELECT id, customer_id, code, name, description, default_channel, created_at, updated_at FROM projects WHERE id = ?',
  )
    .bind(id)
    .first<ProjectRow>();
  await audit(c, {
    action: 'project.create',
    customerId,
    projectId: id,
    targetType: 'project',
    targetId: id,
    meta: { code, name: body.name },
  });
  return c.json(dto(row!), 201);
});

projectRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const proj = await requireProjectAccess(c.env.DB, user, id, 'manage_projects');
  type PatchBody = {
    name?: string;
    description?: string | null;
    defaultChannel?: string;
  };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    args.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    args.push(body.description);
  }
  if (body.defaultChannel !== undefined) {
    if (!CHANNEL_RE.test(body.defaultChannel)) throw badRequest('defaultChannel invalid');
    sets.push('default_channel = ?');
    args.push(body.defaultChannel);
  }
  if (sets.length === 0) return c.json({ ok: true });
  sets.push('updated_at = ?');
  args.push(Date.now());
  args.push(id);
  await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const row = await c.env.DB.prepare(
    'SELECT id, customer_id, code, name, description, default_channel, created_at, updated_at FROM projects WHERE id = ?',
  )
    .bind(id)
    .first<ProjectRow>();
  await audit(c, {
    action: 'project.update',
    customerId: proj.customer_id,
    projectId: id,
    targetType: 'project',
    targetId: id,
    meta: { fields: Object.keys(body) },
  });
  return c.json(dto(row!));
});

projectRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const proj = await requireProjectAccess(c.env.DB, user, id, 'manage_projects');
  const r = await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  if (r.meta.changes === 0) throw notFound();
  await audit(c, {
    action: 'project.delete',
    customerId: proj.customer_id,
    projectId: id,
    targetType: 'project',
    targetId: id,
  });
  return c.json({ ok: true });
});
