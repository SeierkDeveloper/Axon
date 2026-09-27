// Retainers: the decisions every other part of the feature reads.
//
// A retainer is a standing hire: "run this agent every morning at eight", "check my wallet every four
// hours", "a report every Monday". Its owner sets it up once; Axon hires the agent on schedule and pays
// from the owner's allowance. Until now every hire was one-off, and anything recurring meant the owner
// coming back to do it again.
//
// Nothing new holds money. Every run is an ordinary allowance hire, so the contract's per-task and
// per-day limits apply to it, failed work is released back automatically, and the owner can withdraw or
// pause the allowance at any time. A retainer is only a schedule that decides when to ask.
//
// Paid agents only. A free-lane hire costs Axon the inference and nothing pays for it, so a schedule
// on a free agent would be an open-ended bill with nobody on the other side of it.

import { DEFAULT_MAX_PER_TASK_WEI } from "./allowancePolicy";
import type { TierName } from "./holderTier";

// ── Schedules ─────────────────────────────────────────────────────────────────

/** Every N hours, counted from when the retainer was created. */
export interface IntervalSchedule {
  kind: "interval";
  everyHours: number;
}

/** Once a day at a wall-clock time, in the owner's time zone ("08:00" means eight in their morning). */
export interface DailySchedule {
  kind: "daily";
  time: string;
  timeZone: string;
}

/** Once a week, on a day (0 Sunday to 6 Saturday) at a wall-clock time in the owner's time zone. */
export interface WeeklySchedule {
  kind: "weekly";
  day: number;
  time: string;
  timeZone: string;
}

export type Schedule = IntervalSchedule | DailySchedule | WeeklySchedule;

/**
 * The intervals on offer. Hourly is the fastest anything runs: a retainer is for work that recurs, and
 * faster than that is a bot, not a schedule. 24 is left to "daily", which also fixes the time of day.
 */
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether the runtime knows a time zone. Intl throws on a name it does not recognise. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Why a schedule cannot be used, or null when it can. */
export function scheduleError(s: unknown): string | null {
  if (!s || typeof s !== "object") return "A schedule is needed";
  const sch = s as Partial<Schedule> & Record<string, unknown>;
  switch (sch.kind) {
    case "interval":
      return (INTERVAL_HOURS as readonly number[]).includes(sch.everyHours as number)
        ? null
        : `Run every ${INTERVAL_HOURS.join(", ")} hours`;
    case "daily":
    case "weekly":
      if (typeof sch.time !== "string" || !TIME_RE.test(sch.time)) return "The time must look like 08:00";
      if (!validTimeZone(sch.timeZone)) return "Unknown time zone";
      if (sch.kind === "weekly" && !(Number.isInteger(sch.day) && (sch.day as number) >= 0 && (sch.day as number) <= 6)) {
        return "The day must be 0 (Sunday) to 6 (Saturday)";
      }
      return null;
    default:
      return "The schedule must be interval, daily or weekly";
  }
}

/** How often a schedule runs, in hours between runs. What tiers and projections compare. */
export function hoursBetweenRuns(s: Schedule): number {
  return s.kind === "interval" ? s.everyHours : s.kind === "daily" ? 24 : 24 * 7;
}

/** Runs in a day, on average. A weekly schedule is a seventh of one. */
export const runsPerDay = (s: Schedule): number => 24 / hoursBetweenRuns(s);

/**
 * The most a schedule can spend in a UTC day at its maximum price. Shown before it is created, and
 * compared with the allowance's daily limit: a schedule that cannot fit is refused run by run, so the
 * owner is told up front rather than finding a trail of skipped runs.
 *
 * Rounded up to whole runs, since the allowance's day is a calendar day and a schedule can land more
 * runs in one than its average suggests.
 */
export function maxDailySpendWei(s: Schedule, maxPriceWei: bigint): bigint {
  return BigInt(Math.ceil(runsPerDay(s))) * maxPriceWei;
}

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * What each holder tier may run. Retainers are new, so nobody loses anything they had (tiers only ever
 * add). The count and the pace are where holding pays: a holder's wallet can be checked hourly, a base
 * wallet every four hours. Neither costs Axon anything, because the owner pays for every run.
 */
export const RETAINERS_BY_TIER: Record<TierName, { active: number; fastestHours: number }> = {
  base: { active: 3, fastestHours: 4 },
  holder: { active: 10, fastestHours: 1 },
  builder: { active: 25, fastestHours: 1 },
  operator: { active: 100, fastestHours: 1 },
};

