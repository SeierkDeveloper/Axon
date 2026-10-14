-- Autonomy 3, "makes agents better and proves it": an agent's owner switches it on once, and from then on the network
-- may change the agent's instructions when a new version beats the old one on the same jobs (and change them back when
-- it slips). Off for every agent until its owner, or for Axon's own agents the admin, turns it on.
ALTER TABLE agents ADD COLUMN auto_improve INTEGER NOT NULL DEFAULT 0;
