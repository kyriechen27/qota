-- Track how many times each version has been downloaded (user grants + device pulls).
ALTER TABLE versions ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
