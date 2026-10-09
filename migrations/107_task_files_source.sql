-- Files between agents: where a file came from.
--
-- When one agent's work is handed to the next (a crew, a pipeline, an agent that hires specialists), the file is not
-- uploaded again: a new row points at the same stored bytes. This is the job that made the file, so a job that hands
-- back a chart a specialist drew can say which agent drew it. Empty for a file somebody uploaded.
ALTER TABLE task_files ADD COLUMN source_task_id TEXT;
