import type { D1Database } from '@cloudflare/workers-types';
import type { UploadAnnouncement } from '@qota/shared';
import { badRequest, forbidden } from '../utils/errors';
import { announcementRecipientIds } from './announcement-mail';
import { customerMembershipIdSql } from './memberships';

// Parameters: project id, author id. Keep the original session author as the
// publisher, including when another authorized user finishes their upload.
export const ANNOUNCEMENT_AUTHOR_CAN_PUBLISH_SQL = `EXISTS (
  SELECT 1 FROM users au JOIN projects ap ON ap.id = ?
  LEFT JOIN user_global_roles agr ON agr.user_id = au.id
  LEFT JOIN project_memberships apm ON apm.project_id = ap.id AND apm.user_id = au.id
  LEFT JOIN memberships acm ON acm.id = ${customerMembershipIdSql('ap.customer_id', 'au.id')}
  WHERE au.id = ? AND au.is_active = 1 AND (
    COALESCE(agr.role, au.role) IN ('super_admin', 'admin') OR
    (COALESCE(agr.role, au.role) = 'developer' AND COALESCE(apm.role, acm.role) IN ('developer', 'customer_admin'))
  )
)`;

// One parameter: the acting user. Authors may still manage their announcement
// after becoming scoped viewers, provided they retain access to its project.
// Global observers cannot write, even when they originally authored a notice.
// Other scoped users must remain administrators at the final write.
export const ANNOUNCEMENT_CAN_MANAGE_SQL = `EXISTS (
  SELECT 1 FROM users au JOIN projects ap ON ap.id = announcements.project_id
  LEFT JOIN user_global_roles agr ON agr.user_id = au.id
  LEFT JOIN project_memberships apm ON apm.project_id = ap.id AND apm.user_id = au.id
  LEFT JOIN memberships acm ON acm.id = ${customerMembershipIdSql('ap.customer_id', 'au.id')}
  WHERE au.id = ? AND au.is_active = 1 AND (
    COALESCE(agr.role, au.role) IN ('super_admin', 'admin')
    OR (COALESCE(agr.role, au.role) = 'developer' AND COALESCE(apm.role, acm.role) = 'customer_admin')
    OR (au.id = announcements.author_id AND COALESCE(agr.role, au.role) = 'developer'
      AND COALESCE(apm.role, acm.role) IS NOT NULL)
  )
)`;

export async function requireAnnouncementAuthor(db: D1Database, projectId: number, authorId: number) {
  const row = await db.prepare(`SELECT ${ANNOUNCEMENT_AUTHOR_CAN_PUBLISH_SQL} AS allowed`)
    .bind(projectId, authorId).first<{ allowed: number }>();
  if (!row?.allowed) throw forbidden('the announcement author no longer has permission to publish');
}

export function announcementContent(value: unknown): string {
  if (typeof value !== 'string') throw badRequest('announcement content must be a string');
  const content = value.trim();
  if (!content || content.length > 10_000) throw badRequest('announcement content must contain 1-10000 characters');
  return content;
}

export function uploadAnnouncement(value: unknown): UploadAnnouncement | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('announcement must contain batchKey and content');
  const announcement = value as { batchKey?: unknown; content?: unknown; recipientIds?: unknown };
  if (typeof announcement.batchKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(announcement.batchKey)) {
    throw badRequest('announcement batchKey must be a UUID');
  }
  return {
    batchKey: announcement.batchKey.toLowerCase(), content: announcementContent(announcement.content),
    ...(announcement.recipientIds === undefined ? {} : { recipientIds: announcementRecipientIds(announcement.recipientIds) }),
  };
}

// Must immediately follow the successful session-completion UPDATE in the
// same batch. A failed artifact write leaves changes() at zero and publishes
// nothing. The unique key also covers deleted announcements and never updates
// their content, preserving manual edits and deletions during later uploads.
export function createUploadAnnouncement(db: D1Database, sessionId: number, now: number) {
  return db.prepare(
    `INSERT INTO announcements (project_id, version, content, author_id, created_at, updated_at, upload_batch_key)
     SELECT project_id, target_version, announcement_content, initiated_by, ?, ?, announcement_batch_key
       FROM upload_sessions
      WHERE id = ? AND status = 'completed' AND changes() = 1
        AND announcement_content IS NOT NULL AND announcement_batch_key IS NOT NULL
     ON CONFLICT (project_id, author_id, upload_batch_key) DO NOTHING`,
  ).bind(now, now, sessionId);
}
