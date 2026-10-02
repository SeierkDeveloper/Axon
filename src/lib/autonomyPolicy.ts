// Autonomy, the second update: the decisions every other part of it reads.
//
// Until now the network pass looked at the marketplace once a day and changed one thing, the price of agents
// whose owners asked for it. This update makes it run the network: it checks far more, every hour, and acts
// on what it finds, keeping agents reachable, work moving and the code healthy without anyone asking.
//
// The rules that keep that safe live here, in one place, so a check and the action that follows it can never
// disagree about a threshold:
//   - it only ever acts through paths the network already uses and tests: a task is failed or retried the way
//     the worker does it, an agent leaves routing the way a circuit breaker already takes it out
//   - every action is capped per run, and a run that would act on too much of the network at once does nothing
//     and raises an alarm instead: that many failures at once is an outage, not a list of bad agents
//   - some things it never touches, whatever a check finds (NEVER_TOUCHES)
//   - every action can be switched off without a deploy (AUTONOMY_ACTIONS=off), and every pass can run as a
//     dry run that only reports what it would do
//   - what it finds is split by who may see it: upkeep is public, anything about money is not (VISIBILITY)

// ── What it never touches ─────────────────────────────────────────────────────

/** Areas no check may act on, whatever it finds. A finding here is reported to the admin view and left alone. */
export const NEVER_TOUCHES = [
  "payments and payment verification (the one exception: a stuck task it closes is refunded the way the worker refunds one)",
  "sign-in, API keys and allowance keys",
  "receipts and the receipt hash chain",
  "the treasury, the burn pot and the fee splitter",
  "allowance and retainer contracts and balances",
  "an agent's owner, wallet or registration",
] as const;

// ── How often ─────────────────────────────────────────────────────────────────

/** The network pass runs every hour (it was once a day). */
export const NETWORK_PASS_EVERY_MINUTES = 60;

/** Kill switch: with AUTONOMY_ACTIONS=off every pass still checks and reports, and changes nothing. */
export function actionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AUTONOMY_ACTIONS ?? "on").trim().toLowerCase() !== "off";
}

// ── Agents and routing ────────────────────────────────────────────────────────

/**
 * When an agent counts as failing, from its own finished work in the last day. A handful of finished tasks
 * first: one bad answer out of two is noise, not a broken agent.
 */
export const FAILING = {
  windowHours: 24,
  minFinished: 5,
  maxSuccessRate: 0.4,
  /** or this many failures in a row, whatever the rate */
  consecutiveFailures: 3,
} as const;

/** Taken out of routing means not picked by auto-routing, the planner or quorums. It stays listed and hireable by name. */
export const ROUTING_PAUSE = {
  /** most agents paused in one run */
  maxPerRun: 5,
  /** never more than this share of active agents paused at once; past it, the run assumes an outage and stops */
  maxShareOfActive: 0.1,
  /** a paused agent is re-tested this often */
  retestEveryHours: 3,
  /** and goes back into routing after this many passes in a row */
  passesToRestore: 2,
  /** most paused agents re-tested in one run: a hosted agent's test is a small real model call */
  maxRetestsPerRun: 10,
} as const;

/** Slow agents are routed to less, not removed: their weight drops while they are this much slower than peers. */
export const SLOW = {
  minFinished: 10,
  /** median latency over the median of agents with the same capability */
  times: 3,
  routingWeight: 0.25,
} as const;

/** Whether an agent's last day of work makes it failing. */
export function isFailing(s: { finished: number; succeeded: number; failedInARow: number }): boolean {
  if (s.failedInARow >= FAILING.consecutiveFailures) return true;
  if (s.finished < FAILING.minFinished) return false;
  return s.succeeded / s.finished <= FAILING.maxSuccessRate;
}

/**
 * How many more agents a run may pause, given how many are active and already paused. Zero once the share is
 * reached: a run that finds more than that failing at once is looking at an outage, not at bad agents.
 */
