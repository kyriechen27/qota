import type { D1Database } from '@cloudflare/workers-types';

// Queries using this expression alias the artifact table as v. Archived
// artifacts are never marked current, even if another channel remains ready.
export const IS_CURRENT_SQL = `(
  v.status = 'ready' AND EXISTS (
    SELECT 1 FROM project_current_versions cv
     WHERE cv.project_id = v.project_id AND cv.version = v.version
  )
)`;

// Used in metadata writes to close the gap between permission checks and the
// atomic mutation. The target UPDATE table is named versions (without alias).
export const NOTES_UNLOCKED_SQL = `NOT EXISTS (
  SELECT 1 FROM project_current_versions cv
   WHERE cv.project_id = versions.project_id AND cv.version = versions.version
)`;

export function setCurrentVersion(db: D1Database, projectId: number, version: string, isCurrent: boolean, requireNotCurrent = false) {
  const guard = requireNotCurrent ? `AND NOT EXISTS (
    SELECT 1 FROM project_current_versions cv WHERE cv.project_id = ? AND cv.version = ?
  )` : '';
  const guardArgs = requireNotCurrent ? [projectId, version] : [];
  if (!isCurrent) {
    return db.prepare(`DELETE FROM project_current_versions WHERE project_id = ? AND version = ? ${guard}`)
      .bind(projectId, version, ...guardArgs);
  }
  // Keep the invariant even if an archive completes between validation and
  // this statement. The caller batches this with any artifact status changes.
  return db.prepare(
    `INSERT OR IGNORE INTO project_current_versions (project_id, version)
     SELECT ?, ? WHERE EXISTS (
       SELECT 1 FROM versions WHERE project_id = ? AND version = ? AND status = 'ready'
     ) ${guard}`,
  ).bind(projectId, version, projectId, version, ...guardArgs);
}

export function clearUnusedCurrentVersions(db: D1Database, projectId: number) {
  return db.prepare(
    `DELETE FROM project_current_versions
      WHERE project_id = ? AND NOT EXISTS (
        SELECT 1 FROM versions v
         WHERE v.project_id = project_current_versions.project_id
           AND v.version = project_current_versions.version AND v.status = 'ready'
      )`,
  ).bind(projectId);
}

// Keep the legacy column representative for older integrations; it is never
// the source of truth after migration. Resolve multiple labels by upload time.
export function syncLegacyCurrentVersion(db: D1Database, projectId: number, now: number) {
  return db.prepare(
    `UPDATE projects SET current_version = (
       SELECT cv.version FROM project_current_versions cv
       JOIN versions v ON v.project_id = cv.project_id AND v.version = cv.version
        WHERE cv.project_id = ? AND v.status = 'ready'
        GROUP BY cv.version ORDER BY MAX(v.created_at) DESC, MAX(v.id) DESC LIMIT 1
     ), updated_at = ? WHERE id = ?`,
  ).bind(projectId, now, projectId);
}
