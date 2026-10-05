-- Agent Minds, phase 4: what the board and the launch terminal show for every token.
--
-- mind_stats is one row a token, rewritten by the worker from the chain: its price and market cap, how far along its
-- curve it is, its holders, what its fees have paid out and burned, what its mind holds. Pages read this row; they
-- never ask the chain for every token on every visit.
ALTER TABLE mind_tokens ADD COLUMN curve TEXT;

CREATE TABLE IF NOT EXISTS mind_stats (
  token          TEXT PRIMARY KEY,
  -- 0 on its curve, 1 swept (between curve and pool), 2 trading in its pool, 3 rescued
  phase          INTEGER NOT NULL DEFAULT 0,
  price_eth      REAL,
  mcap_eth       REAL,
  -- how far along the curve, in hundredths of a percent; 10000 once it has graduated
  curve_bps      INTEGER NOT NULL DEFAULT 0,
  holders        INTEGER NOT NULL DEFAULT 0,
  fees_eth       REAL NOT NULL DEFAULT 0,
  to_mind_eth    REAL NOT NULL DEFAULT 0,
  burned_tokens  REAL NOT NULL DEFAULT 0,
  burned_eth     REAL NOT NULL DEFAULT 0,
  burns          INTEGER NOT NULL DEFAULT 0,
  treasury_eth   REAL NOT NULL DEFAULT 0,
  -- the block the holder balances below are counted up to
  holders_block  INTEGER,
  updated_at     TEXT
);

-- Who holds a token, kept up to date from its own Transfer events. Balances are whole numbers of the smallest unit.
CREATE TABLE IF NOT EXISTS mind_holders (
  token   TEXT NOT NULL,
  address TEXT NOT NULL,
  balance TEXT NOT NULL,
  PRIMARY KEY (token, address)
);

-- What happened, newest last: a launch, fees paid out, a burn, a graduation. The terminal's running log.
CREATE TABLE IF NOT EXISTS mind_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  token  TEXT NOT NULL,
  kind   TEXT NOT NULL,
  eth    REAL,
  tokens REAL,
  at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_events_at ON mind_events(id DESC);
CREATE INDEX IF NOT EXISTS idx_mind_events_token ON mind_events(token, id DESC);
