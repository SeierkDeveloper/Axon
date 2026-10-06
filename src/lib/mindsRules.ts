// Agent Minds: the rule check.
//
// A mind proposes; this decides. It is ordinary code with no model in it, and it is the only way a proposal ever gets
// marked as allowed. It checks a proposal against what the token's creator locked at launch (what the mind may do, and
// its limits) and against what the treasury really holds. The treasury's own contract enforces the same limits again
// when anything is sent, so a mistake here could at worst send nothing.

import { CAN } from "./mindsLaunch";

export type ProposalKind = "buyback" | "reward" | "burn_axon";
export interface Proposal { kind: ProposalKind; eth: number }

export interface RuleContext {
  /** the treasury's bit flags for what the mind may do */
  allowed: number;
  maxPerDayEth: number;
  maxPerActionEth: number;
  maxActionsPerDay: number;
  /** what the treasury can spend right now */
  availableEth: number;
  /** thinking the mind has done and not paid for yet: that comes out of the treasury first */
  owedThinkingEth: number;
  spentTodayEth: number;
  actionsToday: number;
  /** the treasury is running: not paused by its creator, not frozen, minds not stopped */
  active: boolean;
  /** 0 on its curve, 1 between curve and pool, 2 in its pool, 3 rescued */
  phase: number;
  holders: number;
  /** the token was launched before minds and got its mind later */
  attached?: boolean;
  /** the floor its own plan keeps: ETH that stays in the treasury whatever it proposes. 0 without a plan. */
  reserveEth?: number;
  /** ETH held for promises the mind has made and not yet been called on: nothing else may spend it. 0 without any. */
  heldEth?: number;
}

/** Nothing smaller than this is worth its own gas. */
export const MIN_ACTION_ETH = 0.0001;
/** Kept back in the treasury so the mind can always pay for its next thoughts. */
export const THINKING_RESERVE_ETH = 0.0002;

const FLAG: Record<ProposalKind, number> = { buyback: CAN.buyback, reward: CAN.reward, burn_axon: CAN.burnAxon };
const NAME: Record<ProposalKind, string> = { buyback: "buy back and burn", reward: "reward holders", burn_axon: "burn $AXON" };

export type Verdict = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Verdict => ({ ok: false, reason });

/** Read a model's proposal into one this can check, or null when it proposed nothing that can be read. */
export function readProposal(raw: unknown): Proposal | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = String(r.kind ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const eth = typeof r.eth === "number" ? r.eth : typeof r.eth === "string" && /^\d+(\.\d+)?$/.test(r.eth.trim()) ? Number(r.eth) : NaN;
  if (!(kind in FLAG)) return null;
  return { kind: kind as ProposalKind, eth };
}

export function checkProposal(p: Proposal, c: RuleContext): Verdict {
  if (!c.active) return no("The mind is stopped.");
  if (!Number.isFinite(p.eth) || p.eth <= 0) return no("The amount is not a number above zero.");
  if (!(c.allowed & FLAG[p.kind])) return no(`This mind was never allowed to ${NAME[p.kind]}.`);
  if (p.eth < MIN_ACTION_ETH) return no(`Too small to be worth sending: the least is ${MIN_ACTION_ETH} ETH.`);
  if (p.eth > c.maxPerActionEth) return no(`More than one action may spend (${c.maxPerActionEth} ETH).`);
  if (c.actionsToday >= c.maxActionsPerDay) return no(`It has already acted ${c.actionsToday} times today, which is its limit.`);
  if (c.spentTodayEth + p.eth > c.maxPerDayEth + 1e-12) return no(`It would pass the day's limit (${c.maxPerDayEth} ETH).`);
  const free = c.availableEth - c.owedThinkingEth - THINKING_RESERVE_ETH;
  if (p.eth > free + 1e-12) return no(`The treasury cannot cover it: ${Math.max(0, free).toFixed(6)} ETH is free after what its thinking costs.`);
  const floor = c.reserveEth ?? 0;
  if (floor > 0 && p.eth > free - floor + 1e-12) return no(`It would take the treasury below the reserve its own plan keeps (${floor} ETH): ${Math.max(0, free - floor).toFixed(6)} ETH is free above it.`);
  const held = c.heldEth ?? 0;
  if (held > 0 && p.eth > free - floor - held + 1e-12) return no(`It would spend what it has promised: ${held} ETH is held for promises it made, and ${Math.max(0, free - floor - held).toFixed(6)} ETH is free beside that.`);
  if (p.kind === "buyback" && (c.phase === 1 || c.phase === 3)) return no("The token has no open market to buy on right now.");
  if (p.kind === "reward" && c.attached) return no("Rewards are not open for a token launched before minds: its holders are only counted from the day it got its mind.");
  if (p.kind === "reward" && c.holders < 2) return no("There are not enough holders to reward yet.");
  return { ok: true };
}
