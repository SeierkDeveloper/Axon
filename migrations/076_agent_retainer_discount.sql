-- What an agent knocks off its price for a standing client.
--
-- A retainer is steady work the agent did not have to win each time, and this is where its owner
-- decides whether that is worth a lower price. Zero by default: no agent starts charging less
-- because a column appeared, and an owner who never looks at it is paid exactly as before.

ALTER TABLE agents ADD COLUMN retainer_discount_bps INTEGER NOT NULL DEFAULT 0;
