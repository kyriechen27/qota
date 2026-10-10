CREATE TABLE mail_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 465,
  security TEXT NOT NULL DEFAULT 'tls' CHECK (security IN ('tls', 'starttls')),
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT,
  from_email TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

ALTER TABLE upload_sessions ADD COLUMN announcement_recipient_ids TEXT;
CREATE TABLE announcement_mail_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  error TEXT,
  claim_token TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (announcement_id, user_id)
);
CREATE INDEX idx_announcement_mail_deliveries_status ON announcement_mail_deliveries(announcement_id, status);
