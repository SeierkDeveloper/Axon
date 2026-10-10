-- Work with your agent: a follow-up is a hire that continues an earlier one.
--
-- A finished job can be followed up: the same agent is hired again with what was said before and the files from
-- before. The follow-up is a job of its own, with its own receipt. `parent_task_id` is the job it continues and
-- `thread_id` the first job of the conversation. Both are empty for a hire that follows nothing, which is every job
-- before this.
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id) WHERE thread_id IS NOT NULL;
