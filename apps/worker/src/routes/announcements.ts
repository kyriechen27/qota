import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Announcement } from '@qota/shared';
import type { AppEnv, AuthedUser, CustomerRole } from '../env';
import { requireUser } from '../middleware/auth';
import { customerMembershipIdSql, requireProjectAccess } from '../lib/memberships';
import { announcementContent, requireAnnouncementAuthor, ANNOUNCEMENT_AUTHOR_CAN_PUBLISH_SQL, ANNOUNCEMENT_CAN_MANAGE_SQL } from '../lib/announcements';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { announcementRecipientIds, announcementRecipients, validateAnnouncementRecipients, queueAnnouncementMail, sendAnnouncementMail } from '../lib/announcement-mail';

export const announcementRoutes = new Hono<AppEnv>();
announcementRoutes.use('*', requireUser);

interface AnnouncementRow {
  id: number;
  project_id: number;
  project_name: string;
  customer_name: string;
  version: string | null;
  content: string;
  author_id: number;
  author_name: string;
  created_at: number;
  updated_at: number;
  project_role: CustomerRole | null;
  mail_total: number;
  mail_sent: number;
  mail_failed: number;
  mail_pending: number;
  mail_skipped: number;
}

const SELECT_ANNOUNCEMENTS = `SELECT a.id, a.project_id, p.name AS project_name, c.name AS customer_name,
  a.version, a.content, a.author_id, COALESCE(NULLIF(u.display_name, ''), u.email) AS author_name,
  a.created_at, a.updated_at, COALESCE(pm.role, cm.role) AS project_role,
  COALESCE(mail.total, 0) AS mail_total, COALESCE(mail.sent, 0) AS mail_sent,
  COALESCE(mail.failed, 0) AS mail_failed, COALESCE(mail.pending, 0) AS mail_pending,
  COALESCE(mail.skipped, 0) AS mail_skipped
  FROM announcements a
  JOIN projects p ON p.id = a.project_id
  JOIN customers c ON c.id = p.customer_id
  JOIN users u ON u.id = a.author_id
  LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?
  LEFT JOIN memberships cm ON cm.id = ${customerMembershipIdSql('p.customer_id', '?')}
  LEFT JOIN (
    SELECT announcement_id, COUNT(*) AS total,
      SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed,
      SUM(status IN ('pending', 'sending')) AS pending, SUM(status = 'skipped') AS skipped
    FROM announcement_mail_deliveries GROUP BY announcement_id
  ) mail ON mail.announcement_id = a.id`;

function globalAdmin(user: AuthedUser) {
  return user.role === 'admin' || user.role === 'super_admin';
}

function dto(row: AnnouncementRow, user: AuthedUser): Announcement {
  const canManage = row.author_id === user.id || globalAdmin(user) ||
    (user.role !== 'observer' && row.project_role === 'customer_admin');
  return {
    id: row.id, projectId: row.project_id, projectName: row.project_name, customerName: row.customer_name,
    version: row.version, content: row.content, authorId: row.author_id, authorName: row.author_name,
    createdAt: row.created_at, updatedAt: row.updated_at, canEdit: canManage, canDelete: canManage,
    mail: { total: row.mail_total, sent: row.mail_sent, failed: row.mail_failed, pending: row.mail_pending, skipped: row.mail_skipped },
  };
}

function positiveInteger(value: unknown, name: string): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw badRequest(`valid ${name} required`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw badRequest(`valid ${name} required`);
  return number;
}

async function loadAnnouncement(db: D1Database, user: AuthedUser, id: number) {
  const row = await db.prepare(`${SELECT_ANNOUNCEMENTS} WHERE a.id = ? AND a.deleted_at IS NULL`)
    .bind(user.id, user.id, id).first<AnnouncementRow>();
  if (!row) throw notFound('announcement not found');
  const project = await requireProjectAccess(db, user, row.project_id, 'view');
  return { row, project, announcement: dto(row, user) };
}

announcementRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const projectIdQ = c.req.query('projectId');
  const cursorQ = c.req.query('cursor');
  const limit = positiveInteger(c.req.query('limit') ?? 20, 'limit');
  if (limit > 100) throw badRequest('limit must be at most 100');
  const where = ['a.deleted_at IS NULL'];
  const args: unknown[] = [user.id, user.id];
  if (!globalAdmin(user) && user.role !== 'observer') where.push('COALESCE(pm.role, cm.role) IS NOT NULL');
  if (projectIdQ !== undefined) {
    const projectId = positiveInteger(projectIdQ, 'projectId');
    await requireProjectAccess(c.env.DB, user, projectId, 'view');
    where.push('a.project_id = ?');
    args.push(projectId);
  }
  if (cursorQ !== undefined) {
    where.push('a.id < ?');
    args.push(positiveInteger(cursorQ, 'cursor'));
  }
  const [announcements, projects] = await Promise.all([
    c.env.DB.prepare(`${SELECT_ANNOUNCEMENTS} WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`)
      .bind(...args, limit + 1).all<AnnouncementRow>(),
    c.env.DB.prepare(
      `SELECT p.id, p.name, c.name AS customer_name FROM projects p
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?
       LEFT JOIN memberships cm ON cm.id = ${customerMembershipIdSql('p.customer_id', '?')}
       WHERE ? = 1 OR (? = 1 AND COALESCE(pm.role, cm.role) IN ('developer', 'customer_admin'))
       ORDER BY c.name, p.name, p.id`,
    ).bind(user.id, user.id, globalAdmin(user) ? 1 : 0, user.role === 'developer' ? 1 : 0)
      .all<{ id: number; name: string; customer_name: string }>(),
  ]);
  const rows = announcements.results ?? [];
  const items = rows.slice(0, limit).map((row) => dto(row, user));
  return c.json({
    items,
    nextCursor: rows.length > limit ? String(items[items.length - 1]!.id) : null,
    publishableProjects: (projects.results ?? []).map((project) => ({
      id: project.id, name: project.name, customerName: project.customer_name,
    })),
  });
});

announcementRoutes.get('/recipients', async (c) => {
  const projectId = positiveInteger(c.req.query('projectId'), 'projectId');
  await requireProjectAccess(c.env.DB, c.get('user')!, projectId, 'upload');
  return c.json({ items: await announcementRecipients(c.env.DB, projectId) });
});

announcementRoutes.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json<{ projectId?: number; content?: unknown; version?: unknown; recipientIds?: unknown }>().catch(() => null);
  if (!body) throw badRequest('projectId and content required');
  const projectId = positiveInteger(body.projectId, 'projectId');
  const content = announcementContent(body.content);
  const recipientIds = announcementRecipientIds(body.recipientIds);
  const version = body.version ?? null;
  if (version !== null && (typeof version !== 'string' || !/^[A-Za-z0-9._+-]{1,64}$/.test(version))) {
    throw badRequest('version must match [A-Za-z0-9._+-], 1-64 chars');
  }
  const project = await requireProjectAccess(c.env.DB, user, projectId, 'upload');
  await validateAnnouncementRecipients(c.env, projectId, recipientIds);
  const versionExistsSql = `EXISTS (
    SELECT 1 FROM versions WHERE project_id = ? AND version = ? AND status IN ('ready', 'archived')
  )`;
  if (version !== null) {
    const available = await c.env.DB.prepare(`SELECT ${versionExistsSql} AS available`)
      .bind(projectId, version).first<{ available: number }>();
    if (!available?.available) throw notFound('version not found in this project');
  }
  const now = Date.now();
  const insert = c.env.DB.prepare(
    `INSERT INTO announcements (project_id, version, content, author_id, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE ${ANNOUNCEMENT_AUTHOR_CAN_PUBLISH_SQL}
       ${version !== null ? `AND ${versionExistsSql}` : ''}`,
  ).bind(projectId, version, content, user.id, now, now, projectId, user.id,
    ...(version !== null ? [projectId, version] : []));
  const result = recipientIds.length
    ? (await c.env.DB.batch([insert, queueAnnouncementMail(c.env.DB, recipientIds, now)]))[0]!
    : await insert.run();
  if (!result.meta.changes) {
    if (version !== null) {
      await requireAnnouncementAuthor(c.env.DB, projectId, user.id);
      throw conflict('selected version is no longer available');
    }
    throw forbidden('no permission to publish announcements');
  }
  const id = Number(result.meta.last_row_id);
  if (recipientIds.length) await sendAnnouncementMail(c.env, id);
  await audit(c, { action: 'announcement.create', projectId, customerId: project.customer_id, targetType: 'announcement', targetId: id, meta: { version } });
  return c.json((await loadAnnouncement(c.env.DB, user, id)).announcement, 201);
});

