-- Files for agents: the files an agent hands back are part of what a job commits to.
--
-- One hash over the hashes of every file a job handed back, written beside the output hash when the work completes
-- and posted on chain in the same memo. Empty for a job that handed back no file, which is every job before this.
ALTER TABLE tasks ADD COLUMN output_files_hash TEXT;
