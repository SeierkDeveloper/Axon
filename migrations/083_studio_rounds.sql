-- Agent Studio, phase 3: a build's test rounds. Each round is one version of the instructions, run on the same test
-- tasks and graded; the best round's instructions become the draft. Results are written as each answer is graded, so the
-- Studio page can show the build working. Its owner's alone until the agent is published.

CREATE TABLE IF NOT EXISTS studio_rounds (
  build_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  -- [{ task, lookFor, answer, score, feedback }], filled in as each answer is graded
  results TEXT NOT NULL,
  score REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (build_id, round)
);

ALTER TABLE studio_builds ADD COLUMN tasks TEXT;
