// Agents that run their own business: every limit on what it spends, kept in this one place.
//
// Anything a business is about to pay for (a hire inside a job, a product bought as material, a step up in model) asks
// here first, with what kind of spend it is, how much, and the job it is for. The answer is one of three:
//
//   ok        it may go ahead
//   ask       it is within every limit, but above the amount the owner wants to OK themselves: it waits for them
//   refused   with the reason, in words for the decision log
//
// In this order: the business is running; the owner lets it spend on this kind of thing; the job stays within the most
// on one job; the day within the most a day (UTC); everything ever within the budget; and only then the amount that
// needs the owner's OK. What was spent is read from the ledger (./businessLedger), so a hire that was refunded gives
// its room back.
//
// These are the business's own limits. Whatever pays still keeps its own: an allowance key its per-task and daily
// limits and the contract its rules, an agent's balance what is in it.

import { formatEth } from "./money";
import { dayOf, type Business } from "./business";
import { paidOut } from "./businessLedger";
import { SPEND_WORDS, type SpendKind } from "./businessPolicy";

export type SpendVerdict =
  | { ok: true }
  | { ok: false; ask: true; why: string }
  | { ok: false; ask?: false; why: string };

export interface SpendQuestion {
  kind: SpendKind;
  wei: bigint;
  /** the job it is for; a step in model is for no one job */
  jobRef?: string | null;
  /** the owner already said yes to exactly this */
  approved?: boolean;
  nowMs?: number;
}

export function checkSpend(b: Business, q: SpendQuestion): SpendVerdict {
  const l = b.limits;
  if (b.status !== "active") return { ok: false, why: `The business is ${b.status}` };
  if (!l.kinds.includes(q.kind)) return { ok: false, why: `It may not ${SPEND_WORDS[q.kind].charAt(0).toLowerCase()}${SPEND_WORDS[q.kind].slice(1)}: you have not allowed it` };
  if (q.wei <= 0n) return { ok: true };
  if (q.jobRef) {
    const onJob = paidOut(b.businessId, { jobRef: q.jobRef });
    if (onJob + q.wei > l.maxPerJobWei) return { ok: false, why: `${formatEth(q.wei)} would take this job past its limit of ${formatEth(l.maxPerJobWei)} (${formatEth(onJob)} spent on it)` };
  } else if (q.wei > l.maxPerJobWei) {
    return { ok: false, why: `${formatEth(q.wei)} is above the most on one thing, ${formatEth(l.maxPerJobWei)}` };
  }
  const today = paidOut(b.businessId, { day: dayOf(q.nowMs ?? Date.now()) });
  if (today + q.wei > l.maxPerDayWei) return { ok: false, why: `${formatEth(q.wei)} would take today past its limit of ${formatEth(l.maxPerDayWei)} (${formatEth(today)} spent today)` };
  const ever = paidOut(b.businessId);
  if (ever + q.wei > l.budgetWei) return { ok: false, why: `${formatEth(q.wei)} would go past the budget of ${formatEth(l.budgetWei)} (${formatEth(ever)} spent so far)` };
  if (q.wei > l.approveAboveWei && !q.approved) return { ok: false, ask: true, why: `${formatEth(q.wei)} is above ${formatEth(l.approveAboveWei)}, so it waits for your OK` };
  return { ok: true };
}

/** What is left of the budget, today's limit, and one job's, as the owner reads them. */
export function roomLeft(b: Business, nowMs = Date.now()): { budget: bigint; today: bigint } {
  const ever = paidOut(b.businessId), today = paidOut(b.businessId, { day: dayOf(nowMs) });
  const left = (cap: bigint, used: bigint) => (cap > used ? cap - used : 0n);
  return { budget: left(b.limits.budgetWei, ever), today: left(b.limits.maxPerDayWei, today) };
}
