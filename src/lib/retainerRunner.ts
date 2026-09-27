// The retainer runner: hires agents when their slot comes up, and closes runs when their work ends.
//
// Every run is the same hire POST /api/tasks makes with paymentMethod "allowance": a task created as
// payment_pending, paid from the owner's allowance, confirmed, or rolled back if the payment is
// refused. Nothing here moves money itself.
//
// Three properties hold whatever happens to the process:
//
//   One run per slot. The run row is claimed with an INSERT against UNIQUE(retainer_id, scheduled_for)
//   before anything is hired, so two workers, a restart or a double tick cannot hire twice.
//
//   No backlog. A slot more than ON_TIME_WINDOW_MS late is missed; only the latest due slot runs, and
//   the earlier one is recorded as missed, so an owner is never billed for a night of runs at once.
//
//   The next slot moves before the hire. A crash mid-run leaves the retainer pointing at its next slot,
//   not stuck re-trying the one it was on.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { getAgentById } from "./agents";
import { parsePaymentAmount, weiToDecimalString } from "./money";
import { getTier } from "./holderTier";
import { createTask, markTaskPaymentConfirmed, getTaskById } from "./tasks";
import { payFromAllowance, freshAxonQuoteFor, AllowancePaymentError } from "./allowancePayment";
import { getKeyLimits } from "./allowanceKeys";
import { getRetainer, agentUnavailable, receiptUrl, type Retainer } from "./retainers";
import { nextSlot, latestSlot } from "./retainerSchedule";
import { FAILURES_BEFORE_PAUSE, ON_TIME_WINDOW_MS, tierPaceAllows, retainerPriceWei, PAUSE_REASON_TEXT, SKIP_REASON_TEXT, type PauseReason, type SkipReason } from "./retainerPolicy";
import { queueRetainerEvent, type RetainerEvent } from "./retainerWebhooks";


/**
 * Tell the owner's webhooks. Never lets a delivery problem touch the run itself: the run is the
 * record, the webhook is a courtesy on top of it.
 */
function notify(retainerId: string, event: RetainerEvent, data: Record<string, unknown>, nowMs: number) {
  try {
    queueRetainerEvent(retainerId, event, data, nowMs);
  } catch (err) {
    logger.warn("retainer.webhook_queue_failed", "Could not queue a retainer webhook", { err, event });
  }
}

