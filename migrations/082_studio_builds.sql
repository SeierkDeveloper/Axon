-- Agent Studio, phase 2: a build, from the sentence its owner typed to the agent it becomes. Its draft, test tasks,
-- grades and rewrites are the owner's alone until it is published (studioPolicy.DRAFTS_ARE_PRIVATE).

CREATE TABLE IF NOT EXISTS studio_builds (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  sentence TEXT NOT NULL,
  -- drafting, drafted, testing, improving, ready, published, failed, stopped
  status TEXT NOT NULL,
  draft TEXT,
  score REAL,
  agent_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_builds_wallet ON studio_builds(wallet, created_at);
CREATE INDEX IF NOT EXISTS studio_builds_status ON studio_builds(status);
