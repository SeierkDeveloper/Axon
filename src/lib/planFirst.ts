// Work with your agent: plan first.
//
// On a job that matters, people want to see what will be done before it is done. A hire that says so (`planFirst`)
// stops before any work: the agent writes a short plan, the job waits, and the person approves it, asks for a
// change, or cancels. Approved, the same job goes on and the agent is held to the plan. Cancelled, nothing was done:
// whatever was paid is refunded, and the job counts neither for nor against the agent.
//
// The price is the agent's price, shown with the plan. It was paid when the job was hired and is held, as every
// payment is until the work is delivered, so approving spends it and cancelling returns it.
//
// A plan does not hold a job for ever: with no answer in time the job goes on with the plan as written. Off until
// AGENT_PLAN=on.

import { getDb } from "./db";
import { getTaskById, type Task } from "./tasks";
import { refundPayment } from "./payments";
import { refundDebitForTask } from "./mpp";
import { emitAxonEvent } from "./eventBus";
import { syncToTurso } from "./db-turso";
import { safeAppendTraceEvent, hashContent } from "./traceEvents";
import { logger } from "./logger";
import { waitMinutes } from "./ask";

type Env = Record<string, string | undefined>;

export function planEnabled(env: Env = process.env): boolean {
  return (env.AGENT_PLAN ?? "off").trim().toLowerCase() === "on";
}

/** How many times the person may ask for the plan to be changed. */
export function maxChanges(env: Env = process.env): number {
  const n = Number(env.AXON_PLAN_MAX_CHANGES);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 3;
}

/** The key in a hire's context that asks for a plan first. Set from `planFirst` on the hire, never directly. */
export const PLAN_KEY = "planFirst";
export const PLAN_CHARS = 6_000;
export const CHANGE_CHARS = 2_000;
/** A plan is short: this is all the room the agent gets to write one. */
export const PLAN_MAX_TOKENS = 900;
export const CANCELLED = "Cancelled by the person who hired it, before any work started.";

export type PlanOutcome = "approved" | "changed" | "cancelled" | "timeout";
export interface Plan { n: number; text: string; madeAt: string; answerBy: string; outcome?: PlanOutcome; change?: string; answeredAt?: string }
interface Row { n: number; question: string; asked_at: string; answer_by: string; answer: string | null; answered_at: string | null; answered_how: string | null }
const OUTCOMES: PlanOutcome[] = ["approved", "changed", "cancelled", "timeout"];
const view = (r: Row): Plan => ({
  n: r.n, text: r.question, madeAt: r.asked_at, answerBy: r.answer_by,
  ...(r.answered_at ? { outcome: OUTCOMES.includes(r.answered_how as PlanOutcome) ? (r.answered_how as PlanOutcome) : "timeout", ...(r.answer ? { change: r.answer } : {}), answeredAt: r.answered_at } : {}),
});

/** Every plan a job has had, in order. A changed plan is followed by the next one. */
export function plansOf(taskId: string): Plan[] {
  return (getDb().prepare("SELECT n, question, asked_at, answer_by, answer, answered_at, answered_how FROM task_questions WHERE task_id = ? AND kind = 'plan' ORDER BY n ASC").all(taskId) as Row[]).map(view);
}

/** The plan a job is waiting on, if it is waiting on one. */
export const openPlan = (taskId: string): Plan | null => plansOf(taskId).find((p) => !p.answeredAt) ?? null;

/** An agent Axon runs itself can be asked for a plan. One that hires specialists, or runs behind an MCP server, cannot. */
export const plannable = (agent: { orchestrator?: boolean }, o: { viaMcp?: boolean } = {}): boolean => !agent.orchestrator && !o.viaMcp;

/**
 * Where a job that asked for a plan first stands when a run picks it up: "plan" (write the plan, or write it again
 * with the change asked for), "wait" (a plan is out and unanswered: the job should be waiting, not running), "work"
 * (the plan is approved: do the job). Null for a job that never asked for a plan, or whose agent cannot write one.
 */
export function planStage(task: Pick<Task, "taskId" | "context">, agent: { orchestrator?: boolean }, o: { viaMcp?: boolean; env?: Env } = {}): "plan" | "wait" | "work" | null {
  if (!planEnabled(o.env) || task.context?.[PLAN_KEY] !== true || !plannable(agent, o)) return null;
  const last = plansOf(task.taskId).at(-1);
  if (!last) return "plan";
  if (!last.answeredAt) return "wait";
  return last.outcome === "changed" ? "plan" : "work";
}

