-- Jobs that start themselves: a saved job, and what sets it off.
--
-- A trigger is an agent, what to ask it, and an event: something arriving at the trigger's own address (a webhook
-- call or a file), or something happening on chain (a contract's log). When the event comes, the agent is hired with
-- it, exactly as a person would hire it, paid from the owner's allowance when the agent charges.

CREATE TABLE IF NOT EXISTS triggers (
  trigger_id            TEXT PRIMARY KEY,
  owner_wallet          TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  name                  TEXT NOT NULL,
  -- 'inbound': a call or a file sent to the trigger's address. 'chain': a log from a contract.
  kind                  TEXT NOT NULL,
  instructions          TEXT NOT NULL,
  -- inbound: SHA-256 of the secret that may fire it (the secret itself is shown once and not kept)
  secret_hash           TEXT,
  -- chain: the contract whose logs set it off, an optional first topic, and the block read up to
  chain_address         TEXT,
  chain_topic0          TEXT,
  last_block            INTEGER,
  -- the most one run may cost, in wei, for an agent that charges; NULL for a free agent
  max_price_wei         TEXT,
  pay_in                TEXT NOT NULL DEFAULT 'ETH',
  api_key_id            TEXT,
  max_runs_per_day      INTEGER NOT NULL DEFAULT 20,
  report_file           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  pause_reason          TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  runs_done             INTEGER NOT NULL DEFAULT 0,
  last_fired_at         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_owner ON triggers(owner_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_triggers_chain ON triggers(kind, status);

CREATE TABLE IF NOT EXISTS trigger_runs (
  run_id       TEXT PRIMARY KEY,
  trigger_id   TEXT NOT NULL,
  -- what makes this event this event: a transaction and log index, or the caller's idempotency key. The same event
  -- cannot start two runs.
  event_key    TEXT NOT NULL,
  -- one short line saying what happened, for the list
  summary      TEXT NOT NULL,
  -- 'running' once an agent is hired; 'skipped' when it was not, with the reason
  status       TEXT NOT NULL,
  skip_reason  TEXT,
  error        TEXT,
  task_id      TEXT,
  price_wei    TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (trigger_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_trigger_runs_trigger ON trigger_runs(trigger_id, created_at DESC);
