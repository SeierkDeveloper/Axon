-- Mylo, phase 8: crews. A team of agents a wallet saved under a name, each with its role, in the order they work: the
-- first gets the task, each next one gets the task and the one before's answer.
CREATE TABLE IF NOT EXISTS mylo_crews (
  wallet TEXT NOT NULL,
  name TEXT NOT NULL,
  -- [{ agentId, role }]
  members TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (wallet, name)
);
