-- What the paid chain node has cost, by the kind of call.
--
-- rpc_budget keeps one total a day. This keeps the same count split by method, for two things: the day's allowance
-- is shared out over the day for reads while a part of it is held back for sending transactions (rpcBudget.ts
-- needs the two sums), and /api/metrics can say which kind of call the units went on. A handful of rows a day.

CREATE TABLE IF NOT EXISTS rpc_budget_methods (
  -- the UTC day, YYYY-MM-DD
  day    TEXT NOT NULL,
  method TEXT NOT NULL,
  units  INTEGER NOT NULL DEFAULT 0,
  calls  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, method)
);
