-- Add extensible global-role overrides without rebuilding the original users
-- table. Existing users.role remains the compatibility base
-- ('super_admin'/'developer'); admin and observer are stored here.
CREATE TABLE IF NOT EXISTS user_global_roles (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'observer')),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

-- If this migration is applied to a database that was already briefly upgraded
-- to store admin/observer directly in users.role, preserve those effective roles
-- in the override table. Fresh/old databases simply insert nothing here.
INSERT OR REPLACE INTO user_global_roles (user_id, role, updated_at, updated_by)
SELECT id, role, updated_at, NULL
  FROM users
 WHERE role IN ('admin', 'observer');
