-- A webhook per retainer: where its results are sent as each run finishes.
--
-- Separate from the agent webhooks table on purpose. Those belong to agents (a foreign key to
-- agents), and a retainer's owner is usually just a wallet. Rebuilding that table to loosen the key
-- would cascade-delete its delivery history, so retainers get their own, signed and retried the same way.

ALTER TABLE retainers ADD COLUMN webhook_url TEXT;
ALTER TABLE retainers ADD COLUMN webhook_secret TEXT;
-- consecutive deliveries that failed after every retry; three in a row switches the webhook off
ALTER TABLE retainers ADD COLUMN webhook_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retainers ADD COLUMN webhook_disabled_at TEXT;

CREATE TABLE IF NOT EXISTS retainer_deliveries (
  delivery_id     TEXT PRIMARY KEY,
  retainer_id     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  -- pending | delivered | failed
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_attempt_at TEXT,
  response_status INTEGER,
  response_body   TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (retainer_id) REFERENCES retainers(retainer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_retainer_deliveries_due ON retainer_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_retainer_deliveries_retainer ON retainer_deliveries (retainer_id, created_at);