/** Instructions are the task each run sends, so they share the task limit. */
export const MAX_INSTRUCTIONS = 32_000;
export const MAX_DURATION_DAYS = 365;
export const MAX_RUNS = 10_000;

/**
 * Failures in a row before a retainer pauses itself. A run the agent failed or the allowance refused
 * both count: three in a row means something is wrong that another run will not fix, and every
 * refused attempt is still noise in the owner's history.
 */
export const FAILURES_BEFORE_PAUSE = 3;

/**
 * The default ceiling on a run's price: a quarter above the agent's price when the retainer is made.
 *
 * Agents price dynamically, so a run can come up dearer than the first. Some room stops every small
 * move from skipping a run; a fixed ceiling stops a price spike from draining the allowance. It never
 * defaults above the allowance's per-task default, which would be refused anyway.
 */
export function defaultMaxPriceWei(priceWei: bigint): bigint {
  const withRoom = (priceWei * 125n + 99n) / 100n;
  const ceiling = withRoom < DEFAULT_MAX_PER_TASK_WEI ? withRoom : DEFAULT_MAX_PER_TASK_WEI;
  return ceiling > priceWei ? ceiling : priceWei;
}

// ── The agent's retainer discount ──────────────────────────────────────────

/**
 * The most an agent may knock off for a standing client, in basis points. The same ceiling as the
 * $AXON discount, and for the same reason: one zero out in basis points turns a discount into giving
 * the work away. The two stack, because they are different things: one is for the steady work, the
 * other for being paid in the token.
 */
export const MAX_RETAINER_DISCOUNT_BPS = 5_000;

/** An agent's retainer discount setting, or zero when it is out of range rather than the nearest legal one. */
export function clampRetainerDiscount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RETAINER_DISCOUNT_BPS) return 0;
  return n;
}

/** What one retainer run costs in ETH wei: the agent's price less its retainer discount, rounded up. */
export function retainerPriceWei(priceWei: bigint, discountBps: number): bigint {
  const bps = BigInt(clampRetainerDiscount(discountBps));
  const off = (priceWei * bps) / 10_000n;
  return priceWei - off;
}

// ── States ────────────────────────────────────────────────────────────────────

export type RetainerStatus = "active" | "paused" | "ended" | "cancelled";

/**
 * Why a retainer is paused. The owner can resume from any of them once the cause is fixed; the reason
 * says what to fix. "key_revoked": the allowance key that created it was revoked, so it stops at once
 * rather than failing its way to a pause.
 */
export type PauseReason = "owner" | "failures" | "agent_unavailable" | "key_revoked" | "key_expired" | "allowance_expired";

export const PAUSE_REASON_TEXT: Record<PauseReason, string> = {
  owner: "Paused by you",
  failures: `Paused after ${FAILURES_BEFORE_PAUSE} failed runs in a row`,
  agent_unavailable: "Paused because the agent stopped answering",
  key_revoked: "Paused because the key that created it was revoked",
  key_expired: "Paused because the key that created it expired. Resume it to keep it going on your own allowance",
  allowance_expired: "Paused because your allowance expired. Extend it, then resume",
};

export type RunOutcome = "completed" | "failed" | "skipped";

/** Why a scheduled run did not happen. Each is shown to the owner as written. */
export type SkipReason =
  | "price_above_max" // the agent's price rose past the retainer's ceiling
  | "previous_run_in_flight" // the last run has not finished; runs never overlap
  | "allowance_refused" // over the allowance's limits, paused, expired, or empty
  | "agent_unavailable" // the agent was removed or cannot take work
  | "missed" // an earlier slot passed while Axon was down; only the latest missed slot runs
  | "tier_pace" // the owner's tier dropped below this schedule's speed; it runs at the tier's pace
  | "payment_unavailable"; // Axon could not take the payment just then (its own side); never the owner's fault

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  price_above_max: "The agent's price is above this retainer's maximum",
  previous_run_in_flight: "The previous run was still working",
  allowance_refused: "Your allowance refused the payment",
  agent_unavailable: "The agent is not available",
  missed: "Axon was unavailable at this time; the next due run went ahead instead",
  payment_unavailable: "Axon could not take the payment at that moment. Nothing was charged",
  tier_pace: `Your tier runs a retainer every ${RETAINERS_BY_TIER.base.fastestHours} hours at most; holding $AXON again brings back hourly`,
};

