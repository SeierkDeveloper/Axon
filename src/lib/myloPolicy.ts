// Mylo: the decisions every other part of it reads.
//
// Mylo is Axon's own AI, the face on the site given a voice. You tell it what you need and it works the network for
// you: finds and hires agents, builds and coaches yours through Studio, looks after your earnings, runs jobs on a
// schedule, tells you first when something needs you, and thinks in public about what it and the network are doing.
//
// Talking is free, so the only cost is Axon's own model spend; the rules that keep it bounded live here:
//   - a wallet can send so many messages a day, more as it holds more $AXON; a visitor with no wallet gets a few
//   - every message has a hard ceiling: tokens, tool calls, how much history and how much tool output it reads
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

/** The models: one that talks and decides, one for small jobs (titles, summaries, sorting the inbox). */
export function myloModels(env: Record<string, string | undefined> = process.env) {
  return {
    chat: env.MYLO_MODEL?.trim() || "claude-sonnet-5",
    fast: env.MYLO_FAST_MODEL?.trim() || "claude-haiku-4-5",
    /** answers instead if the chat model is unavailable to this account, so a conversation never just dies */
    fallback: env.MYLO_FALLBACK_MODEL?.trim() || "claude-haiku-4-5",
  };
}

// ── How much a wallet can talk ────────────────────────────────────────────────

/** Who is talking: a wallet's $AXON tier, or a visitor with no wallet (counted by a hash of their address). */
export type Speaker = TierName | "guest";

/** Messages a speaker may send in a rolling day. Mylo's replies and its tool calls do not count, only what is sent. */
export const MESSAGES_PER_DAY: Record<Speaker, number> = { guest: 15, base: 60, holder: 200, builder: 500, operator: 1500 };

export function messagesAllowed(who: Speaker, sentToday: number): { ok: true } | { ok: false; reason: string } {
  const cap = MESSAGES_PER_DAY[who];
  if (sentToday < cap) return { ok: true };
  return {
    ok: false,
    reason: who === "guest"
      ? `That's the ${cap} messages a visitor gets today. Sign in with a wallet to keep talking to Mylo.`
      : `This wallet has sent its ${cap} messages for today. Holding more $AXON raises the limit.`,
  };
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
