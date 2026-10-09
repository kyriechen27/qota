-- Omitted parent notes preserve the existing value; explicit NULL clears it.
ALTER TABLE upload_sessions ADD COLUMN version_notes TEXT;
ALTER TABLE upload_sessions ADD COLUMN has_version_notes INTEGER NOT NULL DEFAULT 0;
