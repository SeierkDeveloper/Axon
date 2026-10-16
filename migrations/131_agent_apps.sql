-- Agents that work in your apps.
--
-- An owner connects an app once (GitHub, Notion, Slack, Google Docs, Gmail). What the app hands back to sign in with
-- is kept here sealed: AES-256-GCM under a key from the environment, never in the clear, never in a log, never in an
-- answer. key_id says which key sealed it, so a key can be replaced and the old rows opened and sealed again.
--
-- The owner says, for each agent and each app, what it may do there: read, write a draft, publish or send. Anything
-- that publishes or sends waits in app_approvals for the owner's OK, with a preview of exactly what would go out.
--
-- Nothing here is read while AGENT_APPS is off.

CREATE TABLE IF NOT EXISTS app_connections (
  connection_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,              -- lowercase
  app_id TEXT NOT NULL,                    -- github, notion, slack, gdocs, gmail
  account_label TEXT,                      -- who it is in the app: a login, a workspace, an email address
  scopes TEXT NOT NULL DEFAULT '',         -- what the app granted, space separated
  access_token_enc TEXT,                   -- sealed; NULL once disconnected
  refresh_token_enc TEXT,                  -- sealed; NULL when the app gives none, and once disconnected
  key_id TEXT,                             -- the key that sealed both
  expires_at TEXT,                         -- when the access token stops working; NULL when it does not
  needs_reconnect INTEGER NOT NULL DEFAULT 0, -- the app refused a refresh: the owner has to connect it again
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT                          -- disconnected: the tokens are gone from here
);
-- one live connection per owner and app
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_connections_live ON app_connections(owner_wallet, app_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_app_connections_owner ON app_connections(owner_wallet, created_at);

-- A sign-in with an app that has started and not come back yet. Used once, gone after ten minutes.
CREATE TABLE IF NOT EXISTS app_oauth_states (
  state_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  app_id TEXT NOT NULL,
  verifier_enc TEXT NOT NULL,              -- the PKCE code verifier, sealed
  browser_hash TEXT NOT NULL,              -- sha256 of the cookie the browser that started it holds
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_oauth_states_expires ON app_oauth_states(expires_at);

-- What one agent may do in one of its owner's apps. No row: read and write a draft, nothing more.
CREATE TABLE IF NOT EXISTS app_permissions (
  owner_wallet TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  actions TEXT NOT NULL,                   -- comma separated: read, draft, publish; empty for nothing at all
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_wallet, agent_id, app_id)
);

-- Something an agent wants to publish or send, waiting for the owner. Nothing goes out without status approved,
-- and an approval is carried out at most once (status used).
CREATE TABLE IF NOT EXISTS app_approvals (
  approval_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,                   -- the job it is for; every decision is on that job's receipt
  app_id TEXT NOT NULL,
  action TEXT NOT NULL,                    -- publish (send counts as publish)
  title TEXT NOT NULL,                     -- one line: what it is
  preview TEXT NOT NULL,                   -- what the owner reads before saying yes
  payload TEXT NOT NULL,                   -- what will be sent, exactly; the preview is made from it
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, declined, expired, cancelled, used
  decided_by TEXT,                         -- the owner's wallet, or "expiry" / "disconnect"
  decided_at TEXT,
  expires_at TEXT NOT NULL,                -- 24 hours after it was asked
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_approvals_owner ON app_approvals(owner_wallet, status, created_at);
CREATE INDEX IF NOT EXISTS idx_app_approvals_task ON app_approvals(task_id);
CREATE INDEX IF NOT EXISTS idx_app_approvals_pending ON app_approvals(status, expires_at);
