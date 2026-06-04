-- Store the API token encrypted at rest (AES-256-GCM, key derived from
-- JWT_SECRET) so it can be re-copied from the dashboard at any time. The hash
-- (token_hash) is still what authentication looks up; token_enc is only for
-- display/copy. NULL for tokens issued before this column existed — those can
-- only be copied at creation time, and must be re-issued to enable copy.
ALTER TABLE api_tokens ADD COLUMN token_enc TEXT;
