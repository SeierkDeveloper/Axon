-- When a task was last put back in the queue (by autonomy's one retry, or a manual retry of a failed task), so
-- "queued too long" counts from then rather than from when the task was first created.

ALTER TABLE tasks ADD COLUMN requeued_at TEXT;
