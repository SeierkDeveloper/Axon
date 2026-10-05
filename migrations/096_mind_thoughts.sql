-- Agent Minds, phase 5: minds that think.
--
-- The model a mind runs on is chosen at launch and never changed: it is written with the prepared launch and copied to
-- the token when the chain shows that launch. Nothing updates it afterwards.
ALTER TABLE mind_launches ADD COLUMN model TEXT;
ALTER TABLE mind_tokens ADD COLUMN model TEXT;

-- Where a mind last took note of its holders and of what its agent earned: a thought is woken by a real change since
-- then, not by every small move.
ALTER TABLE mind_stats ADD COLUMN holders_mark INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mind_stats ADD COLUMN earned_mark REAL NOT NULL DEFAULT 0;

-- A mind's journal: every thought, in public, with what woke it, what it proposed, what the rule check said, and what
-- the thinking cost. `standin` marks a thought written by the free stand-in rather than a model: it is never billed.
CREATE TABLE IF NOT EXISTS mind_thoughts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL,
  at             TEXT NOT NULL,
  model          TEXT NOT NULL,
  standin        INTEGER NOT NULL DEFAULT 0,
  -- 'thought' or 'failed' (the model could not be reached or answered nothing usable)
  status         TEXT NOT NULL,
  reasons        TEXT NOT NULL,
  thought        TEXT,
  -- what it proposed, as JSON, or NULL when it proposed nothing
  action         TEXT,
  -- 'none', 'approved' or 'refused', by the fixed rule check
  verdict        TEXT NOT NULL DEFAULT 'none',
  verdict_reason TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  cost_eth       REAL NOT NULL DEFAULT 0,
  -- the newest event this thought had seen: the next one is woken only by what came after
  last_event_id  INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_mind_thoughts_token ON mind_thoughts(token, id DESC);
CREATE INDEX IF NOT EXISTS idx_mind_thoughts_at ON mind_thoughts(at);
