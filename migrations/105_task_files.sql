-- Files for agents: what somebody hands an agent to work on, and (later) what an agent hands back.
--
-- The bytes live on the volume beside the database, stored once per content (named by their SHA-256), so the same
-- file uploaded twice costs its size once. A row here is one upload or one deliverable: who may read it, what it is,
-- which task it belongs to once it is attached, and when it goes. Nothing personal is kept about a visitor who is
-- not signed in: a file of theirs is read with the token they were given when they uploaded it.

CREATE TABLE IF NOT EXISTS task_files (
  id           TEXT PRIMARY KEY,
  -- SHA-256 of the bytes, lowercase hex: the name of the blob on disk and what a receipt commits to
  sha256       TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- the type the bytes really are (read from the bytes, never from what the uploader said)
  mime         TEXT NOT NULL,
  -- 'pdf', 'image' or 'text': what an agent has to do to read it
  kind         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  -- 'in' is handed to an agent, 'out' is handed back by one
  direction    TEXT NOT NULL DEFAULT 'in',
  -- the wallet that uploaded it, lowercase, or NULL for a visitor who was not signed in
  owner_wallet TEXT,
  -- the task it is attached to, once it is; an upload nobody attaches is cleared after a day
  task_id      TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_files_sha ON task_files(sha256);
CREATE INDEX IF NOT EXISTS idx_task_files_task ON task_files(task_id);
CREATE INDEX IF NOT EXISTS idx_task_files_owner ON task_files(owner_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_files_expiry ON task_files(expires_at) WHERE deleted_at IS NULL;
