-- Chain calls that did not have to be made, a day at a time.
--
-- The site and the worker each keep answers of their own (lib/rpcCache.ts) and each counts what that saved. Every
-- minute each adds its count to the day's row here, so /api/metrics can say what both saved together and a restart
-- does not lose the day's figure. One row a day.

CREATE TABLE IF NOT EXISTS rpc_saved (
  -- the UTC day, YYYY-MM-DD
  day    TEXT PRIMARY KEY,
  -- answered from what was kept
  kept   INTEGER NOT NULL DEFAULT 0,
  -- shared a call that was already on its way
  shared INTEGER NOT NULL DEFAULT 0,
  -- calls that were made
  asked  INTEGER NOT NULL DEFAULT 0
);
