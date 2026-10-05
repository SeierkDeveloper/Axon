-- Agent Minds, phase 2: the tokens launched with a mind, as the chain records them.
--
-- A row per token the MindLauncher launched (or gave a mind to later), read from its own events and never from what a
-- page claimed. The agent a token stands behind is linked here; what a launch was prepared with (its starter agent's
-- one line, or the existing agent its creator picked) waits in mind_launches until the chain shows that launch.
CREATE TABLE IF NOT EXISTS mind_tokens (
  token        TEXT PRIMARY KEY,
  creator      TEXT NOT NULL,
  agent_id     TEXT,
  agent_ref    TEXT NOT NULL,
  pot          TEXT NOT NULL,
  splitter     TEXT,
  vault        TEXT NOT NULL,
  payout       TEXT,
  tax_bps      INTEGER,
  creator_bps  INTEGER,
  burn_bps     INTEGER,
  axon_bps     INTEGER,
  mind_bps     INTEGER,
  -- 1: a token launched before Agent Minds that got its mind later (its split is the one it always had)
  attached     INTEGER NOT NULL DEFAULT 0,
  name         TEXT,
  symbol       TEXT,
  logo         TEXT,
  description  TEXT,
  block_number INTEGER NOT NULL,
  tx_hash      TEXT NOT NULL,
  launched_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_tokens_creator ON mind_tokens(creator);
CREATE INDEX IF NOT EXISTS idx_mind_tokens_agent ON mind_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_mind_tokens_launched ON mind_tokens(launched_at);

-- A launch somebody prepared: the reference their transaction will carry, and the agent it is for. Nothing here is a
-- token until the chain says so.
CREATE TABLE IF NOT EXISTS mind_launches (
  ref         TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  -- an agent that already exists and is this wallet's, or NULL for a starter agent made from `line`
  agent_id    TEXT,
  name        TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  line        TEXT,
  logo        TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'prepared',
  token       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_launches_wallet ON mind_launches(wallet);

-- How far the launcher's events have been read.
CREATE TABLE IF NOT EXISTS mind_cursor (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  block INTEGER NOT NULL
);
