import type { D1Database } from '@cloudflare/workers-types';
import type { AuthedUser, CustomerRole } from '../env';
import { roleHas } from './memberships';
import { conflict, forbidden, notFound } from '../utils/errors';

export interface NotesVersion {
  project_id: number;
  version: string;
  uploaded_by: number;
}

interface NotesContext {
  canManage: boolean;
  isAdmin: boolean;
  current: Set<string>;
  metadata: Map<string, { notes: string | null; created_by: number }>;
}

// Fetch roles, current labels and parent notes in bounded batches. The catalog
// can contain many projects and files without issuing a query for every row.
async function notesContexts(db: D1Database, user: AuthedUser, projectIds: number[]) {
  const contexts = new Map<number, NotesContext>();
  for (let offset = 0; offset < projectIds.length; offset += 80) {
    const ids = projectIds.slice(offset, offset + 80);
    const placeholders = ids.map(() => '?').join(',');
    const [projects, current, metadata] = await Promise.all([
      db.prepare(
        `SELECT p.id, COALESCE(pm.role, cm.role) AS role FROM projects p
         LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = ?
         LEFT JOIN memberships cm ON cm.customer_id = p.customer_id AND cm.user_id = ?
         WHERE p.id IN (${placeholders})`,
      ).bind(user.id, user.id, ...ids).all<{ id: number; role: CustomerRole | null }>(),
      db.prepare(`SELECT project_id, version FROM project_current_versions WHERE project_id IN (${placeholders})`)
        .bind(...ids).all<{ project_id: number; version: string }>(),
      db.prepare(`SELECT project_id, version, notes, created_by FROM version_metadata WHERE project_id IN (${placeholders})`)
        .bind(...ids).all<{ project_id: number; version: string; notes: string | null; created_by: number }>(),
    ]);
    for (const project of projects.results ?? []) {
      const globalAdmin = user.role === 'super_admin' || user.role === 'admin';
      const canManage = globalAdmin || (user.role !== 'observer' && !!project.role && roleHas(project.role, 'manage_versions'));
      contexts.set(project.id, {
        canManage,
        isAdmin: globalAdmin || (canManage && project.role === 'customer_admin'),
        current: new Set(),
        metadata: new Map(),
      });
    }
    for (const row of current.results ?? []) contexts.get(row.project_id)?.current.add(row.version);
    for (const row of metadata.results ?? []) contexts.get(row.project_id)?.metadata.set(row.version, row);
  }
  return contexts;
}

export async function withNotePermissions<T extends NotesVersion>(db: D1Database, user: AuthedUser, rows: T[]) {
  const contexts = await notesContexts(db, user, [...new Set(rows.map((row) => row.project_id))]);
  return rows.map((row) => {
    const context = contexts.get(row.project_id);
    const metadata = context?.metadata.get(row.version);
    const locked = context?.current.has(row.version) ?? false;
    const canManage = !!context?.canManage && !locked;
    return {
      ...row,
      notes_locked: locked,
      can_edit_notes: canManage && (!!context?.isAdmin || row.uploaded_by === user.id),
      version_notes: metadata?.notes ?? null,
      version_notes_creator: metadata?.created_by ?? null,
      can_edit_version_notes: canManage && !!metadata && (!!context?.isAdmin || metadata.created_by === user.id),
    };
  });
}

export async function requireNotesEdit(db: D1Database, user: AuthedUser, rows: NotesVersion[]) {
  const permitted = await withNotePermissions(db, user, rows);
  if (permitted.every((row) => row.can_edit_notes)) return;
  if (permitted.some((row) => row.notes_locked)) throw conflict('cancel current usage before editing notes');
  throw forbidden('only the uploader or an administrator can edit notes');
}

export async function requireVersionNotesEdit(db: D1Database, user: AuthedUser, row: NotesVersion) {
  const [permitted] = await withNotePermissions(db, user, [row]);
  if (!permitted || permitted.version_notes_creator === null) throw notFound('version metadata not found');
  if (permitted.notes_locked) throw conflict('cancel current usage before editing notes');
  if (!permitted.can_edit_version_notes) throw forbidden('only the version creator or an administrator can edit version notes');
  return permitted.version_notes_creator;
}

export const VERSION_NOTES_UNLOCKED_SQL = `NOT EXISTS (
  SELECT 1 FROM project_current_versions cv
   WHERE cv.project_id = version_metadata.project_id AND cv.version = version_metadata.version
)`;

export function clearUnusedVersionMetadata(db: D1Database, projectId: number, version: string) {
  return db.prepare(
    `DELETE FROM version_metadata WHERE project_id = ? AND version = ? AND NOT EXISTS (
       SELECT 1 FROM versions v
        WHERE v.project_id = version_metadata.project_id AND v.version = version_metadata.version
     )`,
  ).bind(projectId, version);
}
