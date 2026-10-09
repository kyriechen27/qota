-- Permit distinct files in the same project/version/channel. This migration
-- must run in one transaction (Node migrations / D1 migrations / Pages batch).
-- Keep foreign keys enabled: preserve references before DROP TABLE invokes
-- upload_sessions.version_id's ON DELETE SET NULL action, then restore them.
CREATE TABLE _qota_0008_upload_version_refs (
  session_id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL
);
INSERT INTO _qota_0008_upload_version_refs (session_id, version_id)
SELECT id, version_id FROM upload_sessions WHERE version_id IS NOT NULL;

CREATE TABLE _qota_0008_version_sequence (seq INTEGER NOT NULL);
INSERT INTO _qota_0008_version_sequence (seq)
SELECT COALESCE(MAX(seq), 0) FROM sqlite_sequence WHERE name = 'versions';

CREATE TABLE versions_multi_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  release_channel TEXT NOT NULL DEFAULT 'stable',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'archived')),
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  content_type TEXT,
  notes TEXT,
  is_mandatory INTEGER NOT NULL DEFAULT 0,
  min_version TEXT,
  max_version TEXT,
  rollout_percentage INTEGER NOT NULL DEFAULT 100 CHECK (rollout_percentage BETWEEN 0 AND 100),
  device_group_id INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  public_slug TEXT
);
INSERT INTO versions_multi_file (
  id, project_id, version, release_channel, status, r2_key, filename, size,
  sha256, content_type, notes, is_mandatory, min_version, max_version,
  rollout_percentage, device_group_id, uploaded_by, created_at, updated_at,
  download_count, public_slug
)
SELECT id, project_id, version, release_channel, status, r2_key, filename, size,
  sha256, content_type, notes, is_mandatory, min_version, max_version,
  rollout_percentage, device_group_id, uploaded_by, created_at, updated_at,
  download_count, public_slug
FROM versions;

DROP TABLE versions;
ALTER TABLE versions_multi_file RENAME TO versions;

UPDATE upload_sessions SET version_id = (
  SELECT ref.version_id FROM _qota_0008_upload_version_refs ref
  WHERE ref.session_id = upload_sessions.id
)
WHERE id IN (SELECT session_id FROM _qota_0008_upload_version_refs);

-- Preserve deleted ID high-water marks so old links never target a reused ID.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'versions', seq FROM _qota_0008_version_sequence
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'versions');
UPDATE sqlite_sequence SET seq = MAX(seq, (SELECT seq FROM _qota_0008_version_sequence))
WHERE name = 'versions';

CREATE INDEX idx_versions_project ON versions(project_id, created_at DESC);
CREATE INDEX idx_versions_channel ON versions(project_id, release_channel, created_at DESC);
CREATE UNIQUE INDEX idx_versions_public_slug ON versions(public_slug);
CREATE UNIQUE INDEX idx_versions_file ON versions(project_id, version, release_channel, filename);

DROP TABLE _qota_0008_upload_version_refs;
DROP TABLE _qota_0008_version_sequence;
