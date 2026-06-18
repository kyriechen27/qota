-- Mark one current in-use version label per project. The selected version
-- applies to every channel artifact under that version number.
ALTER TABLE projects ADD COLUMN current_version TEXT;
