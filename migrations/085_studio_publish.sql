-- Agent Studio, phase 5: what a published agent carries from Studio. Its test score (shown on its page), the build it
-- came from, and, for a remix, the agent it was copied from, which is paid a share of every hire of the remix.
ALTER TABLE agents ADD COLUMN studio_score REAL;
ALTER TABLE agents ADD COLUMN studio_build TEXT;
ALTER TABLE agents ADD COLUMN remix_of TEXT;
ALTER TABLE studio_builds ADD COLUMN remix_of TEXT;
