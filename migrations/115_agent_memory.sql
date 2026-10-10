-- Work with your agent: it remembers you.
--
-- What an agent keeps about somebody who hired it, to use the next time they do: a preference about how they want
-- work done, or a lasting fact about them or their project. One short line each, written by the agent during a job,
-- shown to the person, and theirs to delete. `owner` is who the memory is about: a wallet ("w:0x...") or, for
-- somebody who hires without signing in, a key their browser keeps, stored here only as its hash ("v:<sha256>").
CREATE TABLE IF NOT EXISTS agent_memories (
  id              TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  text            TEXT NOT NULL,
  source_task_id  TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_owner ON agent_memories(owner, agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_memories_task ON agent_memories(source_task_id) WHERE source_task_id IS NOT NULL;

-- Whose memory a job reads and adds to. Empty for a job hired with no memory, which is every job before this. Kept
-- on the job and not in its context: it is nobody's business but the hirer's.
ALTER TABLE tasks ADD COLUMN memory_owner TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_memory_owner ON tasks(memory_owner, to_agent) WHERE memory_owner IS NOT NULL;
