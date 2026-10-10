-- Work with your agent: your library.
--
-- Who hired a job, for somebody who hires without signing in: the same mark their memory with agents hangs on (a
-- wallet, or the hash of a key their browser keeps). With it a person's conversations, files and versions can be
-- listed back to them, on any agent, and a conversation can be picked up again. Kept on the job and not in its
-- context: it is nobody's business but the hirer's. Empty for every job before this, and for a job hired with
-- neither a wallet nor a key.
ALTER TABLE tasks ADD COLUMN library_owner TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_library_owner ON tasks(library_owner, created_at) WHERE library_owner IS NOT NULL;
