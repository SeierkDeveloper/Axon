-- Work with your agent: stop and steer.
--
-- While a job runs, whoever hired it can send the agent a note: a correction, a detail, a change of mind. The agent
-- reads it at its next step. `delivered_at` is when the agent was handed it; empty while it has not been, and for a
-- note that came too late for a job that had already finished.
CREATE TABLE IF NOT EXISTS task_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  n             INTEGER NOT NULL,
  note          TEXT NOT NULL,
  sent_at       TEXT NOT NULL,
  delivered_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id, n);
