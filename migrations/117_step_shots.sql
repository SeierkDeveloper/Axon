-- Watch it work, with pictures: a step an agent takes in its browser carries a picture of the page as it then was.
--
-- The picture itself is a stored file like any other (task_files, direction 'shot'): held once per content, read with
-- its own token, gone when its time is up. A row here only says which line of a job's live log it belongs to. It is
-- not one of the job's deliverables and is on no receipt.

CREATE TABLE IF NOT EXISTS task_step_shots (
  task_id   TEXT NOT NULL,
  -- the line's place in the job's progress (task_progress.sequence)
  sequence  INTEGER NOT NULL,
  file_id   TEXT NOT NULL,
  PRIMARY KEY (task_id, sequence)
);
