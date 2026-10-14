-- Autonomy 3, "no job dies": a failed job is moved to another agent at most once. The record of that move is the
-- guard: a second attempt (from the worker and from the tick at the same moment) cannot be written twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy3_one_rescue ON autonomy3_jobs (subject) WHERE part = 'rescue';
