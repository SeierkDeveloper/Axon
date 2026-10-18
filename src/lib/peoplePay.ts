// Agents that hire people: the only place ETH leaves for a task.
//
// Two kinds of payout, one row each per task (people_payouts, unique on task and kind):
//
//   pay     an accepted task's pay, to the person who did it
//   return  an owner's own payment for a task nobody finished, back to their wallet
//
// Paid from Axon's receiving wallet, the one key the server holds for paying out (./evm sendNative, which refuses any
// other). The order is the one withdrawals keep (./studioWithdraw), because this moves real ETH and cannot be undone:
//
//   1. the row is written (queued), then marked pending under one step, so two workers cannot both send it
//   2. send; the hash is saved the moment the transaction is sent, before waiting for it
//   3. sent, or failed when nothing left the wallet (it is tried again later, a few times)
//
// A pending row whose send did not come back stays pending, with its hash if it has one, for an admin to settle: it is
// never sent again by itself. Pay across the network is held to a daily ceiling (peopleCaps().payoutsPerDayWei); past
// it, an accepted task waits for the next UTC day and says so.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { sendNative, payoutWalletBalance } from "./evm";
import { formatEth, weiToDecimalString } from "./money";
import { shortAddress } from "./address";
import { getPeopleTask, logEvent, type PeopleTask } from "./people";
import { peopleCaps, type PeopleCaps } from "./peoplePolicy";
import { safeAppendTraceEvent, traceIdForTask } from "./traceEvents";

/** Gas the paying wallet keeps back on top of a payout, so it can always send the next one. */
const GAS_RESERVE_WEI = 20_000_000_000_000n; // 0.00002 ETH
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 5 * 60_000;

export interface PayDeps {
  send?: typeof sendNative;
  balance?: () => Promise<bigint | null>;
  caps?: PeopleCaps;
  nowMs?: number;
}

type Row = Record<string, unknown>;
const big = (v: unknown): bigint => (v !== null && v !== undefined && /^\d+$/.test(String(v)) ? BigInt(String(v)) : 0n);
const iso = (ms: number) => new Date(ms).toISOString();

/** Pay sent or on its way today (UTC), across every task: what the daily ceiling is kept against. */
export function paidToday(nowMs = Date.now()): bigint {
  const start = `${iso(nowMs).slice(0, 10)}T00:00:00.000Z`;
  return (getDb().prepare("SELECT amount_wei FROM people_payouts WHERE kind = 'pay' AND status IN ('pending', 'sent') AND updated_at >= ?").all(start) as { amount_wei: string }[])
    .reduce((n, r) => n + big(r.amount_wei), 0n);
}

/** Queue the pay of an accepted task, once. */
function queuePay(t: PeopleTask, nowMs: number): void {
  if (!t.takerWallet) return;
  const at = iso(nowMs);
  getDb().prepare("INSERT INTO people_payouts (payout_id, task_id, kind, wallet, amount_wei, status, created_at, updated_at) VALUES (?, ?, 'pay', ?, ?, 'queued', ?, ?) ON CONFLICT (task_id, kind) DO NOTHING")
    .run(`pp_${randomUUID().replace(/-/g, "").slice(0, 20)}`, t.taskId, t.takerWallet, t.priceWei.toString(), at, at);
}

