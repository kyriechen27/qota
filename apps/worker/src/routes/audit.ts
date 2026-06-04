// Audit log reader. Scoped by caller's visibility:
//   - super_admin sees everything (optionally filtered)
//   - others see logs for customers/projects they have manage_members rights on
//     (else they could only see their own actions, which we expose separately)

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireUser } from '../middleware/auth';
import { badRequest } from '../utils/errors';
import {
  canDoOnCustomer,
  canDoOnProject,
  visibleCustomerIds,
  visibleProjectIds,
} from '../lib/memberships';

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.use('*', requireUser);

interface Row {
  id: number;
  ts: number;
  actor_type: 'user' | 'api_token' | 'system';
  actor_id: number | null;
  customer_id: number | null;
  project_id: number | null;
  action: string;
  target_type: string | null;
  target_id: number | null;
  ip: string | null;
  user_agent: string | null;
  meta: string | null;
}

function dto(r: Row) {
  let meta: Record<string, unknown> | null = null;
  if (r.meta) {
    try {
      meta = JSON.parse(r.meta);
    } catch {
      meta = { _raw: r.meta };
    }
  }
  return {
    id: r.id,
    ts: r.ts,
    actorType: r.actor_type,
    actorId: r.actor_id,
    customerId: r.customer_id,
    projectId: r.project_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    ip: r.ip,
    userAgent: r.user_agent,
    meta,
  };
}

auditRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? '100')));
  const before = c.req.query('before') ? Number(c.req.query('before')) : undefined;
  const customerIdQ = c.req.query('customerId');
  const projectIdQ = c.req.query('projectId');
  const actionQ = c.req.query('action');

  const where: string[] = [];
  const args: unknown[] = [];

  if (projectIdQ) {
    const pid = Number(projectIdQ);
    if (!Number.isFinite(pid)) throw badRequest('invalid projectId');
    const ok = await canDoOnProject(c.env.DB, user, pid, 'manage_members');
    if (!ok && user.role !== 'super_admin') {
      // Fall back to "my own actions on this project"
      where.push('project_id = ? AND actor_type = ? AND actor_id = ?');
      args.push(pid, 'user', user.id);
    } else {
      where.push('project_id = ?');
      args.push(pid);
    }
  } else if (customerIdQ) {
    const cid = Number(customerIdQ);
    if (!Number.isFinite(cid)) throw badRequest('invalid customerId');
    const ok = await canDoOnCustomer(c.env.DB, user, cid, 'manage_members');
    if (!ok && user.role !== 'super_admin') {
      where.push('customer_id = ? AND actor_type = ? AND actor_id = ?');
      args.push(cid, 'user', user.id);
    } else {
      where.push('customer_id = ?');
      args.push(cid);
    }
  } else if (user.role !== 'super_admin') {
    // No specific scope; restrict to logs the user can see.
    const visibleCust = await visibleCustomerIds(c.env.DB, user);
    const visibleProj = await visibleProjectIds(c.env.DB, user);
    const clauses: string[] = ['(actor_type = ? AND actor_id = ?)'];
    args.push('user', user.id);
    if (visibleCust && visibleCust.length > 0) {
      clauses.push(`customer_id IN (${visibleCust.map(() => '?').join(',')})`);
      args.push(...visibleCust);
    }
    if (visibleProj && visibleProj.length > 0) {
      clauses.push(`project_id IN (${visibleProj.map(() => '?').join(',')})`);
      args.push(...visibleProj);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }

  if (actionQ) {
    where.push('action = ?');
    args.push(actionQ);
  }
  if (before) {
    where.push('ts < ?');
    args.push(before);
  }

  const sql = `SELECT id, ts, actor_type, actor_id, customer_id, project_id, action, target_type, target_id, ip, user_agent, meta
                 FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY ts DESC LIMIT ?`;
  args.push(limit);
  const rows = await c.env.DB.prepare(sql).bind(...args).all<Row>();
  return c.json((rows.results ?? []).map(dto));
});
