// Agents that run their own business: hiring help for part of a job.
//
// When the business took a job it judged would need a specialist for part of it (./businessWork, "help"), and its
// owner lets it hire, the worker runs that job the way it runs an orchestrator's (./orchestrator): the agent splits the
// job, hires a specialist for each part, and puts the answer together. Every hire is an ordinary job with its own
// receipt, linked to the parent job as a subcontract, so the parent's receipt shows who did what.
//
// What the business adds is who may be hired and how each hire is paid:
//
//   Only verified agents (their owner signed in with their wallet), never itself, and never another agent of the same
//   owner: paying your own agents is not a cost of the business, only money moving around.
//
//   Every hire asks the business's limits first (./businessLimits): the kind, the job, the day, the budget. One above
//   the owner's amount waits for their OK, in the dashboard's approvals, for a few minutes
//   (businessCaps().approvalWaitMinutes); with no answer, the job goes on without that part and the request is
//   cancelled.
//
//   It pays from what the agent earned, as any orchestrator does (createHiredTask). When its earnings do not cover a
//   hire and its owner picked an allowance key, the hire is paid from the owner's allowance instead, the way a hire
//   from Claude or Cursor is (payFromAllowance), within that key's own limits and the contract's.
//
// Each hire is a line in the ledger, under the job it was for. A hire that fails and is refunded is voided by the
// books pass (syncHires), so it no longer counts against any limit.

import { getDb } from "./db";
import { logger } from "./logger";
import { sameAddress } from "./address";
import { isOwnerVerified } from "./ownerVerification";
import { createTask, markTaskPaymentConfirmed, type Task } from "./tasks";
import { createHiredTask } from "./planner";
import { refundPayment } from "./payments";
import { payFromAllowance, type AllowanceHire, type AllowancePaid } from "./allowancePayment";
import { parsePaymentAmount, formatEth } from "./money";
import { liveLog } from "./liveLog";
import { approvalStatus, cancelApproval, requestSpendApproval, takeApproved, BUSINESS_APP } from "./appPermissions";
import { businessCaps, businessEnabled, type BusinessCaps } from "./businessPolicy";
import { decide, getBusiness, type Business } from "./business";
import { checkSpend } from "./businessLimits";
import { record, voidEntry } from "./businessLedger";
import { businessJobOf, canLead } from "./businessWork";
import type { OrchestrationOptions } from "./orchestrator";
import type { Agent } from "@/sdk/types";

export type Pay = (h: AllowanceHire) => Promise<AllowancePaid>;

export interface HireDeps {
  pay?: Pay;
  /** how long one hire waits for the owner's OK, and how often it looks */
  waitMs?: number;
  pollMs?: number;
  caps?: BusinessCaps;
}

/** Who a business may hire: verified agents of other owners, never itself. */
export function mayHire(b: Business, self: Agent, worker: Agent): boolean {
  if (worker.agentId === self.agentId) return false;
  if (!worker.walletAddress || sameAddress(worker.walletAddress, b.ownerWallet)) return false;
  return isOwnerVerified(worker.agentId);
}

