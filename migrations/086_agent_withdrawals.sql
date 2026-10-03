-- Agent Studio, phase 6: creators take what their agents earned out to their own wallet. Every withdrawal is a row
-- written BEFORE any ETH moves (pending), with its transaction hash the moment it is sent, so a crash between the send
-- and the record can never pay twice: a pending row still counts as taken out until it is settled.
CREATE TABLE IF NOT EXISTS agent_withdrawals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount_eth TEXT NOT NULL,
  -- pending, sent, failed
  status TEXT NOT NULL,
  tx_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_withdrawals_agent ON agent_withdrawals(agent_id, created_at);
CREATE INDEX IF NOT EXISTS agent_withdrawals_wallet ON agent_withdrawals(wallet, created_at);
