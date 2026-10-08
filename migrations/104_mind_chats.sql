-- Talk to the mind: anyone can ask a token's mind a question on its page and read its answer.
--
-- A question changes nothing the mind does. Its plan, its standing orders, its limits and its creator's brief are
-- written elsewhere and nothing here writes them. The answer is paid for by the mind's own treasury, inside the same
-- daily thinking limit as its thoughts: what it cost is also written into mind_thoughts as a row with status and
-- source 'chat' and no text, so every sum of what a mind owes for thinking counts it without a second ledger.

CREATE TABLE IF NOT EXISTS mind_chats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- the token whose mind answered
  token         TEXT NOT NULL,
  -- the wallet that asked, lowercase, or NULL for a visitor who was not signed in
  asker         TEXT,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  model         TEXT NOT NULL,
  -- an answer written by the free stand-in rather than a model: it is never billed
  standin       INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  cost_eth      REAL NOT NULL DEFAULT 0,
  -- the asker's $AXON holder tier when they asked ('base' for a visitor with no wallet)
  tier          TEXT NOT NULL DEFAULT 'base',
  -- the row in mind_thoughts that carries its cost
  thought_id    INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_chats_token ON mind_chats(token, id DESC);
CREATE INDEX IF NOT EXISTS idx_mind_chats_asker ON mind_chats(asker, created_at DESC);
