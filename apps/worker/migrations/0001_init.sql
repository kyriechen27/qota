-- qota v2: multi-tenant role model + S3 multipart upload sessions + audit logs.
-- See packages/shared/src/index.ts for the matching TS types.
PRAGMA foreign_keys = ON;

-- ============================================================
-- Users (global identity)
-- role = 'super_admin' grants implicit access to everything.
-- role = 'developer' has no global rights; access is via memberships.
-- Additional global roles live in user_global_roles so existing databases do
-- not need the original users table rebuilt when new roles are added.
-- (Devices/CI are NOT users — they live in api_tokens.)
-- ============================================================
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  display_name  TEXT,
  role          TEXT    NOT NULL DEFAULT 'developer'
                CHECK (role IN ('super_admin', 'developer')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE user_global_roles (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'observer')),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id)
);

-- ============================================================
-- Customers (tenants)
-- ============================================================
CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ============================================================
-- Projects (scoped to a customer)
-- ============================================================
CREATE TABLE projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  code            TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  description     TEXT,
  default_channel TEXT    NOT NULL DEFAULT 'stable',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (customer_id, code)
);
CREATE INDEX idx_projects_customer ON projects(customer_id);

-- ============================================================
-- Memberships: (user, customer) -> role.
-- A user may belong to multiple customers with different roles.
-- ============================================================
CREATE TABLE memberships (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role        TEXT    NOT NULL
              CHECK (role IN ('customer_admin', 'developer', 'viewer')),
  created_by  INTEGER          REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, customer_id)
);
CREATE INDEX idx_memberships_user     ON memberships(user_id);
CREATE INDEX idx_memberships_customer ON memberships(customer_id);

-- ============================================================
-- Project-level role overrides (rare). Takes precedence over
-- the customer membership when present.
-- ============================================================
CREATE TABLE project_memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL
             CHECK (role IN ('customer_admin', 'developer', 'viewer')),
  created_by INTEGER          REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, project_id)
);
CREATE INDEX idx_proj_memberships_user    ON project_memberships(user_id);
CREATE INDEX idx_proj_memberships_project ON project_memberships(project_id);

-- ============================================================
-- API tokens — devices and CI runners. NOT users.
-- kind = 'device'  : OTA pull (download-only)
-- kind = 'ci'      : CI uploader (upload + download)
-- scope refines kind (download / upload / full).
-- channel (optional) pins the token to a specific release channel.
-- ============================================================
CREATE TABLE api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  token_hash    TEXT    NOT NULL UNIQUE,
  token_prefix  TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'device'
                CHECK (kind IN ('device', 'ci')),
  scope         TEXT    NOT NULL DEFAULT 'download'
                CHECK (scope IN ('download', 'upload', 'full')),
  channel       TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  expires_at    INTEGER,
  last_used_at  INTEGER,
  last_used_ip  TEXT,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_api_tokens_project ON api_tokens(project_id);

-- ============================================================
-- Device groups (RESERVED — MVP doesn't enforce; schema kept
-- so adding grouped rollouts later doesn't require migrations).
-- ============================================================
CREATE TABLE device_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, code)
);

-- ============================================================
-- Versions (OTA artifacts)
-- status: pending → ready → archived
-- rollout fields are RESERVED (MVP returns "latest where status=ready
-- and channel matches" — does not enforce rollout_percentage etc.)
-- ============================================================
CREATE TABLE versions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version             TEXT    NOT NULL,
  release_channel     TEXT    NOT NULL DEFAULT 'stable',
  status              TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'ready', 'archived')),
  r2_key              TEXT    NOT NULL UNIQUE,
  filename            TEXT    NOT NULL,
  size                INTEGER NOT NULL,
  sha256              TEXT,                -- set after upload completes
  content_type        TEXT,
  notes               TEXT,
  is_mandatory        INTEGER NOT NULL DEFAULT 0,
  min_version         TEXT,
  max_version         TEXT,
  rollout_percentage  INTEGER NOT NULL DEFAULT 100
                      CHECK (rollout_percentage BETWEEN 0 AND 100),
  device_group_id     INTEGER REFERENCES device_groups(id) ON DELETE SET NULL,
  uploaded_by         INTEGER NOT NULL REFERENCES users(id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (project_id, version, release_channel)
);
CREATE INDEX idx_versions_project ON versions(project_id, created_at DESC);
CREATE INDEX idx_versions_channel ON versions(project_id, release_channel, created_at DESC);

-- ============================================================
-- Upload sessions — one row per in-flight R2 multipart upload.
-- Allows pause / resume / abort, and audits long uploads.
-- ============================================================
CREATE TABLE upload_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id      INTEGER          REFERENCES versions(id) ON DELETE SET NULL,
  r2_key          TEXT    NOT NULL,
  filename        TEXT    NOT NULL,
  total_size      INTEGER NOT NULL,
  part_size       INTEGER NOT NULL,
  upload_id       TEXT    NOT NULL,        -- R2 multipart upload id
  expected_sha256 TEXT,                    -- client-provided hash, checked on complete
  release_channel TEXT    NOT NULL DEFAULT 'stable',
  target_version  TEXT    NOT NULL,
  content_type    TEXT,
  notes           TEXT,
  is_mandatory    INTEGER NOT NULL DEFAULT 0,
  min_version     TEXT,
  max_version     TEXT,
  rollout_percentage INTEGER NOT NULL DEFAULT 100
                      CHECK (rollout_percentage BETWEEN 0 AND 100),
  status          TEXT    NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('in_progress', 'completed', 'aborted', 'failed')),
  initiated_by    INTEGER NOT NULL REFERENCES users(id),
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
CREATE INDEX idx_upload_sessions_project ON upload_sessions(project_id, created_at DESC);
CREATE INDEX idx_upload_sessions_status  ON upload_sessions(status, created_at DESC);

-- ============================================================
-- Upload parts — uploaded ETags per session, for resume + complete.
-- ============================================================
CREATE TABLE upload_parts (
  session_id  INTEGER NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, part_number)
);

-- ============================================================
-- Audit log — append-only record of state-changing actions.
-- ============================================================
CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor_type   TEXT    NOT NULL
               CHECK (actor_type IN ('user', 'api_token', 'system')),
  actor_id     INTEGER,
  customer_id  INTEGER,
  project_id   INTEGER,
  action       TEXT    NOT NULL,   -- e.g. version.upload, version.download.grant, membership.grant
  target_type  TEXT,                -- e.g. version, customer, project, membership, api_token
  target_id    INTEGER,
  ip           TEXT,
  user_agent   TEXT,
  meta         TEXT                 -- JSON string with action-specific details
);
CREATE INDEX idx_audit_ts       ON audit_logs(ts DESC);
CREATE INDEX idx_audit_customer ON audit_logs(customer_id, ts DESC);
CREATE INDEX idx_audit_project  ON audit_logs(project_id, ts DESC);
CREATE INDEX idx_audit_actor    ON audit_logs(actor_type, actor_id, ts DESC);
CREATE INDEX idx_audit_action   ON audit_logs(action, ts DESC);
