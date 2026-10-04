// Mylo's daily budget. Every model call reserves its upper bound before it is made (myloPolicy.callBoundMicroUsd) and is
// refused if that would take the day past the budget; after the call its real cost, from the model's own usage report,
// is recorded and the reservation released. A call that fails before reporting is counted at its bound, never at
// nothing. The check and the reservation happen in one synchronous step, so calls running at once can't both squeeze
// into the last of the budget. (One server process holds the reservations; Axon runs one.)

import { getDb } from "./db";
import { callBoundMicroUsd, costMicroUsd, dailyBudgetUsd, type Usage } from "./myloPolicy";

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

/** Hold room for one call, or null if it might not fit in what is left of today's budget. */
export function reserveCall(model: string, requestBytes: number, maxTokens: number): Hold | null {
  const micro = callBoundMicroUsd(model, requestBytes, maxTokens);
  if (spentTodayMicroUsd() + reserved + micro > budgetMicroUsd()) return null;
  reserved += micro;
  return { model, micro, settled: false };
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
