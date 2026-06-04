-- Public, token-less download links (per version).
-- A random, unguessable slug acts as a capability URL: anyone who has it can
-- download the artifact (never upload), and access is revoked by clearing the
-- slug. NULL = not public. SQLite treats NULLs as distinct, so many versions
-- can be non-public under this UNIQUE index simultaneously.
ALTER TABLE versions ADD COLUMN public_slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_public_slug ON versions(public_slug);
