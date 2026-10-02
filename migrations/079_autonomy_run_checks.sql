-- Autonomy: how many checks each network pass ran, and which could not run, so the hourly record says how much
-- of the network it actually looked at. checks_unavailable is a JSON array of check names.

ALTER TABLE autonomy_network_runs ADD COLUMN checks_run INTEGER;
ALTER TABLE autonomy_network_runs ADD COLUMN checks_unavailable TEXT;
