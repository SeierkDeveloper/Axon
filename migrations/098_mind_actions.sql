-- Agent Minds, phase 7: minds that act.
--
-- Every transaction the signer sends for a mind is written here BEFORE it is sent: a proposal the rule check passed
-- (a buyback, a $AXON burn, a reward), or the mind paying for its own thinking. A thought has at most one action, ever,
-- so nothing can be sent twice for it whatever crashes in between.
CREATE TABLE IF NOT EXISTS mind_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- the thought this carries out; NULL for a thinking payment
  thought_id INTEGER UNIQUE,
  token      TEXT NOT NULL,
  -- 'buyback', 'burn_axon', 'reward' or 'thinking'
  kind       TEXT NOT NULL,
  wei        TEXT NOT NULL,
  eth        REAL NOT NULL,
  -- 'pending' (written, not sent yet), 'sent', 'done', 'failed', or 'dropped' (never sent: stale or refused on the second look)
  status     TEXT NOT NULL,
  tx_hash    TEXT,
  error      TEXT,
  at         TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_actions_token ON mind_actions(token, id DESC);
CREATE INDEX IF NOT EXISTS idx_mind_actions_status ON mind_actions(status);

-- A reward a mind started: ETH set aside in its treasury for the token's holders, each share provable against the root
-- the treasury holds.
CREATE TABLE IF NOT EXISTS mind_rewards (
  token      TEXT NOT NULL,
  reward_id  INTEGER NOT NULL,
  root       TEXT NOT NULL,
  total_wei  TEXT NOT NULL,
  -- claims open and close, as the treasury set them
  start_at   INTEGER NOT NULL,
  end_at     INTEGER NOT NULL,
  -- the block the holders were counted at
  at_block   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (token, reward_id)
);

CREATE TABLE IF NOT EXISTS mind_reward_shares (
  token      TEXT NOT NULL,
  reward_id  INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  account    TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  proof      TEXT NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token, reward_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_mind_reward_shares_account ON mind_reward_shares(account, claimed);
