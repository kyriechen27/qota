import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { AppEnv } from '../env';
import { requireUser, requireAdmin } from '../middleware/auth';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
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
  parent_id: number | null;
  code: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function dto(r: CustomerRow) {
  return {
    id: r.id,
    parentId: r.parent_id,
    code: r.code,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function routeId(value: string) {
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) throw badRequest('invalid id');
  return id;
}

async function validateParent(db: D1Database, value: unknown, id?: number): Promise<number | null> {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw badRequest('parentId must be a positive integer or null');
  if (value === id) throw badRequest('a customer cannot be its own parent');
  if (!await db.prepare('SELECT id FROM customers WHERE id = ?').bind(value).first()) throw notFound('parent customer not found');
  if (id !== undefined) {
    const cycle = await db.prepare(`WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM customers WHERE id = ?
      UNION SELECT c.id, c.parent_id FROM customers c JOIN ancestors a ON c.id = a.parent_id
    ) SELECT id FROM ancestors WHERE id = ?`).bind(value, id).first();
    if (cycle) throw badRequest('a customer cannot be moved under its descendant');
  }
  return value;
}

function customerWriteError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('customer_hierarchy_cycle')) throw badRequest('a customer cannot be moved under itself or its descendant');
  if (message.includes('FOREIGN KEY constraint failed')) throw conflict('customer relationships changed; refresh before retrying');
  if (message.includes('UNIQUE constraint failed: customers.code')) throw conflict('code already exists');
  throw error;
}

customerRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const visible = await visibleCustomerIds(c.env.DB, user);
  let rows;
  if (visible === null) {
    rows = await c.env.DB.prepare(
      'SELECT id, parent_id, code, name, description, created_at, updated_at FROM customers ORDER BY name ASC',
    ).all<CustomerRow>();
  } else if (visible.length === 0) {
    return c.json([]);
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id, parent_id, code, name, description, created_at, updated_at FROM customers
       WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name ASC`,
    )
      .bind(JSON.stringify(visible))
      .all<CustomerRow>();
  }
  return c.json((rows.results ?? []).map(dto));
});

customerRoutes.get('/:id', async (c) => {
  const id = routeId(c.req.param('id'));
  const user = c.get('user')!;
  const row = await requireCustomerAccess(c.env.DB, user, id, 'view');
  const full = await c.env.DB.prepare(
    'SELECT id, parent_id, code, name, description, created_at, updated_at FROM customers WHERE id = ?',
  )
    .bind(row.id)
    .first<CustomerRow>();
  return c.json(dto(full!));
});

// Global admins can mint a new customer (tenancy bootstrap).
customerRoutes.post('/', requireAdmin, async (c) => {
  type CreateBody = { code?: string; name?: string; description?: string; parentId?: number | null };
  const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
  if (!body || typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name required');
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') throw badRequest('description must be a string or null');
  const parentId = await validateParent(c.env.DB, body.parentId);

  let code: string;
  if (body.code) {
    // Explicit code: validate + enforce uniqueness.
    if (typeof body.code !== 'string' || !CODE_RE.test(body.code)) throw badRequest('code must match [a-z0-9_-]');
    if (await customerCodeTaken(c.env.DB, body.code)) throw conflict('code already exists');
    code = body.code;
  } else {
    // Auto-generate from name (handles non-ASCII names via fallback prefix).
    code = await generateUniqueCode(body.name, 'customer', (cd) => customerCodeTaken(c.env.DB, cd));
  }

  const now = Date.now();
  const r = await c.env.DB.prepare(
    'INSERT INTO customers (code, name, description, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(code, body.name, body.description ?? null, parentId, now, now)
    .run().catch(customerWriteError);
  const id = Number(r.meta.last_row_id);
  const row = await c.env.DB.prepare(
    'SELECT id, parent_id, code, name, description, created_at, updated_at FROM customers WHERE id = ?',
  )
    .bind(id)
    .first<CustomerRow>();
  await audit(c, { action: 'customer.create', customerId: id, targetType: 'customer', targetId: id, meta: { code, name: body.name, parentId } });
  return c.json(dto(row!), 201);
});

customerRoutes.patch('/:id', async (c) => {
  const id = routeId(c.req.param('id'));
  const user = c.get('user')!;
  await requireCustomerAccess(c.env.DB, user, id, 'manage_customer');
  type PatchBody = { name?: string; description?: string | null; parentId?: number | null };
  const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('customer fields required');
  if (body.parentId !== undefined) {
    if (user.role !== 'admin' && user.role !== 'super_admin') throw forbidden('only global administrators can change the parent customer');
    const parentId = await validateParent(c.env.DB, body.parentId, id);
    sets.push('parent_id = ?');
    args.push(parentId);
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name required');
    sets.push('name = ?');
    args.push(body.name);
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') throw badRequest('description must be a string or null');
    sets.push('description = ?');
    args.push(body.description);
  }
  if (sets.length === 0) return c.json({ ok: true });
  sets.push('updated_at = ?');
  args.push(Date.now());
  args.push(id);
  const result = await c.env.DB.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run().catch(customerWriteError);
  if (!result.meta.changes) throw notFound();
  const row = await c.env.DB.prepare(
    'SELECT id, parent_id, code, name, description, created_at, updated_at FROM customers WHERE id = ?',
  )
    .bind(id)
    .first<CustomerRow>();
  await audit(c, { action: 'customer.update', customerId: id, targetType: 'customer', targetId: id, meta: { fields: Object.keys(body) } });
  return c.json(dto(row!));
});

customerRoutes.delete('/:id', requireAdmin, async (c) => {
  const id = routeId(c.req.param('id'));
  const r = await c.env.DB.prepare(`DELETE FROM customers WHERE id = ? AND NOT EXISTS (
    SELECT 1 FROM customers child WHERE child.parent_id = customers.id
  )`).bind(id).run().catch(customerWriteError);
  if (r.meta.changes === 0) {
    if (await c.env.DB.prepare('SELECT id FROM customers WHERE id = ?').bind(id).first()) throw conflict('move or delete child customers before deleting this customer');
    throw notFound();
  }
  await audit(c, { action: 'customer.delete', customerId: id, targetType: 'customer', targetId: id });
  return c.json({ ok: true });
});