/** Pay a hire from the owner's allowance: an ordinary paid job, or a throw with the allowance's reason. */
async function hireFromAllowance(b: Business, from: Agent, worker: Agent, task: string, context: Record<string, unknown> | undefined, pay: Pay): Promise<{ taskId: string; price: string | null }> {
  const t = createTask({ fromAgent: from.agentId, toAgent: worker.agentId, task, context, payment: worker.price, queueQueuedWebhook: false, initialStatus: "payment_pending" });
  try {
    await pay({ taskId: t.taskId, fromAgent: from.agentId, toAgent: worker.agentId, owner: b.ownerWallet, priceString: worker.price!, apiKeyId: b.limits.allowanceKeyId! });
  } catch (err) {
    getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(t.taskId);
    throw new Error(`the allowance did not pay: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!markTaskPaymentConfirmed(t.taskId)) {
    refundPayment(t.taskId);
    getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(t.taskId);
    throw new Error("the payment could not be confirmed and was returned");
  }
  return { taskId: t.taskId, price: worker.price ?? null };
}

/** Ask the owner and wait. True only when they said yes and the yes was taken, once. */
async function askOwner(b: Business, self: Agent, parent: Task, worker: Agent, part: string, wei: bigint, deps: HireDeps): Promise<boolean> {
  const caps = deps.caps ?? businessCaps();
  const waitMs = deps.waitMs ?? caps.approvalWaitMinutes * 60_000;
  const pollMs = deps.pollMs ?? 5_000;
  const from = b.limits.allowanceKeyId ? "its earnings, or your allowance when they fall short" : "its earnings";
  let id: string;
  try {
    id = requestSpendApproval({
      ownerWallet: b.ownerWallet, agentId: self.agentId, taskId: parent.taskId,
      title: `Hire ${worker.name} for ${formatEth(wei)}`,
      preview: `${self.name} wants to hire ${worker.name} for part of a job it is doing for its business, for ${formatEth(wei)} from ${from}.\n\nThe part:\n${part.slice(0, 2_000)}`,
      payload: { kind: "hire", businessId: b.businessId, parentTaskId: parent.taskId, toAgent: worker.agentId, wei: wei.toString(), part: part.slice(0, 2_000) },
    }).approvalId;
  } catch (err) {
    decide(b.businessId, "refuse", `Could not ask you about hiring ${worker.name}: ${err instanceof Error ? err.message : String(err)}`, { subject: parent.taskId });
    return false;
  }
  decide(b.businessId, "ask", `Asked your OK to hire ${worker.name} for ${formatEth(wei)}, above the ${formatEth(b.limits.approveAboveWei)} you approve yourself`, { subject: parent.taskId, detail: { approvalId: id, receipt: `/r/${parent.taskId}` } });
  liveLog(parent.taskId).say(`Waiting for the owner's OK to hire ${worker.name}`);
  const until = Date.now() + waitMs;
  for (;;) {
    const s = approvalStatus(id);
    if (s === "approved") {
      const taken = takeApproved(id, { ownerWallet: b.ownerWallet, agentId: self.agentId, appId: BUSINESS_APP });
      decide(b.businessId, taken ? "approved" : "declined", taken ? `You approved hiring ${worker.name}` : `Your OK for ${worker.name} could not be used`, { subject: parent.taskId });
      return Boolean(taken);
    }
    if (s !== "pending") {
      decide(b.businessId, "declined", s === "declined" ? `You said no to hiring ${worker.name}: it does that part itself` : `The request to hire ${worker.name} ${s ?? "is gone"}`, { subject: parent.taskId });
      return false;
    }
    if (Date.now() >= until) {
      cancelApproval(id);
      decide(b.businessId, "declined", `No answer about ${worker.name} in time: the job went on without that part`, { subject: parent.taskId });
      liveLog(parent.taskId).say(`No answer in time. Going on without ${worker.name}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** One hire for a business's job, through its limits, paid from earnings or the allowance. Throws to skip the part. */
export function hireFor(b: Business, self: Agent, parent: Task, deps: HireDeps = {}) {
  return async (worker: Agent, part: string, context?: Record<string, unknown>): Promise<{ taskId: string; price: string | null }> => {
    const fresh = getBusiness(b.businessId) ?? b;
    const wei = worker.price ? parsePaymentAmount(worker.price)?.wei ?? 0n : 0n;
    if (wei > 0n) {
      let verdict = checkSpend(fresh, { kind: "hire", wei, jobRef: parent.taskId });
      if (!verdict.ok && verdict.ask) {
        if (!(await askOwner(fresh, self, parent, worker, part, wei, deps))) throw new Error("the owner did not approve it");
        verdict = checkSpend(getBusiness(b.businessId) ?? fresh, { kind: "hire", wei, jobRef: parent.taskId, approved: true });
      }
      if (!verdict.ok) {
        decide(b.businessId, "refuse", `Did not hire ${worker.name}: ${verdict.why}`, { subject: parent.taskId });
        throw new Error(verdict.why);
      }
    }
    let hire: { taskId: string; price: string | null };
    let paidBy = "its earnings";
    try {
      hire = createHiredTask(self.agentId, worker.agentId, part, context);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!(wei > 0n && fresh.limits.allowanceKeyId && /Insufficient balance/i.test(why))) {
        decide(b.businessId, "refuse", `Did not hire ${worker.name}: ${why}`, { subject: parent.taskId });
        throw err;
      }
      try {
        hire = await hireFromAllowance(fresh, self, worker, part, context, deps.pay ?? payFromAllowance);
        paidBy = "your allowance";
      } catch (e) {
        decide(b.businessId, "refuse", `Did not hire ${worker.name}: its earnings fall short and ${e instanceof Error ? e.message : String(e)}`, { subject: parent.taskId });
        throw e;
      }
    }
    if (wei > 0n) record(b.businessId, { kind: "hire", amountWei: wei, ref: hire.taskId, jobRef: parent.taskId, note: `${worker.name}: ${part.slice(0, 100)}` });
    decide(b.businessId, "hire", `Hired ${worker.name}${wei > 0n ? ` for ${formatEth(wei)}, paid from ${paidBy}` : " (free)"}`, { subject: parent.taskId, detail: { child: hire.taskId, toAgent: worker.agentId, receipt: `/r/${hire.taskId}`, parentReceipt: `/r/${parent.taskId}` } });
    logger.info("business.hired", "A business hired help for part of a job", { businessId: b.businessId, parentTaskId: parent.taskId, childTaskId: hire.taskId, paidBy });
    return hire;
  };
}

/**
 * For the worker: the team options when this job is a business job that is run as a team, or null for every other job.
 * Cheap and quiet while businesses are off.
 */
export function businessTeam(agent: Agent, task: Task, deps: HireDeps = {}): OrchestrationOptions | null {
  if (!businessEnabled()) return null;
  try {
    const job = businessJobOf(task.taskId);
    if (!job?.team) return null;
    const b = getBusiness(job.businessId);
    if (!b || b.status !== "active" || !b.limits.kinds.includes("hire") || !canLead(agent)) return null;
    return { accept: (w) => mayHire(b, agent, w), hire: hireFor(b, agent, task, deps) };
  } catch (err) {
    logger.warn("business.team_failed", "Could not read whether a job runs as a team", { taskId: task.taskId, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Hires that were refunded (the specialist failed) are voided, so they no longer count. */
export function syncHires(b: Business): number {
  const rows = getDb().prepare(
    `SELECT l.ref FROM business_ledger l WHERE l.business_id = ? AND l.kind = 'hire' AND l.voided_at IS NULL
       AND EXISTS (SELECT 1 FROM transactions t WHERE t.task_id = l.ref AND t.status = 'refunded')
       AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.task_id = l.ref AND t.status IN ('completed', 'escrow'))`,
  ).all(b.businessId) as { ref: string }[];
  let n = 0;
  for (const r of rows) {
    if (voidEntry(b.businessId, "hire", r.ref)) {
      n++;
      decide(b.businessId, "refuse", "A hire did not deliver and its payment came back: it no longer counts", { subject: r.ref, once: `void:${r.ref}`, detail: { receipt: `/r/${r.ref}` } });
    }
  }
  return n;
}
