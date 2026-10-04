-- Mylo, phase 2: what Mylo proposes to do with someone's money, and what became of it. A proposal holds the exact
-- agents, task and prices the person saw; it runs only when they confirm it, and only as it was proposed.
CREATE TABLE IF NOT EXISTS mylo_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  wallet TEXT NOT NULL,
  -- hire (one agent or several for a second opinion)
  kind TEXT NOT NULL,
  task TEXT NOT NULL,
  -- [{ agentId, name, price, priceEth, taskId, error }]
  hires TEXT NOT NULL,
  -- proposed, running, done, failed, cancelled
  status TEXT NOT NULL,
  result_message_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mylo_actions_owner ON mylo_actions(owner, created_at);
CREATE INDEX IF NOT EXISTS mylo_actions_conversation ON mylo_actions(conversation_id, created_at);
