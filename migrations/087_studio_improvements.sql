-- Agent Studio, phase 7: a live Studio agent keeps getting better. When real jobs go wrong, Axon writes a better
-- version and tests it against the current one on the same tasks (the originals plus new ones modelled on what went
-- wrong). A clearly better one is proposed to the owner, who applies it or not; nothing changes their agent unasked.
CREATE TABLE IF NOT EXISTS studio_improvements (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  build_id TEXT NOT NULL,
  -- testing, proposed, no-better, applied, dismissed, failed
  status TEXT NOT NULL,
  weak_jobs INTEGER NOT NULL,
  from_score REAL,
  to_score REAL,
  instructions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_improvements_agent ON studio_improvements(agent_id, created_at);
