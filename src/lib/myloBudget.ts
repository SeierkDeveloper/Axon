// Mylo's daily budget. Every model call holds its upper bound before it is made (myloPolicy.callBoundMicroUsd) and,
// after it, its real cost from the model's own usage report is recorded and the hold released; a call that fails before
// reporting is counted at its bound, never at nothing. Mylo never stops at the budget (the owner's decision): past
// three quarters of it everyone talks to the cheaper model, past all of it Mylo keeps answering on that model, and the
// overspend is logged once a day so the owner can see it and make the next day cheaper. What bounds the spend is the
// per-wallet and per-address daily message limits. (One server process holds the holds; Axon runs one.)

import { getDb } from "./db";
import { callBoundMicroUsd, costMicroUsd, dailyBudgetUsd, type Usage } from "./myloPolicy";
import { logger } from "./logger";

let reserved = 0;

const startOfUtcDay = (at = new Date()) => { const d = new Date(at); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
const budgetMicroUsd = () => Math.floor(dailyBudgetUsd() * 1_000_000);

/** What Mylo's calls have cost since midnight UTC, in millionths of a dollar. */
export function spentTodayMicroUsd(): number {
  return (getDb().prepare("SELECT COALESCE(SUM(cost_micro_usd), 0) s FROM mylo_usage WHERE created_at >= ?").get(startOfUtcDay()) as { s: number }).s;
}

/** How much of today's budget is spent or held by calls in flight, 0 to 1. */
export function budgetShare(): number {
  const b = budgetMicroUsd();
  return b <= 0 ? 1 : Math.min(1, (spentTodayMicroUsd() + reserved) / b);
}

export interface Hold { model: string; micro: number; settled: boolean }

let overLoggedFor: string | null = null;

/** Hold room for one call. Never refused: past the budget the call still runs (on the cheaper model, see modelFor), and
 *  the first call over it each day is logged with what has been spent. */
export function reserveCall(model: string, requestBytes: number, maxTokens: number): Hold {
  const micro = callBoundMicroUsd(model, requestBytes, maxTokens);
  const spent = spentTodayMicroUsd(), day = startOfUtcDay();
  if (spent + reserved + micro > budgetMicroUsd() && overLoggedFor !== day) {
    overLoggedFor = day;
    logger.warn("mylo.over_budget", "Mylo passed today's budget and keeps answering on the cheaper model", { spentUsd: spent / 1e6, budgetUsd: budgetMicroUsd() / 1e6 });
  }
  reserved += micro;
  return { model, micro, settled: false };
}

/** What Mylo spent on each of the last few UTC days, for the owner to check. */
export function spendByDay(days = 7): { day: string; usd: number; calls: number }[] {
  return (getDb().prepare("SELECT substr(created_at, 1, 10) day, SUM(cost_micro_usd) micro, COUNT(*) calls FROM mylo_usage WHERE created_at >= ? GROUP BY day ORDER BY day DESC").all(new Date(Date.now() - days * 86_400_000).toISOString()) as { day: string; micro: number; calls: number }[])
    .map((r) => ({ day: r.day, usd: Math.round(r.micro) / 1e6, calls: r.calls }));
}

/** Record what a call really cost (or, with no usage report, its bound) and release its hold. Once per hold. */
export function settleCall(hold: Hold, used: { model?: string; usage?: Usage | null } | null, ctx: { speaker?: string; conversationId?: string } = {}): number {
  if (hold.settled) return 0;
  hold.settled = true;
  reserved -= hold.micro;
  const model = used?.model ?? hold.model, u = used?.usage ?? null;
  const cost = u ? costMicroUsd(model, u) : hold.micro;
  getDb().prepare("INSERT INTO mylo_usage (created_at, model, speaker, conversation_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated, cost_micro_usd) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), model, ctx.speaker ?? null, ctx.conversationId ?? null, u?.input ?? 0, u?.output ?? 0, u?.cacheRead ?? 0, u?.cacheWrite ?? 0, u ? 0 : 1, cost);
  return cost;
}

/** For tests: forget what is held. */
export function _resetHolds() { reserved = 0; }
