-- Autonomy: when the network pass last re-priced an agent whose owner turned on auto-pricing, so it does that at
-- most once a day however often the pass runs.

ALTER TABLE agents ADD COLUMN price_auto_at TEXT;
