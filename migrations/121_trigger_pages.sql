-- Jobs that start themselves, when a web page changes.
--
-- A third kind of trigger, 'page': an address on the public web, optionally the words to watch for on it, and how
-- often to look. Each look reads the page in a real browser and keeps what it saw; when that differs from the look
-- before, the agent is hired with what changed. No model is asked until something has changed.

ALTER TABLE triggers ADD COLUMN page_url TEXT;
-- the words to watch for: only the lines of the page that mention them are compared. NULL watches the whole page.
ALTER TABLE triggers ADD COLUMN page_watch TEXT;
-- minutes between two looks
ALTER TABLE triggers ADD COLUMN page_every_min INTEGER;
-- what the last look saw: its fingerprint, and the words themselves so the next look can say what changed
ALTER TABLE triggers ADD COLUMN page_last_hash TEXT;
ALTER TABLE triggers ADD COLUMN page_last_text TEXT;
ALTER TABLE triggers ADD COLUMN page_checked_at TEXT;
ALTER TABLE triggers ADD COLUMN page_changed_at TEXT;
-- how many changes it has seen (the next change's number is what makes its run its own)
ALTER TABLE triggers ADD COLUMN page_changes INTEGER NOT NULL DEFAULT 0;
-- looks in a row that could not read the page
ALTER TABLE triggers ADD COLUMN page_failures INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_triggers_page ON triggers(kind, status, page_checked_at);
