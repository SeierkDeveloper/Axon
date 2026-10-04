-- Mylo, phase 3: proposals that aren't hires. A build (the sentence, then the Studio build it started and how far it
-- has got) and a publish (which build, at what price). Hires keep their agents in `hires`; these keep theirs here.
ALTER TABLE mylo_actions ADD COLUMN detail TEXT;
