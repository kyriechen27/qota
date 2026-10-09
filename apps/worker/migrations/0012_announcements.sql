CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT,
  content TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  upload_batch_key TEXT,
  UNIQUE (project_id, author_id, upload_batch_key)
);
CREATE INDEX idx_announcements_project ON announcements(project_id, id DESC);

-- Keep the announcement key after soft deletion, so remaining files from a
-- published upload batch cannot recreate an announcement the user removed.
ALTER TABLE upload_sessions ADD COLUMN announcement_content TEXT;
ALTER TABLE upload_sessions ADD COLUMN announcement_batch_key TEXT;
CREATE INDEX idx_upload_sessions_announcement ON upload_sessions(project_id, initiated_by, announcement_batch_key);
