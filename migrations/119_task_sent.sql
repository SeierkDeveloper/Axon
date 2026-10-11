-- Agents that use the internet: what a job's browser sent.
--
-- An agent that fills in a form and sends it has done something in the person's name on somebody else's site. That
-- is only acceptable when the person can see exactly what went where. Each form its browser sent is kept here with
-- the job: the page, and each field with what was in it. It is read by whoever may read the job and by nobody else;
-- it is on no receipt and in no public trace.

CREATE TABLE IF NOT EXISTS task_sent (
  task_id   TEXT NOT NULL,
  n         INTEGER NOT NULL,
  url       TEXT NOT NULL,
  -- what the button that sent it said
  button    TEXT NOT NULL DEFAULT '',
  -- [{ "label": "...", "value": "..." }]
  fields    TEXT NOT NULL,
  at        TEXT NOT NULL,
  PRIMARY KEY (task_id, n)
);
