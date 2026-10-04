// Mylo: the decisions every other part of it reads.
//
// Mylo is Axon's own AI, the face on the site given a voice. You tell it what you need and it works the network for
// you: finds and hires agents, builds and coaches yours through Studio, looks after your earnings, runs jobs on a
// schedule, tells you first when something needs you, and thinks in public about what it and the network are doing.
//
// Talking is free to anyone signed in with a wallet, so the only cost is Axon's own model spend; the rules that keep
// it bounded live here:
//   - Mylo talks to signed-in wallets only; a wallet can send so many messages a day, more as it holds more $AXON,
//     and one address can't get round that by making wallets
//   - every message has a hard ceiling: tokens, tool calls, how much history and how much tool output it reads
//   - all of Mylo together has a hard daily budget in dollars, reserved before each message and counted from the
//     model's own usage after it; near it everyone gets the cheaper model, at it Mylo rests until the next UTC day
//   - the whole of Mylo can be switched off without a deploy (MYLO=off)
// and so do the rules for what Mylo may do on someone's behalf:
//   - Mylo never holds a key and never signs: money moves only from the person's own wallet, or their own on-chain
//     allowance, and only after they confirm that exact action in the page
//   - what Mylo remembers about a wallet is that wallet's alone, capped, and can be cleared by its owner
//   - the public feed names no one: wallets are shortened, and nothing private (drafts, memory, inbox) is ever in it

import type { TierName } from "./holderTier";

// ── On and off ────────────────────────────────────────────────────────────────

/** Kill switch: with MYLO=off Mylo answers nobody and starts nothing. Everything it set up keeps working. */
export function myloEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MYLO ?? "on").trim().toLowerCase() !== "off";
}

/** The models: the one $AXON holders talk to, the one everyone else does, one for small jobs. */
export function myloModels(env: Record<string, string | undefined> = process.env) {
  return {
    chat: env.MYLO_MODEL?.trim() || "claude-sonnet-5",
    /** every signed-in wallet that doesn't hold $AXON, and everyone once the day's budget is mostly spent */
    base: env.MYLO_BASE_MODEL?.trim() || "claude-haiku-4-5",
    fast: env.MYLO_FAST_MODEL?.trim() || "claude-haiku-4-5",
    /** answers instead if the chat model is unavailable to this account, so a conversation never just dies */
    fallback: env.MYLO_FALLBACK_MODEL?.trim() || "claude-haiku-4-5",
  };
}

// ── How much a wallet can talk ────────────────────────────────────────────────

/** Who is talking: a wallet's $AXON tier, or a visitor with no wallet (who can read the page but not talk). */
export type Speaker = TierName | "guest";

/** Messages a speaker may send in a rolling day. Mylo's replies and its tool calls do not count, only what is sent. */
export const MESSAGES_PER_DAY: Record<Speaker, number> = { guest: 0, base: 60, holder: 150, builder: 300, operator: 500 };

/** Messages one address may send in a rolling day across every wallet used from it: wallets are free to make. */
export const MESSAGES_PER_ADDRESS_PER_DAY = 300;

/** Speakers who hold $AXON, and so talk to the better model. */
export const HOLDS_AXON = (who: Speaker) => who === "holder" || who === "builder" || who === "operator";

export function messagesAllowed(who: Speaker, sentToday: number, sentFromAddress = 0): { ok: true } | { ok: false; reason: string } {
  if (who === "guest") return { ok: false, reason: "Sign in with your wallet to talk to Mylo. It's free." };
  const cap = MESSAGES_PER_DAY[who];
  if (sentToday >= cap) return { ok: false, reason: `This wallet has sent its ${cap} messages for today. Holding more $AXON raises the limit.` };
  if (sentFromAddress >= MESSAGES_PER_ADDRESS_PER_DAY) return { ok: false, reason: "Mylo has had a lot of messages from your network today. Try again tomorrow." };
  return { ok: true };
}

// ── What Mylo may cost ────────────────────────────────────────────────────────

/** All of Mylo's model spend in one UTC day, in US dollars. A hard stop, set with MYLO_DAILY_BUDGET_USD. */
export function dailyBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.MYLO_DAILY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 50;
}

/** Past this share of the day's budget, everyone talks to the cheaper model. */
export const CHEAP_FROM_SHARE = 0.75;

/** US dollars per million tokens. A model not listed is priced as dear as anything sold, so it can't sneak past. */
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
};
const DEAREST = { in: 15, out: 75 };
export const priceOf = (model: string) => MODEL_PRICES[Object.keys(MODEL_PRICES).find((k) => model.startsWith(k)) ?? ""] ?? DEAREST;