announcementRoutes.post('/:id/mail/retry', async (c) => {
  const user = c.get('user')!;
  const id = positiveInteger(c.req.param('id'), 'id');
  const body = await c.req.json<{ retryFailed?: unknown } | null>().catch(() => null);
  if (body?.retryFailed !== undefined && typeof body.retryFailed !== 'boolean') {
    throw badRequest('retryFailed must be a boolean');
  }
  const { announcement } = await loadAnnouncement(c.env.DB, user, id);
  if (!announcement.canEdit) throw forbidden('only the author or an administrator can send announcement emails');
  await sendAnnouncementMail(c.env, id, body?.retryFailed !== false);
  return c.json((await loadAnnouncement(c.env.DB, user, id)).announcement);
});

announcementRoutes.patch('/:id', async (c) => {
  const user = c.get('user')!;
  const id = positiveInteger(c.req.param('id'), 'id');
  const body = await c.req.json<{ content?: unknown }>().catch(() => null);
  const content = announcementContent(body?.content);
  const { row, project, announcement } = await loadAnnouncement(c.env.DB, user, id);
  if (!announcement.canEdit) throw forbidden('only the author or an administrator can edit this announcement');
  const updatedAt = Date.now();
  const result = await c.env.DB.prepare(`UPDATE announcements SET content = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL AND ${ANNOUNCEMENT_CAN_MANAGE_SQL}`)
    .bind(content, updatedAt, id, user.id).run();
  if (!result.meta.changes) {
    await loadAnnouncement(c.env.DB, user, id);
    throw forbidden('no permission to edit this announcement');
  }
  await audit(c, { action: 'announcement.update', projectId: row.project_id, customerId: project.customer_id, targetType: 'announcement', targetId: id });
  return c.json({ ...announcement, content, updatedAt });
});

announcementRoutes.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = positiveInteger(c.req.param('id'), 'id');
  const { row, project, announcement } = await loadAnnouncement(c.env.DB, user, id);
  if (!announcement.canDelete) throw forbidden('only the author or an administrator can delete this announcement');
  const now = Date.now();
  const result = await c.env.DB.prepare(`UPDATE announcements SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL AND ${ANNOUNCEMENT_CAN_MANAGE_SQL}`)
    .bind(now, now, id, user.id).run();
  if (!result.meta.changes) {
    await loadAnnouncement(c.env.DB, user, id);
    throw forbidden('no permission to delete this announcement');
  }
  await c.env.DB.prepare(`UPDATE announcement_mail_deliveries SET status = 'skipped', error = NULL, updated_at = ?
    WHERE announcement_id = ? AND status IN ('pending', 'failed')`).bind(now, id).run();
  await audit(c, { action: 'announcement.delete', projectId: row.project_id, customerId: project.customer_id, targetType: 'announcement', targetId: id });
  return c.json({ ok: true });
});
