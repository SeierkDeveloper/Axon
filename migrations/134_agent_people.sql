-- Agents that hire people.
--
-- When an agent meets something only a person can do (make a call, take a photo, check a place, judge whether something
-- looks right), it posts a task for people. Anyone signed in with a wallet can take it, do it and hand in proof: a photo,
-- a file or a short answer. The payment is locked when the task is posted, the agent checks the proof against what the
-- task said it must show, and an accepted task is paid to the person's wallet in ETH on Robinhood Chain.
--
-- Money: a task is paid for up front, either from what its agent earned (its balance, which these locks are taken out
-- of) or by its owner sending the amount to Axon's receiving wallet first. A lock that is not used comes back: to the
-- agent's balance, or to the owner's wallet on-chain. Every amount that leaves Axon's wallet for this is a row in
-- people_payouts with its transaction hash.
--
-- Nothing here is read while AGENT_PEOPLE is off.

CREATE TABLE IF NOT EXISTS people_tasks (
  task_id TEXT PRIMARY KEY,                -- pt_...
  agent_id TEXT NOT NULL,                  -- the agent that posted it
  owner_wallet TEXT NOT NULL,              -- lowercase; the agent's owner when it was posted
  posted_by TEXT NOT NULL,                 -- owner (by hand, the API, Mylo or an assistant) or agent (during a job)
  parent_task_id TEXT,                     -- the job it was posted from, if any
  business_id TEXT,                        -- the business it is for, if any
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  place TEXT,                              -- an area or a public place, never a private address
  proof_kind TEXT NOT NULL,                -- photo, file or answer
  checks TEXT NOT NULL,                    -- JSON: what the proof must show, one line each; the only grounds to reject
  price_wei TEXT NOT NULL,
  funding TEXT NOT NULL,                   -- earnings or wallet
  funding_tx TEXT,                         -- the owner's payment, when funded from their wallet
  lock_state TEXT NOT NULL DEFAULT 'none', -- none (waiting for the owner's OK), held, paid, returned
  status TEXT NOT NULL,                    -- approval, open, taken, delivered, review, accepted, paid, cancelled, expired
  approval_id TEXT,                        -- the owner's OK it waits for, when an agent asked above its owner's amount
  min_done INTEGER NOT NULL DEFAULT 0,     -- accepted tasks a person needs on their record to take it
  take_hours INTEGER NOT NULL,             -- how long a person has once they take it
  deadline_at TEXT NOT NULL,               -- after this nobody new can take it, and an unused lock comes back
  taker_wallet TEXT,
  taken_at TEXT,
  take_until TEXT,
  tries INTEGER NOT NULL DEFAULT 0,        -- deliveries by the current taker
  second_look INTEGER NOT NULL DEFAULT 0,  -- the current taker asked the owner to look at a rejection
  review_until TEXT,                       -- when a task in review is paid if its owner has not answered
  hidden_at TEXT,                          -- taken off the board by moderation
  hidden_reason TEXT,
  close_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_tasks_board ON people_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_people_tasks_agent ON people_tasks(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_people_tasks_owner ON people_tasks(owner_wallet, created_at);
CREATE INDEX IF NOT EXISTS idx_people_tasks_taker ON people_tasks(taker_wallet, status);
CREATE INDEX IF NOT EXISTS idx_people_tasks_parent ON people_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_tasks_funding_tx ON people_tasks(funding_tx) WHERE funding_tx IS NOT NULL;

-- What a person handed in, and what was decided about it. A file is kept in the files store (task_files), private to
-- the person and the task's owner, for as long as that store keeps a wallet's files.
CREATE TABLE IF NOT EXISTS people_deliveries (
  delivery_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  try_no INTEGER NOT NULL,
  answer TEXT,
  file_id TEXT,
  file_sha256 TEXT,
  file_mime TEXT,
  verdict TEXT,                            -- accept, reject, unsure; null while it is being checked
  verdict_reason TEXT,
  failed_check INTEGER,                    -- which of the task's checks it did not meet (0 based), on a reject
  verdict_by TEXT,                         -- check, owner, silence, moderator
  check_model TEXT,
  check_cost_usd REAL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_deliveries_task ON people_deliveries(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_people_deliveries_wallet ON people_deliveries(wallet, verdict);
CREATE INDEX IF NOT EXISTS idx_people_deliveries_open ON people_deliveries(verdict) WHERE verdict IS NULL;

-- ETH that left Axon's receiving wallet for a task: the person's pay, or an owner's unused payment going back to them.
-- Written as pending before anything is sent; the hash is saved the moment it exists. One of each kind per task.
CREATE TABLE IF NOT EXISTS people_payouts (
  payout_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- pay or return
  wallet TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending, sent, failed
  tx_hash TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_payouts_once ON people_payouts(task_id, kind);
CREATE INDEX IF NOT EXISTS idx_people_payouts_status ON people_payouts(status, created_at);

-- A task's own log, oldest first: posted, taken, handed in, checked, accepted or rejected with the reason, paid with the
-- hash, given up, reopened, expired. Its public part never names an owner.
CREATE TABLE IF NOT EXISTS people_events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  wallet TEXT,                             -- the person it is about, if any
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_events_task ON people_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_people_events_wallet ON people_events(wallet, kind) WHERE wallet IS NOT NULL;

-- Reports from anyone about a task that breaks the rules. Enough of them take it off the board until a moderator looks.
CREATE TABLE IF NOT EXISTS people_reports (
  report_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reporter TEXT NOT NULL,                  -- a wallet, or a hash of the visitor's address
  reason TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- open, upheld, dismissed
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_reports_once ON people_reports(task_id, reporter);

-- Wallets moderation stopped from taking tasks, and agents stopped from posting them.
CREATE TABLE IF NOT EXISTS people_blocks (
  subject TEXT PRIMARY KEY,                -- a wallet (lowercase) or agent:<agentId>
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
