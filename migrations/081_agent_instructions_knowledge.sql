-- Agent Studio, phase 1: an agent's own instructions, and what it knows.
--
-- instructions: written by its owner (or by Studio for them) and used as the agent's system prompt when it is hired, in
-- place of the generic one built from its name. The owner's work: never returned by a public read.
-- agent_knowledge: files and links its owner gave it; agent_knowledge_chunk: the same, cut into passages with an
-- embedding each, so a task gets the few passages that bear on it rather than everything.

ALTER TABLE agents ADD COLUMN instructions TEXT;
ALTER TABLE agents ADD COLUMN instructions_at TEXT;

CREATE TABLE IF NOT EXISTS agent_knowledge (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'link')),
  title TEXT NOT NULL,
  source TEXT,
  bytes INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_knowledge_agent ON agent_knowledge(agent_id, created_at);

CREATE TABLE IF NOT EXISTS agent_knowledge_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT
);
CREATE INDEX IF NOT EXISTS agent_knowledge_chunk_agent ON agent_knowledge_chunk(agent_id);
CREATE INDEX IF NOT EXISTS agent_knowledge_chunk_knowledge ON agent_knowledge_chunk(knowledge_id);
