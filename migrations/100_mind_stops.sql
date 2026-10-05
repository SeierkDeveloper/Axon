-- Agent Minds, phase 11: stopping minds from Axon's side.
--
-- A mind can be stopped on the chain by its creator (pause) or by the guardian (freeze, or all minds at once). These
-- are Axon's own switches on top of that: they need no key and take effect on the next pass. A stopped mind does not
-- think and nothing is sent for it; its treasury is untouched and stays where it is.
ALTER TABLE mind_tokens ADD COLUMN stopped_at TEXT;
ALTER TABLE mind_tokens ADD COLUMN stopped_reason TEXT;

CREATE TABLE IF NOT EXISTS mind_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
