// Autonomy, the third update: the decisions every part of it reads.
//
// Autonomy 2 made the network run itself: it checks every hour and tidies what it finds. This update makes the
// network grow, improve and defend itself. It gives itself work: it tests every agent, tries to break them, makes
// them better and proves it, builds the agents that are missing, and moves a failed job to another agent.
//
// The rules live here, in one place:
//   - every part has its own switch and all of them start off, so merging this changes nothing until a part is
//     turned on (AUTONOMY3=on, then AUTONOMY3_<PART>=on)
//   - the parts that cost model calls run a fixed number of jobs a day, spread over the day. That number is a pace,
//     not a cap that stops anything: there is no budget that can run out and switch the network's upkeep off.
//     Tomorrow's jobs always come. The parts that cost nothing have no number at all
//   - it keeps to what Autonomy 2 never touches (autonomyPolicy.NEVER_TOUCHES)

type Env = Record<string, string | undefined>;

export type Part = "rescue" | "watch" | "react" | "test" | "attack" | "replay" | "improve" | "build" | "upkeep" | "judge" | "budget";

/** The parts, in the order they are built and shown. `spends` marks the ones that make model calls of their own. */
export const PARTS: Record<Part, { name: string; does: string; spends: boolean }> = {
  rescue: { name: "No job dies", does: "a failed job goes to the next best agent instead of being failed and refunded", spends: false },
  watch: { name: "Watches everything", does: "built pages, triggers and browser jobs come into the check", spends: false },
  react: { name: "Reacts in minutes", does: "a failure is picked up within minutes, not at the next hourly pass", spends: false },
  test: { name: "Tests every agent", does: "small real test jobs, graded, and a new agent before customers meet it", spends: true },
  attack: { name: "Attacks its own agents", does: "tricks, hidden instructions, leaks and overspending; an agent that falls is pulled", spends: true },
  replay: { name: "Tries changes on yesterday's jobs", does: "a change is checked against recorded real jobs before it goes in", spends: false },
  improve: { name: "Makes agents better and proves it", does: "a new version stays only if it beats the old one on the same jobs", spends: true },
  build: { name: "Builds the agents that are missing", does: "from the list of gaps; listed only if it passes the tests", spends: true },
  upkeep: { name: "Hires its own agents", does: "the network's chores are done by Axon agents, each with a receipt", spends: true },
  judge: { name: "Two agents and a judge", does: "on a big job two agents work, a third picks the better result, the customer pays once", spends: true },
  budget: { name: "Its own budget", does: "the network pays for its own work from a budget on chain", spends: false },
};

export const PART_ORDER = Object.keys(PARTS) as Part[];

const on = (v: string | undefined): boolean => (v ?? "").trim().toLowerCase() === "on";

/** The switch a part is turned on with. */
export const partSwitch = (part: Part): string => `AUTONOMY3_${part.toUpperCase()}`;

/** The update as a whole. Off unless AUTONOMY3=on. */
export function autonomy3On(env: Env = process.env): boolean {
  return on(env.AUTONOMY3);
}

/** One part: on only when the update is on and the part's own switch is. */
export function partOn(part: Part, env: Env = process.env): boolean {
  return autonomy3On(env) && on(env[partSwitch(part)]);
}

// ── The fixed number of jobs a day ────────────────────────────────────────────

/**
 * How many jobs a day each spending part starts. Counted on 136 agents: every agent tested every three days, each
 * attacked about once a week, two improvement attempts, one new agent every other day. With more agents each waits
 * a little longer for its turn; nothing stops.
 *
 * The judge is the one part whose jobs come from customers, not from the tick: a job that asked for two agents, or a
 * big paid one. Three a day is what fits under the day's ceiling (worstDayUsd, about $2.20) next to the other parts at
 * the judge's honest token limit below. Past the day's three, a job is done by its hired agent alone, as before.
 */
export const JOBS_A_DAY: Partial<Record<Part, number>> = {
  test: 45,
  attack: 20,
  improve: 2,
  build: 0.5,
  upkeep: 4,
  judge: 3,
};

/**
 * A part's number for the day, or null when it has none (it costs nothing and runs whenever there is work).
 * AUTONOMY3_<PART>_A_DAY changes it without a deploy. A value that is not a number above zero is ignored: the
 * number sets a pace and cannot be used to stop a part, the part's switch does that.
 */
export function jobsADay(part: Part, env: Env = process.env): number | null {
  const base = JOBS_A_DAY[part];
  if (base === undefined) return null;
  const raw = Number(env[`${partSwitch(part)}_A_DAY`]);
  return Number.isFinite(raw) && raw > 0 ? raw : base;
}

const DAY = 86_400_000;

/**
 * The stretch of time a part's jobs are counted over, and how many it starts in it. A day for most; a part with
 * less than one job a day counts over as many days as one job takes (one every other day: two days, one job).
 */
export function paceWindow(perDay: number, nowMs: number): { from: number; to: number; jobs: number } {
  const days = Math.max(1, Math.ceil(1 / perDay));
  const span = days * DAY;
  const from = Math.floor(nowMs / span) * span;
  return { from, to: from + span, jobs: Math.max(1, Math.round(perDay * days)) };
}

/**
 * How many of the window's jobs may have started by now: they are spread evenly over it, the first one right at
 * the start. At the end of the window all of them, never more.
 */
export function dueByNow(perDay: number, nowMs: number): number {
  const w = paceWindow(perDay, nowMs);
  const share = (nowMs - w.from) / (w.to - w.from);
  return Math.min(w.jobs, Math.floor(w.jobs * share) + 1);
}

/** Whether a part may start one more job now, given how many it has started in its window. */
export function hasTurn(part: Part, startedInWindow: number, nowMs: number, env: Env = process.env): boolean {
  if (!partOn(part, env)) return false;
  const perDay = jobsADay(part, env);
  if (perDay === null) return true;
  return startedInWindow < dueByNow(perDay, nowMs);
}

// ── What a job may cost ───────────────────────────────────────────────────────

/**
 * The most tokens one job of a part may use, in and out. This is what bounds a day: the fixed number of jobs times
 * these. A job that would need more is cut short and recorded as such; the next one still runs.
 */
export const JOB_TOKENS: Partial<Record<Part, { in: number; out: number }>> = {
  test: { in: 3_000, out: 800 },
  attack: { in: 3_000, out: 800 },
  improve: { in: 30_000, out: 6_000 },
  build: { in: 50_000, out: 10_000 },
  upkeep: { in: 8_000, out: 2_000 },
  // the second agent's answer and two grades: the job read three times, two answers read once each
  judge: { in: 6_000, out: 1_100 },
};

/** Dollars per million tokens used to estimate what a job cost. An estimate for the admin page, not a bill. */
export const USD_PER_MTOK = { in: 3, out: 15 } as const;

function estimateUsd(tokensIn: number, tokensOut: number): number {
  return (Math.max(0, tokensIn) * USD_PER_MTOK.in + Math.max(0, tokensOut) * USD_PER_MTOK.out) / 1_000_000;
}

/** The most a day can cost when every part is on: each part's jobs at its full token limit. */
export function worstDayUsd(env: Env = process.env): number {
  let usd = 0;
  for (const part of PART_ORDER) {
    const perDay = jobsADay(part, env), t = JOB_TOKENS[part];
    if (perDay !== null && t) usd += perDay * estimateUsd(t.in, t.out);
  }
  return usd;
}
