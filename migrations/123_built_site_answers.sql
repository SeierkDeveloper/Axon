-- Agents that build: forms that collect answers.
--
-- A built page can have a form on it (a sign-up, an RSVP, a survey). What a visitor sends through it is kept here,
-- for whoever had the page built and for nobody else. An answer is the form's fields as the visitor filled them in.
-- Who sent it is kept only as a hash, to stop one visitor filling the list. An answer its owner removes is deleted,
-- not hidden: it is somebody's words about themselves.

CREATE TABLE IF NOT EXISTS built_site_answers (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,              -- the version of the page it was sent from
  form TEXT NOT NULL,                    -- the form's name on the page
  fields TEXT NOT NULL,                  -- JSON: [[name, value], ...] in the order of the form
  bytes INTEGER NOT NULL,
  sender_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_built_site_answers_site ON built_site_answers(site_id, created_at);