export function pauseBudget(active: number, alreadyPaused: number): number {
  const ceiling = Math.floor(active * ROUTING_PAUSE.maxShareOfActive);
  return Math.max(0, Math.min(ROUTING_PAUSE.maxPerRun, ceiling - alreadyPaused));
}

/** Whether this many failing agents at once should be read as an outage, and so acted on not at all. */
export function looksLikeOutage(active: number, failing: number): boolean {
  return active > 0 && failing > Math.floor(active * ROUTING_PAUSE.maxShareOfActive) * 2;
}

// ── Work that stopped moving ──────────────────────────────────────────────────

/** A task is stuck when it has been running or waiting this long. */
export const STUCK = {
  runningMinutes: 15,
  queuedMinutes: 120,
  /** a stuck task is retried once; a second time it is failed, which releases or refunds it the usual way */
  retries: 1,
  maxPerRun: 25,
} as const;

// ── Webhooks ──────────────────────────────────────────────────────────────────

/** A webhook that keeps failing is switched off, probed, and switched back on when its endpoint answers. */
export const WEBHOOKS = {
  failuresToDisable: 20,
  /** and failing for at least this long, so one bad hour does not switch anyone off */
  failingForHours: 6,
  probeEveryHours: 6,
  maxPerRun: 10,
} as const;

// ── Prices and listings ───────────────────────────────────────────────────────

/** Re-pricing, for agents whose owners allow it: at most once a day each, and never a jump. */
export const PRICING = {
  perAgentPerDay: 1,
  maxStepShare: 0.2,
} as const;

/** A price this far from the median of agents with the same capability is reported (admin only), not changed. */
export const PRICE_OUTLIER_TIMES = 10;

/** Descriptions are rewritten when they are this old and the agent's capabilities changed since. Capped: each costs a model call. */
export const DESCRIPTIONS = {
  staleDays: 30,
  maxPerRun: 5,
} as const;

/** Owners are warned this long before an allowance or a retainer's key expires, or when this few runs are left. */
export const OWNER_WARNINGS = {
  daysBeforeExpiry: 7,
  retainerRunsLeft: 3,
} as const;

// ── Money flow (watched, never touched) ───────────────────────────────────────

/** Pages the network pass loads every run, and how long one may take before it counts as slow. */
export const PAGES = {
  paths: ["/", "/agents", "/analytics", "/explorer", "/world", "/burn", "/docs", "/docs/mcp", "/autonomy", "/network-feed"],
  slowMs: 2_000,
  timeoutMs: 15_000,
} as const;

/** Admin alarms on the fee path: fees that stop arriving, and a pot that could burn but has not. */
export const FEE_FLOW = {
  noSplitForHours: 6,
  potUnburnedForHours: 2,
} as const;

// ── Who sees what ─────────────────────────────────────────────────────────────

export type Visibility = "public" | "admin";

/**
 * Where each kind of finding is shown. Public is the network keeping itself healthy: code checks and upkeep,
 * as counts. Anything about money, fee flow, prices or listings stays in the admin view. No task volumes or
 * money figures appear on the public page at all.
 */
export const VISIBILITY = {
  "code-check": "public",
  "page-check": "public",
  "agent-retested": "public",
  "agent-paused": "public",
  "agent-restored": "public",
  "task-freed": "public",
  "webhook-paused": "public",
  "webhook-restored": "public",
  "description-refreshed": "public",
  "price-adjusted": "public",
  "agent-failing": "admin",
  "agent-unreachable": "admin",
  "task-stuck": "admin",
  "webhook-failing": "admin",
  "stale-description": "admin",
  "slow-agent": "admin",
  "agent-reweighted": "admin",
  "price-outlier": "admin",
  "duplicate-listing": "admin",
  "dormant-listing": "admin",
  "capability-gap": "admin",
  "owner-warning": "admin",
  "fee-flow": "admin",
  "payment-mismatch": "admin",
  "outage": "admin",
} as const satisfies Record<string, Visibility>;

export type FindingKind = keyof typeof VISIBILITY;

export const isPublic = (kind: FindingKind): boolean => VISIBILITY[kind] === "public";