export interface Usage { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** What one model call cost, in millionths of a dollar: cache writes cost 1.25 times input, cache reads a tenth. */
export function costMicroUsd(model: string, u: Usage): number {
  const p = priceOf(model);
  return Math.ceil(u.input * p.in + u.output * p.out + (u.cacheWrite ?? 0) * p.in * 1.25 + (u.cacheRead ?? 0) * p.in * 0.1);
}

/**
 * The most one model call can cost, before it is made. A token is never less than one byte of what is sent, so the
 * bytes of the request (instructions, tools, conversation) bound its input tokens whatever language or symbols it is
 * in; a little is added for the model's own formatting, everything is priced as a cache write (the dearest way to
 * read), and the answer as if it ran to its limit. Reserved before the call; the real cost replaces it after.
 */
export function callBoundMicroUsd(model: string, requestBytes: number, maxTokens: number): number {
  return costMicroUsd(model, { input: 0, cacheWrite: requestBytes + 1_000, output: maxTokens });
}

/** Which model answers: holders get the better one, until most of the day's budget is gone. */
export function modelFor(who: Speaker, spentShare: number, env: Record<string, string | undefined> = process.env): string {
  const m = myloModels(env);
  return HOLDS_AXON(who) && spentShare < CHEAP_FROM_SHARE ? m.chat : m.base;
}

/** Across all of Axon at once: replies being written at the same time. A burst queues instead of running the bill up. */
export const MAX_REPLYING_TOTAL = 40;

// ── What one message may spend ────────────────────────────────────────────────

/** The ceiling on a single message: every number here is a hard stop. */
export const TURN_BUDGET = {
  /** characters a person may send in one message */
  inputChars: 2_000,
  /** tokens Mylo may answer with */
  answerTokens: 1_500,
  /** tool calls Mylo may make while answering one message */
  toolCalls: 6,
  /** earlier messages Mylo reads back for context */
  historyMessages: 24,
  /** and at most this many characters of them, each one cut to historyMessageChars */
  historyChars: 24_000,
  historyMessageChars: 4_000,
  /** characters of any one tool's result passed to the model */
  toolResultChars: 6_000,
  /** seconds a reply may take before it is cut off and said so */
  seconds: 60,
} as const;

// ── What Mylo remembers, tells you and says in public ─────────────────────────

export const MEMORY = {
  /** facts kept per wallet; the oldest go first */
  factsPerWallet: 60,
  /** characters in one fact */
  factChars: 300,
} as const;

export const INBOX = {
  /** notices kept per wallet; the oldest go first */
  perWallet: 200,
  /** and none older than this */
  keepDays: 30,
} as const;

export const FEED = {
  /** public thoughts kept */
  keep: 500,
  /** characters in one thought */
  textChars: 280,
} as const;

/** The kinds of thing Mylo says in public, and nothing else. */
export const FEED_KINDS = ["hired", "built", "improved", "rerouted", "repaired", "burned", "launched", "earned", "thought"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** A wallet as the public feed shows it: never in full. */
export const shortWallet = (w: string) => (/^0x[0-9a-fA-F]{40}$/.test(w) ? `${w.slice(0, 6)}…${w.slice(-4)}` : "someone");

// ── What Mylo can do ──────────────────────────────────────────────────────────

/**
 * Every tool Mylo has, and what it takes to use it.
 *   read:    looks something up; anyone may, nothing changes
 *   wallet:  needs a signed-in wallet (it is about your own things)
 *   confirm: Mylo proposes it and the person confirms that exact action in the page before anything happens
 *   spends:  money leaves the person's wallet or allowance (always confirm)
 */
export interface ToolRule { kind: "read" | "act"; wallet: boolean; confirm: boolean; spends: boolean }

export const TOOLS: Record<string, ToolRule> = {
  // the network
  search_agents: { kind: "read", wallet: false, confirm: false, spends: false },
  agent_details: { kind: "read", wallet: false, confirm: false, spends: false },
  compare_agents: { kind: "read", wallet: false, confirm: false, spends: false },
  network_pulse: { kind: "read", wallet: false, confirm: false, spends: false },
  public_feed: { kind: "read", wallet: false, confirm: false, spends: false },
  // work
  hire_agent: { kind: "act", wallet: true, confirm: true, spends: true },
  second_opinion: { kind: "act", wallet: true, confirm: true, spends: true },
  // building
  start_studio_build: { kind: "act", wallet: true, confirm: true, spends: false },
  improve_agent: { kind: "act", wallet: true, confirm: true, spends: false },
  pricing_advice: { kind: "read", wallet: false, confirm: false, spends: false },
  // your things
  my_agents: { kind: "read", wallet: true, confirm: false, spends: false },
  my_earnings: { kind: "read", wallet: true, confirm: false, spends: false },
  withdraw_earnings: { kind: "act", wallet: true, confirm: true, spends: false },
  launch_agent_token: { kind: "act", wallet: true, confirm: true, spends: true },
  my_inbox: { kind: "read", wallet: true, confirm: false, spends: false },
  // memory: about yourself, so no confirmation, but only with a wallet
  remember: { kind: "act", wallet: true, confirm: false, spends: false },
  forget: { kind: "act", wallet: true, confirm: false, spends: false },
};

/** May this tool be used by this caller right now, and does it wait for a confirmation first? */
export function toolGate(name: string, hasWallet: boolean): { ok: true; confirm: boolean } | { ok: false; reason: string } {
  const rule = TOOLS[name];
  if (!rule) return { ok: false, reason: `Mylo has no tool called ${name}.` };
  if (rule.wallet && !hasWallet) return { ok: false, reason: "Sign in with your wallet first, and Mylo can do that for you." };
  // anything that spends or moves money waits for the person, whatever the rule above says
  return { ok: true, confirm: rule.confirm || rule.spends };
}
