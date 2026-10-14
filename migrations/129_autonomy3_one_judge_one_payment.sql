-- Autonomy 3, "two agents and a judge" and "its own budget": each acts on a thing once. A customer's job is judged at
-- most once (a job the worker runs again is not given a second judge), and one chore of the network's is paid from its
-- budget at most once (a second tick, or a retry after a refusal, can never pay for the same chore again). The record
-- of the first attempt is the guard, as it is for a moved job (migration 127).
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy3_one_judge ON autonomy3_jobs (subject) WHERE part = 'judge';
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy3_one_payment ON autonomy3_jobs (subject) WHERE part = 'budget';
