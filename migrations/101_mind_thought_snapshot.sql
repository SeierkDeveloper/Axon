-- Agent Minds: what a mind saw when it thought.
--
-- The market cap and the holder count at the moment of each thought, so the next thought can be told how both have
-- moved since. Empty for thoughts written before this.
ALTER TABLE mind_thoughts ADD COLUMN mcap_eth REAL;
ALTER TABLE mind_thoughts ADD COLUMN holders INTEGER;
