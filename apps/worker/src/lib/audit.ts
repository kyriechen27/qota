// Append-only audit logger.
//
// Usage: `await audit(c, { action: 'version.upload.complete', projectId, targetType: 'version', targetId, meta: {...} })`.
// Actor is auto-derived from c.get('user') / c.get('apiToken') unless overridden.

import type { Context } from 'hono';
import type { AppEnv } from '../env';

export type ActorType = 'user' | 'api_token' | 'system';

export interface AuditEvent {
  action: string;
  actorType?: ActorType;
  actorId?: number | null;
  customerId?: number | null;
  projectId?: number | null;
  targetType?: string | null;
  targetId?: number | null;
  meta?: Record<string, unknown> | null;
}

export async function audit(c: Context<AppEnv>, ev: AuditEvent): Promise<void> {
  let actorType: ActorType;
  let actorId: number | null = null;
  if (ev.actorType !== undefined) {
    actorType = ev.actorType;
    actorId = ev.actorId ?? null;
  } else {
    const user = c.get('user');
    const tok = c.get('apiToken');
    if (user) {
      actorType = 'user';
      actorId = user.id;
    } else if (tok) {
      actorType = 'api_token';
      actorId = tok.id;
    } else {
      actorType = 'system';
    }
  }

  const ip =
    c.req.header('CF-Connecting-IP') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  const ua = c.req.header('user-agent') ?? null;

  try {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs
         (ts, actor_type, actor_id, customer_id, project_id, action, target_type, target_id, ip, user_agent, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        Date.now(),
        actorType,
        actorId,
        ev.customerId ?? null,
        ev.projectId ?? null,
        ev.action,
        ev.targetType ?? null,
        ev.targetId ?? null,
        ip,
        ua,
        ev.meta ? JSON.stringify(ev.meta) : null,
      )
      .run();
  } catch (e) {
    // Audit failures must not break the request flow — log and move on.
    console.error('[audit] insert failed', ev.action, e);
  }
}
