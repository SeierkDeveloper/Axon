-- Mylo, phase 0: what Mylo keeps. Conversations and their messages (the owner is a wallet, or a visitor as a hash of
-- their address); what it remembers about a wallet; the notices it leaves a wallet; and the thoughts it says in public.

CREATE TABLE IF NOT EXISTS mylo_conversations (
  id TEXT PRIMARY KEY,
  -- a lowercase wallet, or "guest:<sha256 of the visitor's address>"
  owner TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mylo_conversations_owner ON mylo_conversations(owner, updated_at);

CREATE TABLE IF NOT EXISTS mylo_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  -- user, assistant, tool
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  -- the tool call or the action waiting for a confirmation, as JSON
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mylo_messages_conversation ON mylo_messages(conversation_id, created_at);
-- the day's count of what a speaker sent
CREATE INDEX IF NOT EXISTS mylo_messages_owner ON mylo_messages(owner, role, created_at);

CREATE TABLE IF NOT EXISTS mylo_memory (
  wallet TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (wallet, key)
);

CREATE TABLE IF NOT EXISTS mylo_inbox (
  id TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  -- one notice per event: the same event never lands twice
  dedupe_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mylo_inbox_wallet ON mylo_inbox(wallet, created_at);

CREATE TABLE IF NOT EXISTS mylo_feed (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  link TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mylo_feed_created ON mylo_feed(created_at);
