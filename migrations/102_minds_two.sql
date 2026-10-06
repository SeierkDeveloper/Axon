-- Agent Minds 2: what a mind keeps between thoughts.
--
-- Until now a mind woke on an event, thought once, and remembered only its last few thoughts. These tables give it
-- what it needs to work to a plan: a history of its token's numbers to see change in, a plan it writes and revises,
-- orders it arms ahead of time, promises it makes in public, what became of each move an hour later, a report it
-- writes once a day, and a note from its creator. None of it changes what a mind may do or its limits: those were
-- locked at launch in its treasury's contract and every move still passes the same rule check.

-- The token's numbers over time, sampled every few minutes. Everything that looks at change reads this: what the
-- mind is told moved in the last hour, the condition of a standing order, and what a move was followed by.
CREATE TABLE IF NOT EXISTS mind_history (
  token      TEXT NOT NULL,
  at         TEXT NOT NULL,
  mcap_eth   REAL,
  price_eth  REAL,
  holders    INTEGER NOT NULL DEFAULT 0,
  -- what the ten largest holders own, in hundredths of a percent of everything held by holders
  top10_bps  INTEGER,
  -- running totals as the chain had them, so a difference between two rows is what happened in between
  fees_eth      REAL NOT NULL DEFAULT 0,
  burned_tokens REAL NOT NULL DEFAULT 0,
  treasury_eth  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (token, at)
);

-- Where a thought came from: 'event' (something happened to the token), 'pulse' (a quiet mind checking in), 'order'
-- (a standing order's condition was met; no model was called) or 'report' (its daily report).
ALTER TABLE mind_thoughts ADD COLUMN source TEXT NOT NULL DEFAULT 'event';

-- The plan a mind works to: one per token, rewritten by the mind when it revises it. `plan` is what it wrote, as
-- JSON: its mission, the goal it measures itself by, how it means to split its treasury, and the reserve it will not
-- spend below. The reserve is enforced by the rule check, not by the mind's good intentions.
CREATE TABLE IF NOT EXISTS mind_plans (
  token       TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,
  reserve_eth REAL NOT NULL DEFAULT 0,
  thought_id  INTEGER,
  set_at      TEXT NOT NULL,
  revisions   INTEGER NOT NULL DEFAULT 0
);
-- Every version of it, so a holder can read how the plan changed and when.
CREATE TABLE IF NOT EXISTS mind_plan_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL,
  plan       TEXT NOT NULL,
  thought_id INTEGER,
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_plan_log_token ON mind_plan_log(token, id DESC);

-- A standing order: WHEN a condition holds, THEN one action, set by the mind ahead of time. When it fires it becomes
-- an ordinary proposal and goes through the rule check and the treasury's limits like any other.
-- `promise` marks one the mind made in public with a deadline: its amount is held back from other spending while it
-- is armed, so a promise can be kept when its moment comes.
CREATE TABLE IF NOT EXISTS mind_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT NOT NULL,
  -- the thought that set it
  thought_id  INTEGER,
  when_kind   TEXT NOT NULL,
  when_value  REAL NOT NULL,
  -- what the measure stood at when the order was armed, for conditions that compare with a starting point
  when_base   REAL,
  then_kind   TEXT NOT NULL,
  then_eth    REAL NOT NULL,
  promise     INTEGER NOT NULL DEFAULT 0,
  -- its own words for it, shown on the page
  said        TEXT,
  -- 'armed', 'fired' (its condition was met and a proposal was written), 'kept' (that proposal was carried out on
  -- chain), 'missed' (met, but it could not be carried out), 'lapsed' (its time ran out unmet) or 'cancelled'
  status      TEXT NOT NULL DEFAULT 'armed',
  expires_at  TEXT,
  created_at  TEXT NOT NULL,
  fired_at    TEXT,
  -- the proposal it became
  fired_thought_id INTEGER,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mind_orders_token ON mind_orders(token, status, id DESC);

-- What a move was followed by: the token's numbers when it was made and an hour later, and the lesson the mind wrote
-- once it had seen both. One row per action that was carried out.
CREATE TABLE IF NOT EXISTS mind_outcomes (
  action_id      INTEGER PRIMARY KEY,
  token          TEXT NOT NULL,
  kind           TEXT NOT NULL,
  eth            REAL NOT NULL,
  at             TEXT NOT NULL,
  mcap_before    REAL,
  holders_before INTEGER,
  mcap_after     REAL,
  holders_after  INTEGER,
  measured_at    TEXT,
  lesson         TEXT,
  lesson_thought_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mind_outcomes_token ON mind_outcomes(token, action_id DESC);

-- A mind's report to its creator and holders: one a day at most.
CREATE TABLE IF NOT EXISTS mind_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token      TEXT NOT NULL,
  -- the UTC day it reports on
  day        TEXT NOT NULL,
  text       TEXT NOT NULL,
  thought_id INTEGER,
  at         TEXT NOT NULL,
  UNIQUE (token, day)
);

-- The creator's brief: a short public note on what the mind should care about. It steers priorities and nothing
-- else; a brief cannot widen what the mind may do or raise a limit.
CREATE TABLE IF NOT EXISTS mind_briefs (
  token   TEXT PRIMARY KEY,
  text    TEXT NOT NULL,
  set_by  TEXT NOT NULL,
  set_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mind_brief_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  token   TEXT NOT NULL,
  text    TEXT NOT NULL,
  set_by  TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mind_brief_log_token ON mind_brief_log(token, id DESC);