/** A run that did not complete, told to the owner with the same words the dashboard shows. */
function notifyRunFailed(r: Pick<Retainer, "retainerId" | "agentId">, runId: string, scheduledFor: number | string, status: "failed" | "skipped", reason: SkipReason | null, message: string | null, taskId: string | null, nowMs: number) {
  notify(r.retainerId, "retainer.run.failed", {
    retainerId: r.retainerId,
    runId,
    agentId: r.agentId,
    scheduledFor: typeof scheduledFor === "number" ? iso(scheduledFor) : scheduledFor,
    status,
    reason,
    message: message ?? (reason ? SKIP_REASON_TEXT[reason] : null),
    taskId,
    receiptUrl: taskId ? receiptUrl(taskId) : null,
  }, nowMs);
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface RunTickResult {
  due: number;
  hired: number;
  skipped: number;
  ended: number;
}

/** Record a slot. False when the slot was already recorded, by this worker or another. */
function claimSlot(retainerId: string, scheduledFor: number, status: string, nowMs: number, skip?: SkipReason, error?: string): string | null {
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const res = getDb()
    .prepare(
      `INSERT INTO retainer_runs (run_id, retainer_id, scheduled_for, status, skip_reason, error, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (retainer_id, scheduled_for) DO NOTHING`,
    )
    .run(runId, retainerId, iso(scheduledFor), status, skip ?? null, error ?? null, iso(nowMs), status === "skipped" ? iso(nowMs) : null);
  if (res.changes !== 1) return null;
  if (status === "skipped") announce(runId, nowMs);
  return runId;
}

function finishRun(runId: string, fields: { status: string; skip?: SkipReason | null; error?: string | null; taskId?: string | null; priceWei?: bigint | null }, nowMs: number) {
  getDb()
    .prepare(
      `UPDATE retainer_runs SET status = ?, skip_reason = ?, error = ?, task_id = COALESCE(?, task_id),
         price_wei = COALESCE(?, price_wei), finished_at = ? WHERE run_id = ?`,
    )
    .run(
      fields.status,
      fields.skip ?? null,
      fields.error ?? null,
      fields.taskId ?? null,
      fields.priceWei != null ? fields.priceWei.toString() : null,
      fields.status === "running" ? null : iso(nowMs),
      runId,
    );
  if (fields.status !== "running") announce(runId, nowMs);
}

/** Every closed run reaches the owner's webhooks, from the one place every run closes. */
function announce(runId: string, nowMs: number) {
  const run = getDb()
    .prepare(`SELECT retainer_id, scheduled_for, status, skip_reason, error, task_id FROM retainer_runs WHERE run_id = ?`)
    .get(runId) as { retainer_id: string; scheduled_for: string; status: string; skip_reason: SkipReason | null; error: string | null; task_id: string | null } | undefined;
  if (!run) return;
  const r = getRetainer(run.retainer_id);
  if (!r) return;
  if (run.status === "completed") {
    const task = run.task_id ? getTaskById(run.task_id) : null;
    notify(r.retainerId, "retainer.run.completed", {
      retainerId: r.retainerId,
      runId,
      agentId: r.agentId,
      scheduledFor: run.scheduled_for,
      taskId: run.task_id,
      output: task?.output ?? null,
      receiptUrl: run.task_id ? receiptUrl(run.task_id) : null,
    }, nowMs);
  } else if ((run.status === "failed" || run.status === "skipped") && run.skip_reason !== "tier_pace") {
    // A slot held back to the tier's pace is expected, not news: it is in the history, not the webhook.
    notifyRunFailed(r, runId, run.scheduled_for, run.status, run.skip_reason, run.error, run.task_id, nowMs);
  }
}

function setRetainer(retainerId: string, fields: Record<string, string | number | null>, nowMs: number) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE retainers SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE retainer_id = ?`)
    .run(...keys.map((k) => fields[k]), iso(nowMs), retainerId);
}

function pause(retainerId: string, reason: PauseReason, nowMs: number) {
  setRetainer(retainerId, { status: "paused", pause_reason: reason }, nowMs);
  logger.info("retainer.paused", "Retainer paused itself", { retainerId, reason });
  const r = getRetainer(retainerId);
  if (r) notify(r.retainerId, "retainer.paused", { retainerId, agentId: r.agentId, reason, message: PAUSE_REASON_TEXT[reason] }, nowMs);
}

/** A failure against the owner's side of the run. Three in a row pause the retainer. */
function countFailure(retainerId: string, nowMs: number) {
  getDb().prepare(`UPDATE retainers SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE retainer_id = ?`).run(iso(nowMs), retainerId);
  const r = getRetainer(retainerId);
  if (r && r.status === "active" && r.consecutiveFailures >= FAILURES_BEFORE_PAUSE) pause(retainerId, "failures", nowMs);
}

/** Ended by its own terms: past its end date, or its runs used up. */
function endIfDone(r: Retainer, nowMs: number): boolean {
  const pastEnd = r.endsAt !== null && Date.parse(r.endsAt) <= nowMs;
  const usedUp = r.maxRuns !== null && r.runsDone >= r.maxRuns;
  if (!pastEnd && !usedUp) return false;
  setRetainer(r.retainerId, { status: "ended", next_run_at: null }, nowMs);
  return true;
}

/** The allowance's own words for an expiry (allowancePayment.ts and the contract's decoded error). */
const ALLOWANCE_EXPIRED = "Your allowance has expired";

export const FAILED_RUN_TEXT = "The agent could not finish this run. The payment went back to your allowance.";

/** When this retainer last hired its agent, other than the run being decided now. */
function lastHiredAt(retainerId: string, exceptRunId: string): number | null {
  const row = getDb()
    .prepare(`SELECT MAX(scheduled_for) AS at FROM retainer_runs WHERE retainer_id = ? AND task_id IS NOT NULL AND run_id != ?`)
    .get(retainerId, exceptRunId) as { at: string | null };
  return row.at ? Date.parse(row.at) : null;
}

/** Hire the agent for one run. Returns what happened, with the reason in words when it did not. */
async function hire(r: Retainer, runId: string, slotMs: number, nowMs: number): Promise<"hired" | "skipped"> {
  const agent = getAgentById(r.agentId);
  const listWei = agent?.price ? parsePaymentAmount(agent.price)?.wei ?? null : null;
  if (!agent || listWei === null) {
    finishRun(runId, { status: "skipped", skip: "agent_unavailable", error: "The agent no longer charges or no longer exists" }, nowMs);
    pause(r.retainerId, "agent_unavailable", nowMs);
    return "skipped";
  }
  // What this run costs: the agent's price less whatever it knocks off for a standing client.
  const priceWei = retainerPriceWei(listWei, agent.retainerDiscountBps ?? 0);
  const price = `${weiToDecimalString(priceWei)} ETH`;
  if (priceWei > r.maxPriceWei) {
    // Not the owner's failure and not the agent's: the price moved past what the owner agreed to.
    finishRun(runId, { status: "skipped", skip: "price_above_max", priceWei }, nowMs);
    return "skipped";
  }

  const { tier } = await getTier(r.ownerWallet);
  if (!tierPaceAllows(r.schedule, tier.name, lastHiredAt(r.retainerId, runId), slotMs)) {
    // The owner sold below this schedule's tier. Not a failure: the retainer carries on at the tier's pace.
    finishRun(runId, { status: "skipped", skip: "tier_pace" }, nowMs);
    return "skipped";
  }

  const task = createTask({
    fromAgent: r.ownerWallet,
    toAgent: r.agentId,
    task: r.instructions,
    payment: price,
    queueQueuedWebhook: false,
    initialStatus: "payment_pending",
    priority: tier.rank,
  });

  try {
    const quoteId = r.payIn === "AXON" ? await freshAxonQuoteFor(r.agentId, priceWei) : undefined;
    await payFromAllowance({
      taskId: task.taskId,
      fromAgent: r.ownerWallet,
      toAgent: r.agentId,
      owner: r.ownerWallet,
      priceString: price,
      quoteId,
      apiKeyId: r.apiKeyId ?? undefined,
    });
  } catch (err) {
    getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
    const refused = err instanceof AllowancePaymentError && err.status !== 503;
    const message = err instanceof AllowancePaymentError ? err.message : "The payment could not be made right now";
    // A refusal is the owner's side (limits, balance, expiry); an outage on ours, gas included, is not
    // held against them and says so.
    finishRun(runId, { status: "skipped", skip: refused ? "allowance_refused" : "payment_unavailable", error: message, priceWei }, nowMs);
    if (refused && message === ALLOWANCE_EXPIRED) pause(r.retainerId, "allowance_expired", nowMs);
    else if (refused) countFailure(r.retainerId, nowMs);
    else logger.warn("retainer.payment_unavailable", "Retainer run could not pay", { err, retainerId: r.retainerId });
    return "skipped";
  }

  if (!markTaskPaymentConfirmed(task.taskId)) {
    finishRun(runId, { status: "failed", error: "The payment could not be confirmed", taskId: task.taskId, priceWei }, nowMs);
    countFailure(r.retainerId, nowMs);
    return "skipped";
  }
  finishRun(runId, { status: "running", taskId: task.taskId, priceWei }, nowMs);
  getDb().prepare(`UPDATE retainers SET runs_done = runs_done + 1, updated_at = ? WHERE retainer_id = ?`).run(iso(nowMs), r.retainerId);
  return "hired";
}

/** Run every retainer whose slot has come. Safe to call from any number of workers at once. */
export async function runDueRetainers(nowMs = Date.now(), limit = 50): Promise<RunTickResult> {
  const result: RunTickResult = { due: 0, hired: 0, skipped: 0, ended: 0 };
  const ids = getDb()
    .prepare(`SELECT retainer_id FROM retainers WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at LIMIT ?`)
    .all(iso(nowMs), limit) as { retainer_id: string }[];

  for (const { retainer_id } of ids) {
    const r = getRetainer(retainer_id);
    if (!r || r.status !== "active" || !r.nextRunAt) continue;
    result.due++;
    try {
      if (endIfDone(r, nowMs)) {
        result.ended++;
        continue;
      }
      const anchor = Date.parse(r.anchorAt);
      let slot = Date.parse(r.nextRunAt);
      if (nowMs - slot > ON_TIME_WINDOW_MS) {
        // Downtime: the slot we were due is gone. Record it as missed and run the latest one instead.
        const latest = latestSlot(r.schedule, anchor, nowMs) ?? slot;
        if (latest !== slot) claimSlot(r.retainerId, slot, "skipped", nowMs, "missed");
        slot = latest;
        if (nowMs - slot > ON_TIME_WINDOW_MS) {
          // Even the latest slot is too old to count as on time (a daily run, hours late): skip it too.
          claimSlot(r.retainerId, slot, "skipped", nowMs, "missed");
          setRetainer(r.retainerId, { next_run_at: iso(nextSlot(r.schedule, anchor, nowMs)) }, nowMs);
          result.skipped++;
          continue;
        }
      }

      // Move on before hiring: a crash from here on leaves the retainer pointing at its next slot.
      setRetainer(r.retainerId, { next_run_at: iso(nextSlot(r.schedule, anchor, slot + 1)) }, nowMs);
      const runId = claimSlot(r.retainerId, slot, "pending", nowMs);
      if (!runId) continue; // another worker has this slot

      const keyLimits = r.apiKeyId ? getKeyLimits(r.apiKeyId) : null;
      if (r.apiKeyId && !keyLimits) {
        finishRun(runId, { status: "skipped", skip: "allowance_refused", error: "The key that created this retainer was revoked" }, nowMs);
        pause(r.retainerId, "key_revoked", nowMs);
        result.skipped++;
        continue;
      }
      if (keyLimits && Date.parse(keyLimits.expiresAt) <= nowMs) {
        // Stop at once rather than be refused three times: nothing will change until the owner acts.
        finishRun(runId, { status: "skipped", skip: "allowance_refused", error: "The key that created this retainer has expired" }, nowMs);
        pause(r.retainerId, "key_expired", nowMs);
        result.skipped++;
        continue;
      }
      if (agentUnavailable(r.agentId)) {
        finishRun(runId, { status: "skipped", skip: "agent_unavailable" }, nowMs);
        pause(r.retainerId, "agent_unavailable", nowMs);
        result.skipped++;
        continue;
      }
      if (getDb().prepare(`SELECT 1 FROM retainer_runs WHERE retainer_id = ? AND run_id != ? AND status IN ('pending', 'running') LIMIT 1`).get(r.retainerId, runId)) {
        finishRun(runId, { status: "skipped", skip: "previous_run_in_flight" }, nowMs);
        result.skipped++;
        continue;
      }

      const outcome = await hire(r, runId, slot, nowMs);
      result[outcome === "hired" ? "hired" : "skipped"]++;
      const after = getRetainer(r.retainerId);
      if (after && after.status === "active" && endIfDone(after, nowMs)) result.ended++;
    } catch (err) {
      logger.error("retainer.run_failed", "A retainer run threw", { err, retainerId: r.retainerId });
    }
  }
  if (result.due > 0) void syncToTurso();
  return result;
}

/**
 * Close runs whose work has ended. Completed work clears the failure count; failed work adds to it.
 * Runs whose task vanished (rolled back elsewhere) are closed as failed rather than left in flight
 * forever, which would block every later run.
 */
export function settleRetainerRuns(nowMs = Date.now()): { completed: number; failed: number } {
  const open = getDb()
    .prepare(`SELECT run_id, retainer_id, task_id FROM retainer_runs WHERE status = 'running' AND task_id IS NOT NULL`)
    .all() as { run_id: string; retainer_id: string; task_id: string }[];
  let completed = 0;
  let failed = 0;
  for (const run of open) {
    const task = getTaskById(run.task_id);
    if (task && task.status === "completed") {
      finishRun(run.run_id, { status: "completed" }, nowMs);
      setRetainer(run.retainer_id, { consecutive_failures: 0 }, nowMs);
      completed++;
    } else if (!task || task.status === "failed") {
      // In the owner's words, not the provider's: a raw model error says nothing useful to them and can
      // expose how Axon runs agents. The task itself keeps the detail.
      finishRun(run.run_id, { status: "failed", error: task ? FAILED_RUN_TEXT : "The run's task is gone" }, nowMs);
      countFailure(run.retainer_id, nowMs);
      failed++;
    }
  }
  if (completed + failed > 0) void syncToTurso();
  return { completed, failed };
}

/** Pending runs are claimed and resolved in the same tick; one left behind means the process died mid-hire. */
export function sweepStrandedRuns(nowMs = Date.now(), olderThanMs = 10 * 60_000): number {
  const res = getDb()
    .prepare(`UPDATE retainer_runs SET status = 'failed', error = 'Interrupted before it could hire', finished_at = ? WHERE status = 'pending' AND created_at < ?`)
    .run(iso(nowMs), iso(nowMs - olderThanMs));
  return res.changes;
}

