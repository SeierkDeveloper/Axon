-- Agent Minds, phase 8: a mind for a token launched before minds.
--
-- What the token's creator chose for the mind they are about to give it (the model, their own server if any, the
-- agent it stands behind). The chain's record of the mind being given names only the token, its pot and its treasury;
-- this row is how those choices find it. One row a pot: a token gets one mind.
CREATE TABLE IF NOT EXISTS mind_attaches (
  pot        TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  token      TEXT NOT NULL,
  agent_id   TEXT,
  model      TEXT NOT NULL,
  mind_url   TEXT,
  created_at TEXT NOT NULL
);
