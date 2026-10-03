// Agent Studio: the decisions every other part of it reads.
//
// Studio turns one sentence into an agent: Axon writes it, tests it on tasks it makes up, has a second agent grade the
// answers, rewrites it where it scored low and tests it again, and only then lists it. The creator sets the price and
// keeps what it earns. Creating one is free, as registering an agent always has been.
//
// Free means the only cost is Axon's own model spend, so the rules that keep that bounded live here, in one place:
//   - a wallet can start only so many builds a day, more as it holds more $AXON (holderTier)
//   - every build has a hard ceiling on model calls: test tasks, improve rounds, tokens per call
//   - the whole of Studio can be switched off without a deploy (STUDIO=off)
// and so do the rules for what an agent may be, and for taking earnings out:
//   - the same content checks as every registration (agentContent), on the name, the description and the instructions
//   - earnings leave only to the agent owner's own wallet, above a floor, under a daily ceiling, every one recorded

import type { TierName } from "./holderTier";

// ── On and off ────────────────────────────────────────────────────────────────

/** Kill switch: with STUDIO=off nothing new is built and no build continues. Published agents keep working. */
export function studioEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.STUDIO ?? "on").trim().toLowerCase() !== "off";
}

// ── How much a wallet can build ───────────────────────────────────────────────

/** Builds a wallet may start in a rolling day, by its $AXON tier. A build that fails early still counts. */
export const BUILDS_PER_DAY: Record<TierName, number> = { base: 5, holder: 15, builder: 40, operator: 100 };

/** And at most this many running at once per wallet, whatever the tier: a build is minutes of model calls. */
export const MAX_RUNNING_PER_WALLET = 2;

/** Across all of Axon at once: a burst of new creators queues rather than running the bill up in one go. */
export const MAX_RUNNING_TOTAL = 20;

export function buildsAllowed(tier: TierName, startedToday: number, runningNow: number): { ok: true } | { ok: false; reason: string } {
  if (runningNow >= MAX_RUNNING_PER_WALLET) return { ok: false, reason: `${MAX_RUNNING_PER_WALLET} builds are already running for this wallet. Wait for one to finish.` };
  const cap = BUILDS_PER_DAY[tier];
  if (startedToday >= cap) return { ok: false, reason: `This wallet has started its ${cap} builds for today. Holding more $AXON raises the limit.` };
  return { ok: true };
}

// ── What one build may spend ──────────────────────────────────────────────────

/** The ceiling on a single build's model calls. Every number here is a hard stop, not a target. */
export const BUILD_BUDGET = {
  /** test tasks written per round */
  testTasks: 6,
  /** rounds of test, grade, rewrite; the first round is the first draft */
  maxRounds: 3,
  /** stop early once the score is this good (out of 10) */
  goodEnough: 8.5,
  /** tokens the agent may answer one test task with */
  answerTokens: 1_200,
  /** tokens the writer may use for a draft */
  writerTokens: 2_500,
  /** and for a rewrite: the whole instructions again, up to 6,000 characters, with room to spare */
  rewriteTokens: 4_000,
  /** tokens the grader may use for one verdict */
  graderTokens: 400,
  /** the most model calls a build can make: writer + (tasks × (answer + grade)) per round, plus the test-task writer */
  maxCalls: 1 + 3 * (1 + 6 * 2) + 3,
  /** a build that runs longer than this is stopped where it is; the creator keeps the best version so far */
  maxMinutes: 10,
} as const;

/** The models Studio itself uses. Overridable, so a cheaper one can be swapped in without a deploy. */
export function studioModels(env: Record<string, string | undefined> = process.env) {
  return {
    /** writes the agent and rewrites it: the one place quality matters most */
    writer: env.STUDIO_WRITER_MODEL?.trim() || "claude-sonnet-5",
    /** writes test tasks and grades answers: many small calls */
    grader: env.STUDIO_GRADER_MODEL?.trim() || "claude-haiku-4-5",
  };
}

