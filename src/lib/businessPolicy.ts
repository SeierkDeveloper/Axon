// Agents that run their own business: the switch and the numbers that hold it.
//
// Nothing here touches the database, so a page or a test can read the rules without opening it. Every number a
// deployment may change is read from the environment and kept inside bounds: a value out of range is ignored and the
// default holds.
//
// AGENT_BUSINESS=on switches it on. Off (the default) no route answers, the worker never looks, and every page and
// agent behaves as it did before.

type Env = Record<string, string | undefined>;

export function businessEnabled(env: Env = process.env): boolean {
  return (env.AGENT_BUSINESS ?? "off").trim().toLowerCase() === "on";
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};

/** What a business may spend on. Taking work and selling spend nothing, so they need no kind. */
export const SPEND_KINDS = ["hire", "material", "model", "people"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];
export const isSpendKind = (v: unknown): v is SpendKind => typeof v === "string" && (SPEND_KINDS as readonly string[]).includes(v);

/**
 * The kinds an owner can pick on this network: hiring people only while tasks for people are switched on
 * (AGENT_PEOPLE), so a business can never be set to spend on something the network does not offer.
 */
export function openSpendKinds(env: Env = process.env): SpendKind[] {
  const peopleOn = (env.AGENT_PEOPLE ?? "off").trim().toLowerCase() === "on";
  return SPEND_KINDS.filter((k) => k !== "people" || peopleOn);
}

/** The words for each, as an owner reads them. */
export const SPEND_WORDS: Record<SpendKind, string> = {
  hire: "Hire other agents for parts of a job",
  material: "Buy other agents' products as material",
  model: "Move to a stronger model when it pays its way",
  people: "Hire people for what only a person can do",
};

export interface BusinessCaps {
  /** minutes between two looks at the network for one business */
  scanMinutes: number;
  /** the most bids one business may place in an hour, whatever its owner sets */
  bidsPerHourMax: number;
  /** the cheap model checks every business together may make in a UTC day: each one is a model call Axon pays for */
  checksPerDay: number;
  /** checks one business may make in one look; what is left waits for the next look */
  checksPerScan: number;
  /** businesses one wallet may have running or paused at once */
  perWallet: number;
  /** the most an owner may give a business to spend in total, in ETH */
  budgetMaxEth: number;
  /** minutes a hire inside a job waits for the owner's OK before the job goes on without it */
  approvalWaitMinutes: number;
  /** the model that checks whether a job fits, and the one that writes the daily report */
  checkModel: string;
  reportModel: string;
}

export function businessCaps(env: Env = process.env): BusinessCaps {
  const budgetMax = Number(env.AGENT_BUSINESS_BUDGET_MAX_ETH);
  return {
    scanMinutes: num(env.AGENT_BUSINESS_SCAN_MINUTES, 15, 1, 24 * 60),
    bidsPerHourMax: num(env.AGENT_BUSINESS_BIDS_PER_HOUR, 5, 1, 60),
    checksPerDay: num(env.AGENT_BUSINESS_CHECKS_PER_DAY, 200, 0, 20_000),
    checksPerScan: num(env.AGENT_BUSINESS_CHECKS_PER_SCAN, 4, 1, 50),
    perWallet: num(env.AGENT_BUSINESS_PER_WALLET, 3, 1, 50),
    budgetMaxEth: Number.isFinite(budgetMax) && budgetMax > 0 && budgetMax <= 100 ? budgetMax : 1,
    approvalWaitMinutes: num(env.AGENT_BUSINESS_APPROVAL_WAIT_MIN, 10, 1, 60),
    checkModel: env.AGENT_BUSINESS_CHECK_MODEL?.trim() || "claude-haiku-4-5",
    reportModel: env.AGENT_BUSINESS_REPORT_MODEL?.trim() || "claude-haiku-4-5",
  };
}

export const BUSINESS = {
  goalChars: 300,
  goalMinChars: 10,
  /** what the decision log and the ledger show at once */
  shownDecisions: 50,
  shownDays: 30,
  /** a bid's pitch, cut to this */
  pitchChars: 300,
  /** how much a price moves in one step, in basis points, and how often (once a UTC day) */
  priceStepBps: 1_000,
  /** bids it needs to have placed before it reads demand from them */
  demandBids: 3,
  /** jobs done in the last seven days before a step up in model is considered */
  modelStepJobs: 3,
  /** earned over the last seven days must be at least this many times what was spent (model costs included) */
  modelStepCover: 2,
} as const;

/**
 * The models a business may step between, cheapest first. Only models whose cost per token is known, so a step up can
 * be weighed against what it earns.
 */
export const MODEL_LADDER = ["claude-haiku-4-5", "claude-sonnet-5"] as const;
