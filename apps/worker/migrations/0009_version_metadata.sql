-- Version-label notes are independent of each uploaded file's notes. Keep the
-- earliest uploader as the label's creator, even when more files are added.
CREATE TABLE IF NOT EXISTS version_metadata (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, version)
);

INSERT OR IGNORE INTO version_metadata (project_id, version, notes, created_by, created_at, updated_at)
SELECT v.project_id, v.version,
  CASE WHEN COUNT(v.notes) = COUNT(*) AND COUNT(DISTINCT v.notes) = 1
    THEN MIN(v.notes) ELSE NULL END,
  (SELECT first_file.uploaded_by FROM versions first_file
    WHERE first_file.project_id = v.project_id AND first_file.version = v.version
    ORDER BY first_file.created_at ASC, first_file.id ASC LIMIT 1),
  MIN(v.created_at), MAX(v.updated_at)
FROM versions v
GROUP BY v.project_id, v.version;
