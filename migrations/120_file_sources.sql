-- Agents that use the internet: where a saved file came from.
--
-- A picture or a copy of a web page that an agent hands back is only proof of anything together with where it was
-- taken and when. That is kept here beside the file: the page's address and title, what kind of copy it is, and the
-- moment it was made. Whoever may read the file reads this with it. The receipt carries the file's fingerprint, as
-- for every file an agent hands back; the address stays with the job.

CREATE TABLE IF NOT EXISTS task_file_sources (
  file_id     TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  -- 'picture', 'whole-page picture', 'pdf' or 'text'
  kind        TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