/**
 * Whether a slot may run at the owner's tier as it is now.
 *
 * The tier is checked when a retainer is made or changed, but a balance moves: a holder who sets up an
 * hourly retainer and then sells keeps the retainer, and it carries on at the pace the new tier allows,
 * running a slot only once that much time has passed since the last run that was hired. Nothing is
 * cancelled or paused, and buying back restores the schedule as written at the next slot. The count of
 * retainers is not taken back either: selling blocks new ones until the wallet is under its limit.
 */
export function tierPaceAllows(schedule: Schedule, tier: TierName, lastHiredMs: number | null, slotMs: number): boolean {
  const fastest = RETAINERS_BY_TIER[tier].fastestHours;
  if (hoursBetweenRuns(schedule) >= fastest || lastHiredMs === null) return true;
  // The on-time window is slack, so a run that started a few minutes late does not push the next one out.
  return slotMs - lastHiredMs >= fastest * 3_600_000 - ON_TIME_WINDOW_MS;
}

/**
 * How late a run may start and still count as on time. Past it, a slot is "missed": after downtime
 * only the most recent due slot runs, never a backlog, so an owner is not billed for eight runs at
 * once when the worker comes back.
 */
export const ON_TIME_WINDOW_MS = 15 * 60 * 1000;

// ── Creating one ──────────────────────────────────────────────────────────────

export type PayIn = "ETH" | "AXON";

export interface RetainerInput {
  agentId: string;
  instructions: string;
  schedule: Schedule;
  payIn: PayIn;
  maxPriceWei: bigint;
  /** Unix ms. Optional; without it the retainer runs until cancelled or the allowance stops paying. */
  endsAt?: number | null;
  maxRuns?: number | null;
}

/** What the input is checked against, gathered by the caller from the agent, the wallet and the clock. */
export interface RetainerContext {
  /** The agent's current price in wei, or null for a free agent. */
  agentPriceWei: bigint | null;
  agentAcceptsAxon: boolean;
  tier: TierName;
  activeRetainers: number;
  nowMs: number;
}

/** Why a retainer cannot be created, or null when it can. Written to be shown as is. */
export function retainerInputError(input: RetainerInput, ctx: RetainerContext): string | null {
  if (!input.agentId) return "Choose an agent";
  if (ctx.agentPriceWei === null || ctx.agentPriceWei <= 0n) return "Retainers are for paid agents";
  const instructions = input.instructions?.trim() ?? "";
  if (!instructions) return "Write what the agent should do each run";
  if (instructions.length > MAX_INSTRUCTIONS) return `Instructions must be ${MAX_INSTRUCTIONS.toLocaleString("en-US")} characters or fewer`;

  const scheduleProblem = scheduleError(input.schedule);
  if (scheduleProblem) return scheduleProblem;
  const limits = RETAINERS_BY_TIER[ctx.tier];
  if (hoursBetweenRuns(input.schedule) < limits.fastestHours) {
    return `Your tier can run a retainer every ${limits.fastestHours} hours at most; holding $AXON allows hourly`;
  }
  if (ctx.activeRetainers >= limits.active) {
    // Paused ones count, so the way to make room without holding more is to cancel one.
    return `Your tier can have ${limits.active} retainers at once, paused ones included; cancel one or hold more $AXON for more`;
  }

  if (input.payIn !== "ETH" && input.payIn !== "AXON") return "Pay in ETH or $AXON";
  if (input.payIn === "AXON" && !ctx.agentAcceptsAxon) return "This agent does not take $AXON";

  if (input.maxPriceWei < ctx.agentPriceWei) return "The maximum price cannot be below the agent's current price";
  if (input.maxPriceWei > 10n ** 18n) return "The maximum price is over 1 ETH per run";

  if (input.endsAt != null) {
    if (!Number.isFinite(input.endsAt) || input.endsAt <= ctx.nowMs) return "The end date must be in the future";
    if (input.endsAt > ctx.nowMs + MAX_DURATION_DAYS * 86_400_000) return `A retainer can run for up to ${MAX_DURATION_DAYS} days`;
  }
  if (input.maxRuns != null && !(Number.isInteger(input.maxRuns) && input.maxRuns >= 1 && input.maxRuns <= MAX_RUNS)) {
    return `The number of runs must be 1 to ${MAX_RUNS.toLocaleString("en-US")}`;
  }
  return null;
}
