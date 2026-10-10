import type { D1Database } from '@cloudflare/workers-types';
import type { AnnouncementRecipient } from '@qota/shared';
import type { Bindings } from '../env';
import { badRequest } from '../utils/errors';
import { getMailConfig } from './mail-config';
import { sendMail } from './smtp';
import { customerMembershipIdSql } from './memberships';

const MAX_RECIPIENTS = 200;
const SEND_BATCH_SIZE = 3;
const STALE_CLAIM_MS = 5 * 60_000;

// Parameters: project id. Match requireProjectAccess(..., 'view'), including
// project overrides and scoped observers, and exclude disabled accounts.
const RECIPIENTS_SQL = `SELECT u.id, u.email, u.display_name AS displayName
  FROM users u JOIN projects p ON p.id = ?
  LEFT JOIN user_global_roles gr ON gr.user_id = u.id
  LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = u.id
  LEFT JOIN memberships cm ON cm.id = ${customerMembershipIdSql('p.customer_id', 'u.id')}
  WHERE u.is_active = 1 AND (
    COALESCE(gr.role, u.role) IN ('super_admin', 'admin') OR
    (COALESCE(gr.role, u.role) IN ('developer', 'observer') AND COALESCE(pm.role, cm.role) IS NOT NULL)
  )`;

export function announcementRecipientIds(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS ||
      value.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw badRequest('recipientIds must contain at most 200 positive user ids');
  }
  return [...new Set<number>(value)].sort((a, b) => a - b);
}

export async function announcementRecipients(db: D1Database, projectId: number) {
  const result = await db.prepare(`${RECIPIENTS_SQL} ORDER BY u.display_name, u.email, u.id`)
    .bind(projectId).all<AnnouncementRecipient>();
  return result.results ?? [];
}

export async function validateAnnouncementRecipients(env: Bindings, projectId: number, ids: number[]) {
  if (!ids.length) return;
  await getMailConfig(env);
  const allowed = new Set((await announcementRecipients(env.DB, projectId)).map((user) => user.id));
  if (ids.some((id) => !allowed.has(id))) {
    throw badRequest('every email recipient must be active and able to view this project', 'invalid_recipients');
  }
}

// Immediately follows the announcement INSERT within the same D1 batch.
// Materialize its id once: inserting multiple deliveries must not change the
// last_insert_rowid used by later rows. changes()=0 also prevents an upload
// retry from adding recipients to an existing or deleted announcement.
export function queueAnnouncementMail(db: D1Database, ids: number[], now: number) {
  return db.prepare(`WITH published AS MATERIALIZED (
      SELECT last_insert_rowid() AS id WHERE changes() = 1
    )
    INSERT INTO announcement_mail_deliveries
      (announcement_id, user_id, status, created_at, updated_at)
    SELECT published.id, recipients.value, 'pending', ?, ?
      FROM published CROSS JOIN json_each(?) recipients
     WHERE 1
    ON CONFLICT (announcement_id, user_id) DO NOTHING`)
    .bind(now, now, JSON.stringify(ids));
}

function safeMailError(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^(smtp_(connect|timeout|tls|auth|recipient|send)|mail_(disabled|not_configured))$/.test(code)
    ? code : 'smtp_send';
}

interface MailAnnouncement {
  id: number;
  project_id: number;
  project_name: string;
  customer_name: string;
  version: string | null;
  content: string;
}

