// Autonomy 3, "its own budget": the network pays for its own work from an allowance on chain, the way a customer's
// assistant pays for a hire.
//
// The budget is an ordinary allowance on the Allowances contract, funded by a wallet the owner chooses, and an
// ordinary allowance key minted for that wallet (on the allowance page) with its own per-task and per-day limits and
// its expiry. The key goes into AUTONOMY3_BUDGET_KEY, exactly as an owner hands one to Claude or Cursor. The wallet is
// never a variable of its own: it is the wallet the key belongs to, so the network can spend that wallet's allowance and
// nobody else's. Only an allowance key is accepted; a full key is refused, since nothing would bound it.
//
// What it pays for: the network's chores ("hires its own agents", lib/autonomy3Upkeep) may hire a PAID agent that runs
// on Axon, through the same path a paid allowance hire takes (lib/allowancePayment payFromAllowance): the key's limits,
// then the allowance's own rules on chain, then the reservation. Each such hire is a normal paid job with its normal
// receipt and on-chain payment, settled or released by the reconciler like any other. Nothing here moves money itself.
//
// What it never does:
//   - shut anything off. A budget that is unset, empty, paused, expired, over its limits or refused for any reason is
//     a chore done by a free agent exactly as before, and the record notes why. Nothing here throws into the tick
//   - pay twice for one chore. Each chore is claimed in the record before anything is paid (one row per chore, made
//     unique by migration 129), so a second tick, a retry or a refusal followed by a try again cannot pay again
//   - add load on the chain for the admin page. What the page shows is read from the record and the key's own
//     reservations in the database, the same rows the allowance warnings read (lib/allowanceWatch). The allowance's
//     balance on chain is not read here; a refusal for an empty allowance says what was left, and the record keeps it.

import type { NextRequest } from "next/server";
import { getDb } from "./db";
import { createTask, markTaskPaymentConfirmed } from "./tasks";
import { refundPayment } from "./payments";
import { authenticateApiKey } from "./identity";
import { getKeyLimits, keySpentTodayWei } from "./allowanceKeys";
import { payFromAllowance, type AllowanceHire, type AllowancePaid } from "./allowancePayment";
import { parsePaymentAmount, formatEth } from "./money";
import { partOn } from "./autonomy3Policy";
import { claimJob, finishJob, recentJobs, onTick, type TickContext } from "./autonomy3";
import { logger } from "./logger";
import type { Agent } from "@/sdk/types";

type Env = Record<string, string | undefined>;

/** The allowance key the network pays with, as an owner would hand it to an assistant. */
export const BUDGET_KEY_ENV = "AUTONOMY3_BUDGET_KEY";

export const BUDGET = {
  /** a payment still open after this long lost its worker (a restart): the tick closes the record */
  staleMinutes: 15,
  /** how many payments the admin page lists */
  shown: 10,
} as const;

/** The wallet and key the budget is spent with, or null when no allowance key is set (or it is revoked or not one). */
export function budgetHolder(env: Env = process.env): { keyId: string; wallet: string; keyPrefix: string } | null {
  const raw = env[BUDGET_KEY_ENV]?.trim();
  if (!raw) return null;
  try {
    // The same check a request carrying the key gets: the key must exist, be unrevoked, and be an allowance key.
    const req = new Request("http://axon.internal/", { headers: { authorization: `Bearer ${raw}` } }) as unknown as NextRequest;
    const user = authenticateApiKey(req, { allowAllowanceScope: true });
    if (!user || user.scope !== "allowance") return null;
    return { keyId: user.keyId, wallet: user.walletAddress, keyPrefix: raw.slice(0, 12) };
  } catch {
    return null;
  }
}

export type Pay = (h: AllowanceHire) => Promise<AllowancePaid>;

export interface ChoreToPay {
  /** one chore, once: the day's report ("report:2026-10-14"), or a second opinion on one test ("review:<job id>") */
  choreKey: string;
  /** a word for the record */
  chore: string;
  /** the paid agent for it, priced at or under the given per-task limit; null when there is none */
  pick: (maxPerTaskWei: bigint) => Agent | null;
  task: string;
  context: Record<string, unknown>;
  /** who hires: the network itself */
  hirer: string;
}

/** Record that a chore was done without the budget, and why. Once per chore, like a payment. */
function fellBack(choreKey: string, chore: string, why: string, nowMs: number, detail: Record<string, unknown> = {}, claimed?: string): null {
  const id = claimed ?? claimJob("budget", choreKey, nowMs);
  if (id) finishJob(id, { outcome: "fell-back", summary: `The ${chore} went to a free agent: ${why}`, detail: { chore, why, ...detail } }, nowMs);
  return null;
}

/**
 * Hire a paid agent for one chore, paid from the network's allowance. Returns the paid job, or null when the chore
 * should go to a free agent as before (the record says why). Never throws.
 */
