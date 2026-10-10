-- Work with your agent: revisions.
--
-- When somebody asks for a change and the agent hands back a changed file, that file is the next version of the one
-- it changed. Nothing is overwritten: the earlier version stays a file of the job that made it. A version knows its
-- number, the content it replaces, the content of the first version, and the job that made the first version (empty
-- when the first version was uploaded by a person). All four are empty for a file that is not a revision, which is
-- every file before this.
ALTER TABLE task_files ADD COLUMN version INTEGER;
ALTER TABLE task_files ADD COLUMN revises_sha256 TEXT;
ALTER TABLE task_files ADD COLUMN first_sha256 TEXT;
ALTER TABLE task_files ADD COLUMN first_task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_task_files_first ON task_files(first_sha256) WHERE first_sha256 IS NOT NULL;