// ── What an agent may be ──────────────────────────────────────────────────────

export const LIMITS = {
  sentenceChars: 400,
  nameChars: 48,
  descriptionChars: 180,
  instructionsChars: 8_000,
  /** knowledge: files and links an agent answers from */
  knowledgeItems: 10,
  knowledgeBytes: 2_000_000,
} as const;

/** The models an agent built in Studio may run on: the hosted ones Axon already serves. */
export const AGENT_MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5"] as const;

/** Tools Studio may give an agent. Commerce (spending) is never handed out by the writer; an owner adds it by hand. */
export const STUDIO_TOOLS = ["web_search", "web_fetch"] as const;

// ── Price ─────────────────────────────────────────────────────────────────────

/** The creator sets the price. Studio only suggests one, from similar agents, inside these bounds. */
export const PRICE_ETH = { min: 0.00001, max: 1, fallback: 0.0005 } as const;

export function clampPrice(eth: number): number {
  if (!Number.isFinite(eth) || eth <= 0) return PRICE_ETH.fallback;
  return Math.min(PRICE_ETH.max, Math.max(PRICE_ETH.min, eth));
}

// ── Remixing ──────────────────────────────────────────────────────────────────

/**
 * A live Studio agent improves from its real jobs: once this many went wrong (failed, or a review of 2 stars or less)
 * since its last attempt, Axon tries a better version, at most once a day per agent and for a few agents an hour. A new
 * version is only proposed when it beats the current one by this much on the same tests.
 */
export const IMPROVE = { minWeakJobs: 3, windowDays: 14, everyHours: 24, maxPerPass: 3, newTests: 3, margin: 0.3 } as const;

/** Changes asked for in Studio's chat, per build: each is one writer call. */
export const MAX_TWEAKS_PER_BUILD = 10;

/** An agent is listed only once its best test round scored at least this (out of 10): a weak build stays a draft. */
export const MIN_PUBLISH_SCORE = 6;

/** A remix pays the agent it was copied from this share of every hire, for as long as the remix is listed. */
export const REMIX_SHARE_BPS = 1_000;

// ── Taking earnings out ───────────────────────────────────────────────────────

/**
 * What users paid for a creator's agent is the creator's. It leaves to the wallet that owns the agent and nowhere
 * else (the owner cannot name another address), above a floor worth the gas, and under a daily ceiling per wallet so a
 * stolen session cannot empty everything at once. Every withdrawal is a row with its transaction.
 */
export const WITHDRAW = {
  minEth: 0.001,
  maxPerDayEth: 2,
  /** $AXON earnings, in whole tokens */
  minAxon: 1_000,
  maxPerDayAxon: 50_000_000,
} as const;

/** Kill switch for payouts alone: WITHDRAWALS=off stops every withdrawal, nothing else. */
export function withdrawalsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.WITHDRAWALS ?? "on").trim().toLowerCase() !== "off";
}

export function withdrawAllowed(
  amount: number,
  asset: "ETH" | "AXON",
  available: number,
  withdrawnToday: number,
): { ok: true } | { ok: false; reason: string } {
  const min = asset === "ETH" ? WITHDRAW.minEth : WITHDRAW.minAxon;
  const cap = asset === "ETH" ? WITHDRAW.maxPerDayEth : WITHDRAW.maxPerDayAxon;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "Enter an amount." };
  if (amount > available) return { ok: false, reason: "That is more than this agent has earned and not yet taken out." };
  if (amount < min) return { ok: false, reason: `The least you can take out is ${min} ${asset}, so the gas is worth it.` };
  if (withdrawnToday + amount > cap) return { ok: false, reason: `At most ${cap} ${asset} a day leaves a wallet. ${Math.max(0, cap - withdrawnToday)} ${asset} is left for today.` };
  return { ok: true };
}

// ── Who sees what ─────────────────────────────────────────────────────────────

/** A build in progress, its drafts, test tasks and grades are its owner's alone until it is published. */
export const DRAFTS_ARE_PRIVATE = true;