export async function payForChore(c: ChoreToPay, nowMs = Date.now(), env: Env = process.env, pay: Pay = payFromAllowance): Promise<{ taskId: string; agentId: string } | null> {
  if (!partOn("budget", env)) return null;
  try {
    const holder = budgetHolder(env);
    if (!holder) return fellBack(c.choreKey, c.chore, `no budget is set (${BUDGET_KEY_ENV} is not a live allowance key)`, nowMs);
    const limits = getKeyLimits(holder.keyId);
    if (!limits) return fellBack(c.choreKey, c.chore, "the budget's key has no limits on record", nowMs);
    if (Date.parse(limits.expiresAt) <= nowMs) return fellBack(c.choreKey, c.chore, "the budget's key has expired", nowMs);
    const agent = c.pick(limits.maxPerTaskWei);
    const price = agent?.price ? parsePaymentAmount(agent.price) : null;
    if (!agent || !price) return fellBack(c.choreKey, c.chore, `no paid agent for it within ${formatEth(limits.maxPerTaskWei)} a job`, nowMs);

    // Claimed before anything is paid: one chore, one payment, whatever happens next.
    const claim = claimJob("budget", c.choreKey, nowMs);
    if (!claim) return null; // tried before: it is a free agent's from here on, and nothing more is recorded or paid

    const t = createTask({ fromAgent: c.hirer, toAgent: agent.agentId, task: c.task, context: c.context, payment: agent.price, queueQueuedWebhook: false, initialStatus: "payment_pending" });
    let paid: AllowancePaid;
    try {
      paid = await pay({ taskId: t.taskId, fromAgent: c.hirer, toAgent: agent.agentId, owner: holder.wallet, priceString: agent.price!, apiKeyId: holder.keyId });
    } catch (err) {
      // refused or not available: the job never existed, as when a customer's allowance refuses a hire
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(t.taskId);
      const why = err instanceof Error ? err.message : String(err);
      return fellBack(c.choreKey, c.chore, `the budget did not pay (${why.slice(0, 160)})`, nowMs, { agentId: agent.agentId, price: agent.price }, claim);
    }
    if (!markTaskPaymentConfirmed(t.taskId)) {
      // paid but the job could not be released to the worker: the money goes back, the job goes, a free agent does it
      refundPayment(t.taskId);
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(t.taskId);
      return fellBack(c.choreKey, c.chore, "the payment could not be confirmed and was returned", nowMs, { agentId: agent.agentId, price: agent.price, txId: paid.txId }, claim);
    }
    finishJob(claim, {
      outcome: "paid",
      summary: `Paid ${agent.name} ${agent.price} from the budget for the ${c.chore}`,
      detail: { chore: c.chore, taskId: t.taskId, agentId: agent.agentId, agentName: agent.name, price: agent.price, wei: price.wei.toString(), txId: paid.txId, reserveTx: paid.reserveTx, owner: holder.wallet, keyId: holder.keyId, receipt: `/r/${t.taskId}` },
    }, nowMs);
    logger.info("autonomy3.budget_paid", "A chore was paid from the network's budget", { taskId: t.taskId, agentId: agent.agentId, price: agent.price });
    return { taskId: t.taskId, agentId: agent.agentId };
  } catch (err) {
    logger.warn("autonomy3.budget_failed", "Paying a chore from the budget did not work; a free agent does it", { chore: c.choreKey, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Payments left open by a worker that stopped mid-payment are closed, so the record does not show them running. */
export function closeStale(nowMs = Date.now()): number {
  let n = 0;
  for (const j of recentJobs(200, "budget")) {
    if (j.finishedAt || nowMs - Date.parse(j.startedAt) < BUDGET.staleMinutes * 60_000) continue;
    finishJob(j.id, { outcome: "interrupted", summary: "The worker stopped while paying for this chore; the allowance's own record shows whether it paid" }, nowMs);
    n++;
  }
  return n;
}

onTick("budget", async ({ nowMs }: TickContext) => { closeStale(nowMs); });

// ── What the admin page shows ─────────────────────────────────────────────────

export interface BudgetState {
  on: boolean;
  /** an allowance key is set and live */
  set: boolean;
  wallet: string | null;
  keyPrefix: string | null;
  perTask: string | null;
  perDay: string | null;
  expiresAt: string | null;
  /** committed today from the budget (reserved or settled), as the key's own limit counts it */
  spentToday: string;
  /** what is left today under the key's daily limit */
  leftToday: string | null;
  payments: { at: string; agent: string; price: string; receipt: string; chore: string }[];
  /** the latest chore that went to a free agent instead, and why */
  lastFellBack: { at: string; summary: string } | null;
}

/** The budget, read from the record and the key's reservations. No chain call. */
export function budgetState(nowMs = Date.now(), env: Env = process.env): BudgetState {
  const holder = budgetHolder(env);
  const limits = holder ? getKeyLimits(holder.keyId) : null;
  let spent = 0n;
  try {
    if (holder) spent = keySpentTodayWei(holder.keyId, nowMs);
  } catch { /* before the allowance tables */ }
  const jobs = recentJobs(100, "budget");
  const payments = jobs.filter((j) => j.outcome === "paid").slice(0, BUDGET.shown).map((j) => {
    const d = (j.detail ?? {}) as { agentName?: string; agentId?: string; price?: string; receipt?: string; chore?: string };
    return { at: j.startedAt, agent: d.agentName ?? d.agentId ?? "", price: d.price ?? "", receipt: d.receipt ?? "", chore: d.chore ?? "" };
  });
  const fell = jobs.find((j) => j.outcome === "fell-back");
  return {
    on: partOn("budget", env),
    set: Boolean(holder && limits),
    wallet: holder?.wallet ?? null,
    keyPrefix: holder?.keyPrefix ?? null,
    perTask: limits ? formatEth(limits.maxPerTaskWei) : null,
    perDay: limits ? formatEth(limits.maxPerDayWei) : null,
    expiresAt: limits?.expiresAt ?? null,
    spentToday: formatEth(spent),
    leftToday: limits ? formatEth(limits.maxPerDayWei > spent ? limits.maxPerDayWei - spent : 0n) : null,
    payments,
    lastFellBack: fell ? { at: fell.startedAt, summary: fell.summary ?? "" } : null,
  };
}
