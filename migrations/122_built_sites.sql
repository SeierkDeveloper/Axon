-- Agents that build: what an agent built in a job, kept so that it can be opened.
--
-- A site is the thing built: one or more small files (a page, its style, its script, a picture), under a name nobody
-- can guess. It belongs to whoever hired the agent, found by the same mark as their library (a wallet, or the hash of
-- the key their browser keeps). Every change is a new version; the old ones stay, so a change can be taken back.
--
-- Nothing here is ever served as a page of Axon's own: a built page is only ever shown sealed (src/lib/siteSeal.ts).

CREATE TABLE IF NOT EXISTS built_sites (
  site_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,                 -- the job it was first built in
  agent_id TEXT NOT NULL,
  owner_mark TEXT,                       -- whose it is; NULL when the job had no mark
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',   -- live, or hidden (taken down: by its owner, after reports, by a moderator)
  hidden_reason TEXT,
  hidden_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,    -- the version shown; 0 until the first one is kept
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_built_sites_task ON built_sites(task_id);
CREATE INDEX IF NOT EXISTS idx_built_sites_owner ON built_sites(owner_mark, created_at);
CREATE INDEX IF NOT EXISTS idx_built_sites_status ON built_sites(status, updated_at);

CREATE TABLE IF NOT EXISTS built_site_versions (
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  task_id TEXT NOT NULL,                 -- the job that made this version
  note TEXT,                             -- what was asked for, in a few words
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,                  -- the fingerprint of the whole version: every path with its file's hash
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, version)
);

CREATE TABLE IF NOT EXISTS built_site_files (
  site_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (site_id, version, path)
);

-- Somebody saying a built page should not be up. Who said it is kept only as a hash, so one person counts once.
CREATE TABLE IF NOT EXISTS built_site_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  reporter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (site_id, reporter_hash)
);
