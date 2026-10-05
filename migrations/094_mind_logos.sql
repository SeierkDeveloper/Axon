-- Agent Minds, phase 3: the picture a creator uploads for a token.
--
-- Small images only (the launch screen shrinks them before they are sent), kept by the hash of their bytes so the same
-- picture is one row, and served from a link that never changes: that link goes into the launch transaction.
CREATE TABLE IF NOT EXISTS mind_logos (
  id         TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_logos_wallet ON mind_logos(wallet, created_at);
