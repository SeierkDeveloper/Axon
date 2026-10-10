-- Work with your agent: plan first.
--
-- A job hired with "plan first" stops before any work: the agent writes its plan, and the person approves it, asks
-- for a change, or cancels. A plan waits for the person exactly as a question does, so it is kept beside the
-- questions: `kind` says which a row is. For a plan, `question` holds the plan, `answer` the change that was asked
-- for, and `answered_how` what became of it: approved, changed, cancelled, or timeout (nobody answered, and the job
-- went on with the plan as written).
ALTER TABLE task_questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'question';
