import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser, requireSuperAdmin } from '../middleware/auth';
import { badRequest, conflict, notFound } from '../utils/errors';
import {
  visibleCustomerIds,
  requireCustomerAccess,
} from '../lib/memberships';
import { audit } from '../lib/audit';
import { generateUniqueCode, customerCodeTaken } from '../utils/slug';

export const customerRoutes = new Hono<AppEnv>();

customerRoutes.use('*', requireUser);

interface CustomerRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function dto(r: CustomerRow) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

customerRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const visible = await visibleCustomerIds(c.env.DB, user);
  let rows;
  if (visible === null) {
    rows = await c.env.DB.prepare(
      'SELECT id, code, name, description, created_at, updated_at FROM customers ORDER BY name ASC',
    ).all<CustomerRow>();
  } else if (visible.length === 0) {
    return c.json([]);
  } else {
    const placeholders = visible.map(() => '?').join(',');
    rows = await c.env.DB.prepare(
      `SELECT id, code, name, description, created_at, updated_at FROM customers WHERE id IN (${placeholders}) ORDER BY name ASC`,
    )
      .bind(...visible)
      .all<CustomerRow>();
  }
  return c.json((rows.results ?? []).map(dto));
});

customerRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  const row = await requireCustomerAccess(c.env.DB, user, id, 'view');
  const full = await c.env.DB.prepare(
    'SELECT id, code, name, description, created_at, updated_at FROM customers WHERE id = ?',
  )
    .bind(row.id)
    .first<CustomerRow>();
  return c.json(dto(full!));
});

// Only super_admin can mint a new customer (tenancy bootstrap).
customerRoutes.post('/', requireSuperAdmin, async (c) => {
  type CreateBody = { code?: string; name?: string; description?: string };
  const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
  if (!body.name) throw badRequest('name required');

  let code: string;
  if (body.code) {
    // Explicit code: validate + enforce uniqueness.
    if (!CODE_RE.test(body.code)) throw badRequest('code must match [a-z0-9_-]');
    if (await customerCodeTaken(c.env.DB, body.code)) throw conflict('code already exists');
    code = body.code;
  } else {
    // Auto-generate from name (handles non-ASCII names via fallback prefix).
    code = await generateUniqueCode(body.name, 'customer', (cd) => customerCodeTaken(c.env.DB, cd));
  }

  const now = Date.now();
  const r = await c.env.DB.prepare(
    'INSERT INTO customers (code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(code, body.name, body.description ?? null, now, now)
    .run();
  const id = Number(r.meta.last_row_id);
  const row = await c.env.DB.prepare(
    'SELECT id, code, name, description, created_at, updated_at FROM customers WHERE id = ?',
  )
    .bind(id)
    .first<CustomerRow>();
  await audit(c, { action: 'customer.create', customerId: id, targetType: 'customer', targetId: id, meta: { code, name: body.name } });
  return c.json(dto(row!), 201);
});

customerRoutes.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const user = c.get('user')!;
  await requireCustomerAccess(c.env.DB, user, id, 'manage_customer');
  type PatchBody = { name?: string; description?: string | null };
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
  if (sets.length === 0) return c.json({ ok: true });
  sets.push('updated_at = ?');
  args.push(Date.now());
  args.push(id);
  await c.env.DB.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const row = await c.env.DB.prepare(
    'SELECT id, code, name, description, created_at, updated_at FROM customers WHERE id = ?',
  )
    .bind(id)
    .first<CustomerRow>();
  await audit(c, { action: 'customer.update', customerId: id, targetType: 'customer', targetId: id, meta: { fields: Object.keys(body) } });
  return c.json(dto(row!));
});

customerRoutes.delete('/:id', requireSuperAdmin, async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) throw badRequest('invalid id');
  const r = await c.env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();
  if (r.meta.changes === 0) throw notFound();
  await audit(c, { action: 'customer.delete', customerId: id, targetType: 'customer', targetId: id });
  return c.json({ ok: true });
});
