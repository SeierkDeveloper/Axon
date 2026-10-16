-- Agents that work in your apps: the work itself.
--
-- Whose apps a job may use: the wallet that hired it, when the hire said who that is with a key (a hire made through
-- an assistant, Mylo or the SDK with the owner's key, or on an agent's page by somebody signed in on that browser).
-- Kept on the job, never in its context. Empty for every job before this and for a hire made without a key, and then
-- a job hired by a wallet itself (a schedule, a trigger) uses that wallet's apps.
ALTER TABLE tasks ADD COLUMN apps_owner TEXT;

-- Everything an agent did in an app for a job, for the owner to read on the job's receipt: what it read, the drafts it
-- wrote (with their text: the owner's alone, never on the public receipt), what it asked to post and what came of it.
-- The public receipt carries only an "app.action" event with fingerprints.
CREATE TABLE IF NOT EXISTS app_actions (
  action_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,              -- lowercase
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  action TEXT NOT NULL,                    -- read, draft, publish
  summary TEXT NOT NULL,                   -- one line in plain words: "Read 20 messages in #team"
  target TEXT,                             -- where in the app, as the app names it (a channel id)
  target_label TEXT,                       -- the same, for people: "#team"
  body TEXT,                               -- a draft's text; the owner's alone
  approval_id TEXT,                        -- for something that waits for the owner's OK
  status TEXT NOT NULL,                    -- done, failed, draft, waiting, posted, declined, expired, cancelled
  error TEXT,                              -- what went wrong, in plain words
  link TEXT,                               -- where it is in the app once it is there
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_actions_task ON app_actions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_app_actions_approval ON app_actions(approval_id) WHERE approval_id IS NOT NULL;

-- Posting without asking: an owner may let one agent post in one place in an app (one Slack channel) without their
-- OK each time, for jobs that start themselves on a schedule or a trigger. None by default. It only counts while the
-- agent may also publish in that app, and it is removed when the app is disconnected or the agent's permission reset.
CREATE TABLE IF NOT EXISTS app_standing (
  owner_wallet TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  target TEXT NOT NULL,                    -- a channel id
  target_label TEXT NOT NULL,              -- "#team"
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_wallet, agent_id, app_id, target)
);
