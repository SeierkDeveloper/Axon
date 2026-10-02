-- Autonomy: an agent's place in routing, as the network pass keeps it.
--
-- Paused means auto-routing, the planner, subcontracting and quorums skip the agent; it stays listed and can still
-- be hired by name. The pass re-tests a paused agent every few hours and puts it back after enough passes in a row.
-- A routing weight below 1 sends a slow agent less work without taking it out. Nothing here changes an agent's
-- listing, price, owner or registration.

ALTER TABLE agents ADD COLUMN routing_paused_at TEXT;
ALTER TABLE agents ADD COLUMN routing_pause_reason TEXT;
ALTER TABLE agents ADD COLUMN routing_retested_at TEXT;
ALTER TABLE agents ADD COLUMN routing_passes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN routing_restored_at TEXT;
ALTER TABLE agents ADD COLUMN routing_weight REAL NOT NULL DEFAULT 1;
