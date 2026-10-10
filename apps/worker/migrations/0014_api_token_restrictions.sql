-- NULL keeps existing tokens unrestricted on these additional dimensions.
ALTER TABLE api_tokens ADD COLUMN special_version TEXT;
ALTER TABLE api_tokens ADD COLUMN version TEXT;
-- Deliberately retain a deleted file's id: SET NULL would broaden its token.
-- Artifact ids are AUTOINCREMENT, so a later upload cannot inherit this grant.
ALTER TABLE api_tokens ADD COLUMN version_id INTEGER;