/** One payout: sent, waiting (and why), or failed. Never throws. */
export async function sendPayout(payoutId: string, deps: PayDeps = {}): Promise<"sent" | "waiting" | "failed" | "skipped"> {
  const db = getDb(), nowMs = deps.nowMs ?? Date.now(), caps = deps.caps ?? peopleCaps();
  const p = db.prepare("SELECT * FROM people_payouts WHERE payout_id = ?").get(payoutId) as Row | undefined;
  if (!p || !["queued", "failed"].includes(String(p.status))) return "skipped";
  const kind = String(p.kind), taskId = String(p.task_id), wallet = String(p.wallet), wei = big(p.amount_wei);
  if (kind === "pay" && paidToday(nowMs) + wei > caps.payoutsPerDayWei) {
    const said = db.prepare("SELECT 1 FROM people_events WHERE task_id = ? AND kind = 'pay_waiting' AND created_at >= ?").get(taskId, `${iso(nowMs).slice(0, 10)}T00:00:00.000Z`);
    if (!said) logEvent(taskId, "pay_waiting", "Accepted. Today's pay across the network reached its ceiling, so this is paid after midnight UTC.", wallet, iso(nowMs));
    return "waiting";
  }
  // 1. one worker takes it
  const took = db.prepare("UPDATE people_payouts SET status = 'pending', attempts = attempts + 1, updated_at = ? WHERE payout_id = ? AND status IN ('queued', 'failed')").run(iso(nowMs), payoutId).changes;
  if (!took) return "skipped";
  const fail = (why: string) => {
    db.prepare("UPDATE people_payouts SET status = 'failed', error = ?, updated_at = ? WHERE payout_id = ?").run(why.slice(0, 200), iso(Date.now()), payoutId);
  };
  const held = await (deps.balance ?? payoutWalletBalance)().catch(() => null);
  if (held === null || held < wei + GAS_RESERVE_WEI) {
    fail("payout wallet short");
    // nothing was tried: it does not use up an attempt, so it is sent once the wallet is topped up
    db.prepare("UPDATE people_payouts SET attempts = attempts - 1 WHERE payout_id = ?").run(payoutId);
    logger.warn("people.payout_short", "The payout wallet could not cover a payout to a person", { taskId, kind, amount: weiToDecimalString(wei) });
    return "failed";
  }
  // 2. send, keeping the hash the moment it exists
  try {
    const hash = await (deps.send ?? sendNative)(wallet, weiToDecimalString(wei), (h) => {
      db.prepare("UPDATE people_payouts SET tx_hash = ?, updated_at = ? WHERE payout_id = ?").run(h, iso(Date.now()), payoutId);
    });
    // 3. done
    db.prepare("UPDATE people_payouts SET status = 'sent', tx_hash = ?, error = NULL, updated_at = ? WHERE payout_id = ?").run(hash, iso(Date.now()), payoutId);
    const t = getPeopleTask(taskId);
    if (kind === "pay") {
      db.prepare("UPDATE people_tasks SET status = 'paid', lock_state = 'paid', closed_at = ?, updated_at = ? WHERE task_id = ? AND status = 'accepted'").run(iso(Date.now()), iso(Date.now()), taskId);
      logEvent(taskId, "paid", `Paid ${formatEth(wei)} to ${shortAddress(wallet)} on Robinhood Chain, transaction ${hash}`, wallet);
      if (t?.parentTaskId) {
        safeAppendTraceEvent({ traceId: traceIdForTask(t.parentTaskId), taskId: t.parentTaskId, kind: "people.task", fromAgent: t.agentId, toAgent: null, meta: { peopleTask: taskId, status: "paid", amount: Number(weiToDecimalString(wei)), currency: "ETH", tx: hash } });
      }
    } else {
      db.prepare("UPDATE people_tasks SET lock_state = 'returned', updated_at = ? WHERE task_id = ?").run(iso(Date.now()), taskId);
      logEvent(taskId, "returned", `${formatEth(wei)} went back to the owner's wallet, transaction ${hash}`);
    }
    logger.info("people.payout_sent", "ETH left for a task for people", { taskId, kind, amount: weiToDecimalString(wei), hash });
    void syncToTurso();
    return "sent";
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 200) : String(err);
    const hash = (db.prepare("SELECT tx_hash FROM people_payouts WHERE payout_id = ?").get(payoutId) as { tx_hash: string | null }).tx_hash;
    if (hash) {
      // it left the wallet but its receipt did not come back: stays pending for an admin, never sent again
      db.prepare("UPDATE people_payouts SET error = ?, updated_at = ? WHERE payout_id = ?").run(`unconfirmed: ${why}`, iso(Date.now()), payoutId);
      logger.error("people.payout_unconfirmed", "A payout to a person was sent but not confirmed", { taskId, kind, hash, why });
      return "waiting";
    }
    fail(why);
    logger.warn("people.payout_failed", "A payout for a task for people could not be sent", { taskId, kind, why });
    return "failed";
  }
}

/** Every accepted task gets its pay queued; every queued payout, and every failed one due again, is sent. */
export async function runPayouts(deps: PayDeps = {}): Promise<{ sent: number; waiting: number; failed: number }> {
  const db = getDb(), nowMs = deps.nowMs ?? Date.now(), out = { sent: 0, waiting: 0, failed: 0 };
  for (const r of db.prepare("SELECT * FROM people_tasks WHERE status = 'accepted' AND task_id NOT IN (SELECT task_id FROM people_payouts WHERE kind = 'pay') LIMIT 50").all() as Row[]) {
    const t = getPeopleTask(String(r.task_id));
    if (t) queuePay(t, nowMs);
  }
  const due = db.prepare("SELECT payout_id FROM people_payouts WHERE status = 'queued' OR (status = 'failed' AND attempts < ? AND updated_at <= ?) ORDER BY created_at LIMIT 20")
    .all(MAX_ATTEMPTS, iso(nowMs - RETRY_AFTER_MS)) as { payout_id: string }[];
  for (const { payout_id } of due) {
    const r = await sendPayout(payout_id, deps);
    if (r === "sent") out.sent++;
    else if (r === "waiting") out.waiting++;
    else if (r === "failed") out.failed++;
  }
  return out;
}

/** Pay one accepted task now, without waiting for the worker: what a page calls right after an accept. */
export async function payNow(taskId: string, deps: PayDeps = {}): Promise<void> {
  const t = getPeopleTask(taskId);
  if (!t || t.status !== "accepted") return;
  queuePay(t, deps.nowMs ?? Date.now());
  const p = getDb().prepare("SELECT payout_id FROM people_payouts WHERE task_id = ? AND kind = 'pay'").get(taskId) as { payout_id: string } | undefined;
  if (p) await sendPayout(p.payout_id, deps);
}
