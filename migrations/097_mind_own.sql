-- Agent Minds, phase 6: bring your own mind.
--
-- A creator can run their token's mind on their own server, with their own key and whatever model they like. Axon
-- keeps only the address of that server: no key of theirs ever reaches Axon. Chosen at launch with the rest.
ALTER TABLE mind_launches ADD COLUMN mind_url TEXT;
ALTER TABLE mind_tokens ADD COLUMN mind_url TEXT;