/** What the agent is told, after the job itself, when it is to write a plan and not do the work. */
export function planNote(had: Plan[]): string {
  const last = had.at(-1);
  const again = last?.outcome === "changed"
    ? `\n\nYour earlier plan:\n${last.text}\n\nThe person asked for this change:\n${last.change ?? ""}\n\nWrite the whole plan again with that change made.`
    : "";
  return `\n\nThe person wants to see your plan before you start. Do not do the job yet, and do not write the result. Write only the plan, for them to approve, short and plain:
1. What you will do, as three to six numbered steps.
2. What they get back at the end: the answer, and any files by name.
3. Anything you are assuming, in a line or two, so they can correct it.
Under 150 words. No greeting and no closing line.${again}`;
}

/** What the agent is told when the plan is approved and the work begins. Empty for a job with no approved plan. */
export function approvedNote(taskId: string): string {
  const last = plansOf(taskId).at(-1);
  if (!last || (last.outcome !== "approved" && last.outcome !== "timeout")) return "";
  const how = last.outcome === "approved" ? "The person approved this plan for the job. Follow it:" : "You wrote this plan for the job. The person did not answer in time, so go on with it as written:";
  return `\n\n${how}\n\n${last.text}\n\nNow do the job. What the plan assumes is settled with it: do not stop to ask about that. Do not show the plan again.`;
}

/** Keep the plan a run has written. The job then waits on it. */
export function keepPlan(taskId: string, text: string, o: { now?: number; env?: Env } = {}): Plan {
  const now = o.now ?? Date.now(), n = plansOf(taskId).length + 1;
  const plan = text.trim().slice(0, PLAN_CHARS);
  const madeAt = new Date(now).toISOString(), answerBy = new Date(now + waitMinutes(o.env) * 60_000).toISOString();
  getDb().prepare("INSERT INTO task_questions (task_id, kind, n, question, asked_at, answer_by) VALUES (?,'plan',?,?,?,?)").run(taskId, n, plan, madeAt, answerBy);
  return { n, text: plan, madeAt, answerBy };
}

const say = (task: Task, status: string): void => emitAxonEvent({ type: "task.updated", data: { taskId: task.taskId, status, agentId: task.toAgent, fromAgent: task.fromAgent } });

/** A plan is out: the job waits. False when the job is not running or has no open plan. */
export function parkForPlan(taskId: string): boolean {
  if (!openPlan(taskId)) return false;
  if (!getDb().prepare("UPDATE tasks SET status = 'waiting' WHERE task_id = ? AND status = 'running'").run(taskId).changes) return false;
  say(getTaskById(taskId)!, "waiting");
  void syncToTurso();
  logger.info("plan.waiting", "A job is waiting for its plan to be approved", { taskId });
  return true;
}

export type PlanAction = "approve" | "change" | "cancel";
export type PlanRefusal = "not_waiting" | "empty" | "too_long" | "no_changes_left";
export type PlanDecision = { ok: true; task: Task; plan: Plan } | { ok: false; refused: PlanRefusal; reason: string };

/**
 * What the person decides about the plan a job is waiting on. Approved (or, with `how: "timeout"`, unanswered for
 * too long), the job is queued to do the work. Changed, it is queued to write the plan again. Cancelled, the job
 * ends there: whatever was paid for it is refunded, and it counts neither for nor against the agent.
 */
