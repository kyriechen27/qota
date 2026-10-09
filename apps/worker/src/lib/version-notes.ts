import type { D1Database } from '@cloudflare/workers-types';
import type { AuthedUser } from '../env';
import { effectiveRoleOnProject, roleHas } from './memberships';
import { conflict, forbidden } from '../utils/errors';

export interface NotesVersion {
  project_id: number;
  version: string;
  uploaded_by: number;
}

async function notesRole(db: D1Database, user: AuthedUser, projectId: number) {
  if (user.role === 'super_admin' || user.role === 'admin') return { canManage: true, isAdmin: true };
  if (user.role === 'observer') return { canManage: false, isAdmin: false };
  const role = await effectiveRoleOnProject(db, user.id, projectId);
  return { canManage: !!role && roleHas(role, 'manage_versions'), isAdmin: role === 'customer_admin' };
}

export async function withNotePermissions<T extends NotesVersion>(db: D1Database, user: AuthedUser, rows: T[]) {
  const contexts = new Map<number, { canManage: boolean; isAdmin: boolean; current: Set<string> }>();
  await Promise.all([...new Set(rows.map((row) => row.project_id))].map(async (projectId) => {
    const [role, current] = await Promise.all([
      notesRole(db, user, projectId),
      db.prepare('SELECT version FROM project_current_versions WHERE project_id = ?')
        .bind(projectId).all<{ version: string }>(),
    ]);
    contexts.set(projectId, { ...role, current: new Set((current.results ?? []).map((row) => row.version)) });
  }));
  return rows.map((row) => {
    const context = contexts.get(row.project_id)!;
    return {
      ...row,
      can_edit_notes: context.canManage && (context.isAdmin || row.uploaded_by === user.id)
        && !context.current.has(row.version),
    };
  });
}

export async function requireNotesEdit(db: D1Database, user: AuthedUser, rows: NotesVersion[]) {
  const permitted = await withNotePermissions(db, user, rows);
  if (permitted.every((row) => row.can_edit_notes)) return;
  // Check the label, including when the artifact itself has been archived.
  for (const row of rows) {
    const current = await db.prepare('SELECT 1 FROM project_current_versions WHERE project_id = ? AND version = ?')
      .bind(row.project_id, row.version).first();
    if (current) throw conflict('cancel current usage before editing notes');
  }
  throw forbidden('only the uploader or an administrator can edit notes');
}
