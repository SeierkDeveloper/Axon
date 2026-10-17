-- Agents that run their own business.
--
-- An owner gives one of their agents a goal ("run a logo studio"), a budget and limits. From then on the agent looks
-- for work on the network itself, bids on what fits, does the work, hires help for parts of a job, sells in its shop,
-- and reinvests within the limits. Every decision it makes is written down with its reason, and every amount that comes
-- in or goes out is a line in its ledger, so its P&L is read from what happened and nothing else.
--
-- Money never moves through these tables. What an agent earns is what its paid jobs and sales settled at, in
-- transactions, as for any agent; what it spends goes through the paths that already pay (a hire from its balance or its
-- owner's allowance, a purchase from its balance). The ledger records each of those once, under the id of the job, the
-- sale or the hire it came from.
--
-- Nothing here is read while AGENT_BUSINESS is off.

CREATE TABLE IF NOT EXISTS businesses (
  business_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,              -- lowercase; the agent's owner when it started
  goal TEXT NOT NULL,                      -- in the owner's words
  status TEXT NOT NULL DEFAULT 'active',   -- active, paused, stopped
  paused_reason TEXT,                      -- set when the business paused itself (the agent changed hands, a limit)
  -- limits, all in wei, all set by the owner
  budget_wei TEXT NOT NULL,                -- the most it may spend in total, ever
  max_per_day_wei TEXT NOT NULL,           -- the most it may spend in one UTC day
  max_per_job_wei TEXT NOT NULL,           -- the most it may spend on one job
  approve_above_wei TEXT NOT NULL,         -- a single spend above this waits for the owner's OK
  spend_kinds TEXT NOT NULL DEFAULT '',    -- what it may spend on: hire, material, model (comma separated)
  allowance_key_id TEXT,                   -- the owner's allowance key that pays when its earnings do not cover a hire
  -- its price, which it moves by demand inside the owner's bounds
  price_min_wei TEXT NOT NULL,
  price_max_wei TEXT NOT NULL,
  bids_per_hour INTEGER NOT NULL DEFAULT 3,
  -- selling: the shop's own making, switched on and steered by the business
  sell_on INTEGER NOT NULL DEFAULT 0,
  sell_price_wei TEXT,
  sell_kind TEXT,                          -- what it makes, as it last steered it
  -- the model it started on, so a step up can be undone and never goes below where it began
  start_model TEXT,
  next_scan_at TEXT,
  last_scan_at TEXT,
  last_reinvest_day TEXT,                  -- UTC day of the last reinvestment pass
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT
);
-- one running or paused business per agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_agent_open ON businesses(agent_id) WHERE status != 'stopped';
CREATE INDEX IF NOT EXISTS idx_businesses_owner ON businesses(owner_wallet, created_at);
CREATE INDEX IF NOT EXISTS idx_businesses_due ON businesses(status, next_scan_at);

-- The P&L, a line per amount. Earned: a job it did (the payment it settled at) or a sale. Spent: a hire it paid for, a
-- product it bought as material, or the model costs of its jobs and of its own decisions (measured per call; Axon pays
-- those for agents it runs). A line is written once per thing it came from (unique on kind and ref), and a hire that
-- was refunded is voided, never deleted.
CREATE TABLE IF NOT EXISTS business_ledger (
  entry_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  direction TEXT NOT NULL,                 -- in or out
  kind TEXT NOT NULL,                      -- job, sale, hire, material, model, event
  amount_wei TEXT NOT NULL,                -- what it was worth in ETH; for model costs, at the ETH price of that moment
  cost_usd REAL,                           -- model costs as measured, in dollars
  ref TEXT NOT NULL,                       -- the job, sale, hire or check it came from
  job_ref TEXT,                            -- the job a hire or a purchase was for, so a job's own limit can be kept
  note TEXT,
  day TEXT NOT NULL,                       -- UTC day, YYYY-MM-DD
  voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_ledger_once ON business_ledger(business_id, kind, ref);
CREATE INDEX IF NOT EXISTS idx_business_ledger_day ON business_ledger(business_id, day);
CREATE INDEX IF NOT EXISTS idx_business_ledger_job ON business_ledger(business_id, job_ref) WHERE job_ref IS NOT NULL;

-- Every decision, with its reason: a job taken or declined, a bid won or lost, a hire made or refused, an OK asked, a
-- price moved, a model changed, what it makes changed, a pause, a stop. A decision about one thing is written once
-- (once_key), so a scan every few minutes does not fill the log with the same no.
CREATE TABLE IF NOT EXISTS business_decisions (
  decision_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT,                            -- the open task, job, product or setting it is about
  reason TEXT NOT NULL,
  detail TEXT,                             -- JSON
  once_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_decisions_once ON business_decisions(business_id, once_key) WHERE once_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_decisions_at ON business_decisions(business_id, created_at);

-- The work it went after: the open task, its bid, and the job it became once the poster accepted.
CREATE TABLE IF NOT EXISTS business_jobs (
  business_id TEXT NOT NULL,
  open_task_id TEXT NOT NULL,
  bid_id TEXT NOT NULL,
  task_id TEXT,                            -- the job, once the poster accepted the bid
  status TEXT NOT NULL,                    -- bid, won, lost, done, failed
  team INTEGER NOT NULL DEFAULT 0,         -- it decided the job needs help: it is run as a team
  price_wei TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (business_id, open_task_id)
);
CREATE INDEX IF NOT EXISTS idx_business_jobs_task ON business_jobs(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_jobs_status ON business_jobs(business_id, status);

-- The daily report the agent writes about one UTC day, from that day's ledger.
CREATE TABLE IF NOT EXISTS business_reports (
  business_id TEXT NOT NULL,
  day TEXT NOT NULL,
  text TEXT NOT NULL,
  numbers TEXT NOT NULL,                   -- JSON: the ledger figures it was written from
  dropped INTEGER NOT NULL DEFAULT 0,      -- sentences thrown out for a number not in the ledger
  model TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (business_id, day)
);
