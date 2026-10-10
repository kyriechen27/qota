CREATE TABLE IF NOT EXISTS registration_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO registration_settings (id, enabled, updated_at) VALUES (1, 0, 0);