/** Bounded, awaited delivery. SMTP failure never changes publication success. */
export async function sendAnnouncementMail(env: Bindings, announcementId: number, retry = false): Promise<void> {
  try {
    const db = env.DB;
    const now = Date.now();
    if (retry) {
      // A timed-out process may leave an ambiguous SMTP outcome. Only explicit
      // user retries recover old claims; fresh claims and sent rows are never
      // retried. Tokens prevent an old process from overwriting a new claim.
      await db.prepare(`UPDATE announcement_mail_deliveries
        SET status = 'failed', error = 'smtp_timeout', claim_token = NULL, updated_at = ?
        WHERE announcement_id = ? AND status = 'sending' AND updated_at < ?`)
        .bind(now, announcementId, now - STALE_CLAIM_MS).run();
    }
    const statuses = retry ? "('pending', 'failed')" : "('pending')";
    await db.prepare(`UPDATE announcement_mail_deliveries SET status = 'skipped', error = NULL, updated_at = ?
      WHERE announcement_id = ? AND status IN ${statuses}
        AND NOT EXISTS (SELECT 1 FROM announcements WHERE id = ? AND deleted_at IS NULL)`)
      .bind(now, announcementId, announcementId).run();
    const selected = await db.prepare(`SELECT id, user_id FROM announcement_mail_deliveries
      WHERE announcement_id = ? AND status IN ${statuses}
      ORDER BY ${retry ? "CASE status WHEN 'failed' THEN 0 ELSE 1 END, updated_at," : ''} id LIMIT ?`)
      .bind(announcementId, SEND_BATCH_SIZE).all<{ id: number; user_id: number }>();
    if (!selected.results?.length) return;
    let config;
    try {
      config = await getMailConfig(env);
    } catch (error) {
      await db.prepare(`UPDATE announcement_mail_deliveries SET status = 'failed', error = ?, updated_at = ?
        WHERE announcement_id = ? AND status = 'pending'`)
        .bind(safeMailError(error), now, announcementId).run();
      return;
    }
    const smtpConfig = config;
    await Promise.allSettled(selected.results.map(async (delivery) => {
      const claimToken = crypto.randomUUID();
      const claim = await db.prepare(`UPDATE announcement_mail_deliveries
        SET status = 'sending', error = NULL, claim_token = ?, updated_at = ?
        WHERE id = ? AND status IN ${statuses}
          AND EXISTS (SELECT 1 FROM announcements WHERE id = ? AND deleted_at IS NULL)`)
        .bind(claimToken, Date.now(), delivery.id, announcementId).run();
      if (!claim.meta.changes) return;
      const finish = async (status: 'sent' | 'failed' | 'skipped', error: string | null = null) => {
        await db.prepare(`UPDATE announcement_mail_deliveries SET status = ?, error = ?, claim_token = NULL, updated_at = ?
          WHERE id = ? AND status = 'sending' AND claim_token = ?`)
          .bind(status, error, Date.now(), delivery.id, claimToken).run();
      };
      try {
        const announcement = await db.prepare(`SELECT a.id, a.project_id, a.version, a.content,
            p.name AS project_name, c.name AS customer_name
          FROM announcements a JOIN projects p ON p.id = a.project_id JOIN customers c ON c.id = p.customer_id
          WHERE a.id = ? AND a.deleted_at IS NULL`).bind(announcementId).first<MailAnnouncement>();
        const recipient = announcement ? await db.prepare(`${RECIPIENTS_SQL} AND u.id = ?
          AND EXISTS (SELECT 1 FROM announcements WHERE id = ? AND deleted_at IS NULL)`)
          .bind(announcement.project_id, delivery.user_id, announcementId).first<AnnouncementRecipient>() : null;
        if (!announcement || !recipient) { await finish('skipped'); return; }
        await sendMail(env, smtpConfig, {
          to: recipient.email,
          subject: `项目公告：${announcement.project_name}${announcement.version ? ` · ${announcement.version}` : ''}`,
          text: `${announcement.customer_name} / ${announcement.project_name}\n${announcement.version ? `版本：${announcement.version}\n` : ''}\n${announcement.content}`,
        });
        await finish('sent');
      } catch (error) {
        await finish('failed', safeMailError(error));
      }
    }));
  } catch {
    // Keep publication/firmware success independent of queue/transport errors.
    // Pending rows remain visible and can be resumed through the retry route.
    console.warn('[announcement.mail] delivery incomplete; retry available');
  }
}