export function decidePlan(taskId: string, action: PlanAction, change: string | null = null, how: "person" | "timeout" = "person", o: { now?: number; env?: Env } = {}): PlanDecision {
  const no = (refused: PlanRefusal, reason: string): PlanDecision => ({ ok: false, refused, reason });
  const text = (change ?? "").trim();
  if (action === "change") {
    if (!text) return no("empty", "Say what should be changed.");
    if (text.length > CHANGE_CHARS) return no("too_long", `Keep the change under ${CHANGE_CHARS.toLocaleString("en-US")} characters.`);
  }
  const db = getDb(), at = new Date(o.now ?? Date.now()).toISOString();
  const outcome: PlanOutcome = action === "cancel" ? "cancelled" : action === "change" ? "changed" : how === "timeout" ? "timeout" : "approved";
  const done = db.transaction((): { n: number } | PlanRefusal => {
    const open = db.prepare("SELECT n FROM task_questions WHERE task_id = ? AND kind = 'plan' AND answered_at IS NULL ORDER BY n ASC LIMIT 1").get(taskId) as { n: number } | undefined;
    if (!open) return "not_waiting";
    if (action === "change") {
      const changed = (db.prepare("SELECT COUNT(*) c FROM task_questions WHERE task_id = ? AND kind = 'plan' AND answered_how = 'changed'").get(taskId) as { c: number }).c;
      if (changed >= maxChanges(o.env)) return "no_changes_left";
    }
    const moved = action === "cancel"
      ? db.prepare("UPDATE tasks SET status = 'cancelled', error = ?, completed_at = ? WHERE task_id = ? AND status = 'waiting'").run(CANCELLED, at, taskId).changes
      // back into the queue, its wait counted from now: the time spent waiting on a person is not the queue's
      : db.prepare("UPDATE tasks SET status = 'queued', started_at = NULL, started_by = NULL, requeued_at = ? WHERE task_id = ? AND status = 'waiting'").run(at, taskId).changes;
    if (!moved) return "not_waiting";
    db.prepare("UPDATE task_questions SET answer = ?, answered_at = ?, answered_how = ? WHERE task_id = ? AND kind = 'plan' AND n = ?").run(action === "change" ? text : null, at, outcome, taskId, open.n);
    return open;
  })();
  if (done === "not_waiting") return no("not_waiting", "This job is not waiting on a plan.");
  if (done === "no_changes_left") return no("no_changes_left", "This plan has been changed as often as it can be. Approve it, or cancel the job.");
  if (typeof done === "string") return no("not_waiting", "This job is not waiting on a plan.");

  const task = getTaskById(taskId)!;
  if (action === "cancel") {
    // nothing was delivered: what paid for the job goes back, as it does for a job that fails
    refundPayment(taskId);
    refundDebitForTask(taskId);
  }
  // on the record what became of the plan, and a hash of the change asked for: never the words
  safeAppendTraceEvent({
    traceId: task.traceId ?? task.taskId, taskId, kind: "progress", fromAgent: task.fromAgent, toAgent: task.toAgent,
    workflowId: task.workflowId ?? null, stepIndex: task.stepIndex ?? null,
    inputHash: action === "change" ? hashContent(text) : null,
    meta: { plan: done.n, outcome },
  });
  say(task, task.status);
  void syncToTurso();
  return { ok: true, task, plan: plansOf(taskId).find((p) => p.n === done.n)! };
}

/** Jobs whose plan has waited long enough go on with the plan as written. Returns how many. */
export function approveOverdue(now = Date.now()): number {
  const due = getDb().prepare(
    `SELECT DISTINCT q.task_id FROM task_questions q JOIN tasks t ON t.task_id = q.task_id
     WHERE q.kind = 'plan' AND q.answered_at IS NULL AND q.answer_by <= ? AND t.status = 'waiting'`,
  ).all(new Date(now).toISOString()) as { task_id: string }[];
  let resumed = 0;
  for (const { task_id } of due) if (decidePlan(task_id, "approve", null, "timeout", { now }).ok) resumed++;
  if (resumed) logger.info("plan.resumed_unanswered", "Jobs went on with their plan unanswered", { resumed });
  return resumed;
}

/**
 * What a reader of a job is told about its plan: the plan it is waiting on, with the price and how many changes are
 * left, and every plan it has had. Nothing while plan first is off or the job never had a plan.
 */
export function planView(task: Pick<Task, "taskId" | "status" | "payment">, env: Env = process.env): { plan?: Plan & { price: string | null; changesLeft: number }; plans?: Plan[] } {
  if (!planEnabled(env)) return {};
  const all = plansOf(task.taskId);
  if (!all.length) return {};
  const open = task.status === "waiting" ? all.find((p) => !p.answeredAt) : undefined;
  const changesLeft = Math.max(0, maxChanges(env) - all.filter((p) => p.outcome === "changed").length);
  return { ...(open ? { plan: { ...open, price: task.payment ?? null, changesLeft } } : {}), plans: all };
}
