-- Current usage is a set of version labels, shared across each label's ready
-- channel artifacts. Preserve the existing selection when upgrading.
CREATE TABLE IF NOT EXISTS project_current_versions (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);

INSERT OR IGNORE INTO project_current_versions (project_id, version)
SELECT p.id, p.current_version
  FROM projects p
 WHERE p.current_version IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM versions v
      WHERE v.project_id = p.id AND v.version = p.current_version AND v.status = 'ready'
   );
