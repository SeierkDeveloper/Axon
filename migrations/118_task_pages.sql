-- Agents that use the internet: the pages a job's browser was on.
--
-- A job that browses is only worth believing if the person can see where the agent went. Each page its browser
-- landed on is kept here, in the order it got there, and shown with the answer as a list of links. An address is a
-- public web address by construction (the browser opens nothing else); nothing of the page itself is kept.

CREATE TABLE IF NOT EXISTS task_pages (
  task_id   TEXT NOT NULL,
  n         INTEGER NOT NULL,
  url       TEXT NOT NULL,
  title     TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL,
  PRIMARY KEY (task_id, n)
);
