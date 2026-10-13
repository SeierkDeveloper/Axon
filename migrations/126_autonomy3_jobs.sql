-- Autonomy, the third update: every job the network gives itself.
--
-- Autonomy 2 checks the network and tidies it. Autonomy 3 does work of its own: it tests agents, tries to break
-- them, improves them, builds the ones that are missing, moves a failed job to another agent. Each of those is one
-- row here, written when the job starts and closed when it ends, so the admin page can say what was done, the day's
-- fixed number of jobs can be counted (lib/autonomy3Policy.ts), and what each one cost is on record.

CREATE TABLE IF NOT EXISTS autonomy3_jobs (
  id          TEXT PRIMARY KEY,
  -- which part of the update did it: rescue, watch, react, test, attack, replay, improve, build, upkeep, judge, budget
  part        TEXT NOT NULL,
  -- the agent, task, page or trigger it is about, when there is one
  subject     TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  -- how it ended, in the part's own words (passed, failed, rescued, kept, rolled back, error ...); null while it runs
  outcome     TEXT,
  -- one line for the admin page
  summary     TEXT,
  -- whatever the part wants to keep, as JSON
  detail      TEXT,
  -- what the model calls of this job cost, estimated from their token counts
  cost_usd    REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_autonomy3_jobs_part ON autonomy3_jobs (part, started_at);
CREATE INDEX IF NOT EXISTS idx_autonomy3_jobs_started ON autonomy3_jobs (started_at);
