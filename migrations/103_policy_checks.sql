-- Outside policy checks on Allowances.
--
-- A wallet with an allowance can link an outside policy provider. Before Axon reserves from that allowance for a
-- hire, it asks the provider, which answers allow, refuse, or approval needed. The on-chain limits apply to every
-- hire whatever the provider says: a provider can make a spend stricter and can never move money or raise a limit.

-- One link per wallet. The provider's API key belongs to the user and is stored encrypted; `key_hint` is its last
-- four characters, which is all that is ever shown again.
CREATE TABLE IF NOT EXISTS allowance_policy_links (
  owner        TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  key_enc      TEXT NOT NULL,
  key_hint     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Every answer, and every time there was none. `outcome` is the provider's decision ('allow', 'refuse',
-- 'authorization_required'), 'not_recognised' when it rejected the link itself, or 'unavailable' when it did not
-- answer in time, in which case the hire went on under the wallet's own limits.
CREATE TABLE IF NOT EXISTS allowance_policy_checks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner        TEXT NOT NULL,
  provider     TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  asset        TEXT NOT NULL,
  amount       TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  reason       TEXT,
  action_id    TEXT,
  ms           INTEGER NOT NULL DEFAULT 0,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_allowance_policy_checks_owner ON allowance_policy_checks (owner, id);
