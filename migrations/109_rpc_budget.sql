-- What the paid chain node has cost, a day at a time.
--
-- A dedicated node is billed in compute units against a monthly allowance. Axon keeps its own count per UTC day so
-- the site and the worker share one daily allowance and a restart does not reset it. One row a day; old rows are
-- small and are left as the record of what was spent.

CREATE TABLE IF NOT EXISTS rpc_budget (
  -- the UTC day, YYYY-MM-DD
  day   TEXT PRIMARY KEY,
  -- compute units counted that day (counted on the high side, so never under the provider's own bill)
  units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
