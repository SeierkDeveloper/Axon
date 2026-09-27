-- Retainers: standing hires on a schedule, paid from the owner's allowance.
--
-- A retainer is only a schedule. Money never sits here: every run is an ordinary allowance hire, so
-- the contract's limits, the settle-on-success and the release-on-failure all apply to it unchanged.
-- The rules it follows live in src/lib/retainerPolicy.ts.

CREATE TABLE IF NOT EXISTS retainers (
  retainer_id          TEXT PRIMARY KEY,
  owner_wallet         TEXT NOT NULL,
  agent_id             TEXT NOT NULL,
  instructions         TEXT NOT NULL,
  -- JSON: {"kind":"interval","everyHours":4} | {"kind":"daily","time":"08:00","timeZone":"Europe/Oslo"}
  --       | {"kind":"weekly","day":1,"time":"09:00","timeZone":"UTC"}
  schedule             TEXT NOT NULL,
  pay_in               TEXT NOT NULL DEFAULT 'ETH',
  -- wei, as text: the most one run may cost
  max_price_wei        TEXT NOT NULL,
  ends_at              TEXT,
  max_runs             INTEGER,
  -- active | paused | ended | cancelled
  status               TEXT NOT NULL DEFAULT 'active',
  -- owner | failures | agent_unavailable, set while paused
  pause_reason         TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  runs_done            INTEGER NOT NULL DEFAULT 0,
  -- where interval schedules count from
  anchor_at            TEXT NOT NULL,
  -- the next slot to run, NULL once ended or cancelled
  next_run_at          TEXT,
  -- the allowance key that created it, if one did: its limits apply to every run
  api_key_id           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retainers_due ON retainers (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_retainers_owner ON retainers (owner_wallet, created_at);
CREATE INDEX IF NOT EXISTS idx_retainers_agent ON retainers (agent_id, status);

-- One row per scheduled slot. The unique pair is what makes a slot run once, whatever restarts,
-- double triggers or overlapping workers try.
CREATE TABLE IF NOT EXISTS retainer_runs (
  run_id        TEXT PRIMARY KEY,
  retainer_id   TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  -- pending | running | completed | failed | skipped
  status        TEXT NOT NULL,
  -- see SkipReason in retainerPolicy.ts
  skip_reason   TEXT,
  task_id       TEXT,
  price_wei     TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT,
  UNIQUE (retainer_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_retainer_runs_retainer ON retainer_runs (retainer_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_retainer_runs_task ON retainer_runs (task_id);
