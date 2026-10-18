// Agents that hire people: what the worker does once a minute while AGENT_PEOPLE is on.
//
//   1. Tasks an agent asked its owner's OK for: opened when the owner said yes (the payment is locked then), closed when
//      they said no or the request ran out.
//   2. The clock (./people moveClock): people whose time ran out are let go, tasks past their time close and their
//      payment comes back, reviews an owner left unanswered pay the person.
//   3. Proofs not checked yet are checked (./peopleCheck); a check normally runs the moment a proof is handed in, this
//      catches any that a restart cut short.
//   4. Payouts (./peoplePay): accepted tasks are paid, unused owner payments go back.
//   5. A business's books: a task it posted is a line in its ledger once its payment is locked, voided if it came back.
//
// Nothing here throws into the worker.

import { getDb } from "./db";
import { logger } from "./logger";
import { approvalStatus, takeApproved, BUSINESS_APP } from "./appPermissions";
import { peopleCaps, peopleEnabled } from "./peoplePolicy";
import { closeTask, getPeopleTask, moveClock, openApproved } from "./people";
import { checkProof, realProofJudge, type ProofJudge } from "./peopleCheck";
import { runPayouts, type PayDeps } from "./peoplePay";
import { record, voidEntry, hasEntry } from "./businessLedger";
import { decide, getBusiness } from "./business";

export interface PeopleTickDeps extends PayDeps { proof?: ProofJudge }
export interface PeopleTick { opened: number; refused: number; timedOut: number; expired: number; paidOnSilence: number; checked: number; sent: number }

/** Tasks waiting for their owner's OK: open the approved, close the rest. */
export function settleApprovals(nowMs = Date.now()): { opened: number; refused: number } {
  const out = { opened: 0, refused: 0 };
  const rows = getDb().prepare("SELECT task_id FROM people_tasks WHERE status = 'approval' AND approval_id IS NOT NULL LIMIT 100").all() as { task_id: string }[];
  for (const { task_id } of rows) {
    const t = getPeopleTask(task_id);
    if (!t?.approvalId) continue;
    const s = approvalStatus(t.approvalId, nowMs);
    if (s === "approved") {
      const taken = takeApproved(t.approvalId, { ownerWallet: t.ownerWallet, agentId: t.agentId, appId: BUSINESS_APP }, nowMs);
      if (taken && openApproved(task_id, nowMs).ok) out.opened++;
      else if (!taken) { closeTask(t, "cancelled", "The owner's OK could not be used", nowMs); out.refused++; }
      else out.refused++;
    } else if (s !== "pending") {
      closeTask(t, "cancelled", s === "declined" ? "The owner said no" : `The request for the owner's OK ${s ?? "is gone"}`, nowMs);
      if (t.businessId) decide(t.businessId, "declined", s === "declined" ? `You said no to hiring a person for "${t.title.slice(0, 80)}"` : `No answer about hiring a person for "${t.title.slice(0, 80)}"`, { subject: t.parentTaskId ?? task_id });
      out.refused++;
    }
  }
  return out;
}

/** A business's tasks for people in its books: a line once the payment is locked, voided if it came back unused. */
export function syncBusinessBooks(): number {
  let n = 0;
  const rows = getDb().prepare("SELECT task_id, business_id, price_wei, lock_state, parent_task_id, title, created_at FROM people_tasks WHERE business_id IS NOT NULL AND lock_state IN ('held', 'paid', 'returned') ORDER BY created_at DESC LIMIT 300").all() as Record<string, string | null>[];
  for (const r of rows) {
    const bid = String(r.business_id), ref = String(r.task_id);
    if (!getBusiness(bid)) continue;
    if (r.lock_state === "returned") {
      if (voidEntry(bid, "hire", ref)) {
        n++;
        decide(bid, "refuse", "A task for people was not done and its payment came back: it no longer counts", { subject: ref, once: `people-void:${ref}` });
      }
    } else if (!hasEntry(bid, "hire", ref)) {
      record(bid, { kind: "hire", amountWei: BigInt(String(r.price_wei)), ref, jobRef: r.parent_task_id ?? null, note: `A person: ${String(r.title).slice(0, 90)}`, atMs: Date.parse(String(r.created_at)) });
      n++;
    }
  }
  return n;
}

export async function runPeopleTick(nowMs = Date.now(), deps: PeopleTickDeps = {}): Promise<PeopleTick> {
  const out: PeopleTick = { opened: 0, refused: 0, timedOut: 0, expired: 0, paidOnSilence: 0, checked: 0, sent: 0 };
  if (!peopleEnabled()) return out;
  const caps = deps.caps ?? peopleCaps();
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      logger.warn("people.tick_step_failed", "A step of the people tick failed", { step: name, reason: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };
  const a = await step("approvals", () => settleApprovals(nowMs));
  if (a) Object.assign(out, a);
  const c = await step("clock", () => moveClock(nowMs, { caps }));
  if (c) Object.assign(out, c);
  const due = getDb().prepare("SELECT task_id FROM people_tasks WHERE status = 'delivered' AND updated_at <= ? LIMIT 10").all(new Date(nowMs - 60_000).toISOString()) as { task_id: string }[];
  for (const { task_id } of due) {
    const v = await step("check", () => checkProof(task_id, deps.proof ?? realProofJudge(caps), { caps, nowMs }));
    if (v) out.checked++;
  }
  const p = await step("payouts", () => runPayouts({ ...deps, caps, nowMs }));
  if (p) out.sent = p.sent;
  await step("books", () => syncBusinessBooks());
  return out;
}
