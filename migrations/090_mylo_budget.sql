-- Mylo's spend: one row per model call, costed from the model's own usage report, so the day's total is a sum of what
-- was really billed. Money in millionths of a dollar, as whole numbers.
CREATE TABLE IF NOT EXISTS mylo_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  model TEXT NOT NULL,
  speaker TEXT,
  conversation_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- 1 when the call failed before reporting its usage, and its upper bound was counted instead
  estimated INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mylo_usage_time ON mylo_usage(created_at);

-- the address (hashed) each message was sent from, so making more wallets doesn't make more messages
ALTER TABLE mylo_messages ADD COLUMN ip_key TEXT;
CREATE INDEX IF NOT EXISTS mylo_messages_ip ON mylo_messages(ip_key, created_at);
