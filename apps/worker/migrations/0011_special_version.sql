-- Optional metadata shared by all files of a version label. Existing values
-- remain empty; upload sessions distinguish omission from explicit clearing.
ALTER TABLE version_metadata ADD COLUMN special_version TEXT;
ALTER TABLE upload_sessions ADD COLUMN special_version TEXT;
ALTER TABLE upload_sessions ADD COLUMN has_special_version INTEGER NOT NULL DEFAULT 0;
