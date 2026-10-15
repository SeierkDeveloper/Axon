-- Agents that sell what they make.
--
-- A product is one version of a page an agent built, put up for sale by the agent's owner: its title, a few words
-- about it, and a price in ETH. What is sold is that version and nothing else: its fingerprint is kept with the
-- product, and every buyer gets exactly those files, with the fingerprint on their receipt. Only a page the owner had
-- built through Axon can be listed: one the agent built for the owner themselves, never one it built for a customer.
--
-- A sale is one purchase. Its payment is an ordinary row in transactions, under the sale's id where a job's id would
-- be, so a sale reaches the owner's earnings and is withdrawn exactly as a paid job is. A buyer is a wallet, or an
-- agent buying another agent's product as material for a job, paid from its balance.
--
-- Nothing here is read while AGENT_SHOP is off.

CREATE TABLE IF NOT EXISTS shop_products (
  product_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  seller_wallet TEXT NOT NULL,             -- the agent's owner when it was listed, lowercase
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,                -- the version that is sold
  sha256 TEXT NOT NULL,                    -- that version's fingerprint
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price_wei TEXT NOT NULL,
  prev_price_wei TEXT,                     -- the price before the last change, honoured for a short while after it
  price_changed_at TEXT,
  status TEXT NOT NULL DEFAULT 'listed',   -- listed, or down (taken down by its owner); a page taken down after
                                           -- reports or by a moderator takes its product off sale with it
  made_by TEXT NOT NULL DEFAULT 'owner',   -- owner, or agent: made and listed by the agent on its own
  sold INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_products_agent ON shop_products(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_products_status ON shop_products(status, created_at);
-- one listing at a time for one page
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_products_site_listed ON shop_products(site_id) WHERE status = 'listed';

CREATE TABLE IF NOT EXISTS shop_sales (
  sale_id TEXT PRIMARY KEY,                -- also the task_id of its payment in transactions
  product_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,                  -- the seller
  buyer TEXT NOT NULL,                     -- a wallet (lowercase), or the agent that bought it
  buyer_kind TEXT NOT NULL,                -- wallet or agent
  for_task_id TEXT,                        -- the job an agent bought it for, as material
  price_wei TEXT NOT NULL,
  payment_signature TEXT,                  -- the transaction that paid; NULL when paid from an agent's balance
  status TEXT NOT NULL,                    -- paid, delivered or refunded
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  title TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_sales_signature ON shop_sales(payment_signature) WHERE payment_signature IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shop_sales_buyer ON shop_sales(buyer, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_sales_product ON shop_sales(product_id, status);
CREATE INDEX IF NOT EXISTS idx_shop_sales_task ON shop_sales(for_task_id) WHERE for_task_id IS NOT NULL;

-- What an owner lets one agent do in the shop by itself: make and list products on a schedule, and buy other agents'
-- products as material for its jobs. Both start off.
CREATE TABLE IF NOT EXISTS shop_agents (
  agent_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  make_on INTEGER NOT NULL DEFAULT 0,
  make_kind TEXT,                          -- what kind of products, in the owner's words
  make_price_wei TEXT,
  make_every_hours INTEGER,
  make_per_day INTEGER,
  make_next_at TEXT,
  buy_on INTEGER NOT NULL DEFAULT 0,
  buy_max_wei TEXT,                        -- the most one job may spend on material
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_agents_due ON shop_agents(make_on, make_next_at);

-- Each time an agent sets out to make a product on its own: the job, and the product it became. One per agent per
-- slot, claimed before the job is made, so two workers or a restart cannot make two.
CREATE TABLE IF NOT EXISTS shop_make_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  task_id TEXT,
  status TEXT NOT NULL,                    -- running, listed, failed or skipped
  product_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (agent_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_shop_make_runs_open ON shop_make_runs(status, created_at);
