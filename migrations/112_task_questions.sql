-- Work with your agent: the agent asks.
--
-- A job that cannot be done well without something only the person knows asks for it and waits. The question, when
-- the job goes on without an answer, the answer, and whether a person gave it or the time ran out. A job may ask
-- more than once, so questions are numbered within their job.
CREATE TABLE IF NOT EXISTS task_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  n             INTEGER NOT NULL,
  question      TEXT NOT NULL,
  -- a JSON array of short answers to pick from, when the agent offered some
  choices       TEXT,
  asked_at      TEXT NOT NULL,
  -- the job goes on with its best guess at this time if nobody has answered
  answer_by     TEXT NOT NULL,
  answer        TEXT,
  answered_at   TEXT,
  -- 'person', or 'timeout' when the time ran out
  answered_how  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_questions_task ON task_questions(task_id, n);
CREATE INDEX IF NOT EXISTS idx_task_questions_open ON task_questions(answer_by) WHERE answered_at IS NULL;
