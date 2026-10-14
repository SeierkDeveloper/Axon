// Autonomy 3, "no job dies": a job that fails is moved to the next best agent instead of ending there.
//
// Until now a failed job was failed and, when paid, refunded, and the person who hired it was left with an error.
// Now, right after that (the refund still happens: a moved job is free to its hirer), the job is handed to another
// agent that can do the same work: one that offers most of the same skills, runs on Axon itself, is free, and is
// not failing too. The hire box follows the job to its new agent (the job's view says where it went, lib/autonomy3Rescue
// rescueView), so the person sees an answer instead of an error.
//
// What it never does:
//   - move a job twice: a moved job that fails again is failed (the record of the move is the guard, migration 127)
//   - move a job an agent turned down as not allowed (refused, declined): another agent is not a way around a refusal
//   - move a job its hirer stopped or left, a step of a workflow or quorum, a follow-up, a job one agent gave
//     another (the hiring agent handles that), or the network's own demonstration and test jobs
//   - take money: the rescuer is a free agent and the move is never paid; any payment was refunded as before
// Ceilings: so a broken agent cannot turn into free work without end, at most RESCUE.perAgentPerDay of one agent's
// failures are moved a day, and RESCUE.perDay in all. Past them a failure ends as it always did. Nothing switches off.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { createTask, getTaskById, type Task } from "./tasks";
import { getAgentById } from "./agents";
import { rankAgents } from "./routing";
import { claimTokenFor } from "./claimToken";
import { logger } from "./logger";
import { partOn } from "./autonomy3Policy";
import { claimJob, finishJob, jobFor, onTick, type TickContext } from "./autonomy3";
import type { Agent } from "@/sdk/types";

type Env = Record<string, string | undefined>;

export const RESCUE = {
  /** a failure older than this is left as it is: its hirer has gone */
  withinMinutes: 30,
  /** how long the job's view says a move may still come, so the hire box keeps looking instead of showing the error */
  pendingMinutes: 3,
  perAgentPerDay: 5,
  perDay: 50,
  /** most failures one tick looks at */
  perTick: 10,
  /** a rescuer must offer at least this share of the failed agent's skills */
  sharedSkills: 0.5,
} as const;

/** The context keys that mark a job the network gave itself, or one that is part of something larger. */
export const NOT_A_HIRE = ["automated", "source", "rescueOf", "followUp", "followUpOf", "orchestration", "orchestratorTaskId", "subcontractOf", "retainerId", "triggerId", "autonomyTest"];

/** Errors that say the job should not be tried elsewhere: a refusal, or a hirer who stopped or left. */
const DO_NOT_MOVE = /declin|refus|not allowed|policy|client disconnected|stopped by|cancel/i;

/** Whether a failed job may be moved, and why not when it may not. */
export function whyNotRescue(task: Task, nowMs = Date.now()): string | null {
  if (task.status !== "failed") return "it has not failed";
  if (task.workflowId || task.quorumId) return "it is a step of something larger";
  if (task.parentTaskId) return "it is a follow-up";
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  if (NOT_A_HIRE.some((k) => k in ctx)) return "it is not a hire somebody made";
  if (DO_NOT_MOVE.test(task.error ?? "")) return "the agent turned it down, or its hirer stopped it";
  // a job one agent gave another (a plan, an orchestration, a subcontract) is the hiring agent's to handle
  if (getAgentById(task.fromAgent)) return "an agent hired it, and handles its failure itself";
  const ended = Date.parse(task.completedAt ?? task.createdAt);
  if (!(nowMs - ended <= RESCUE.withinMinutes * 60_000)) return "it failed too long ago";
  return null;
}

function movedToday(nowMs: number, agentId?: string): number {
  const dayStart = new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();
  try {
    const db = getDb();
    if (!agentId) return (db.prepare("SELECT COUNT(*) n FROM autonomy3_jobs WHERE part = 'rescue' AND outcome = 'moved' AND started_at >= ?").get(dayStart) as { n: number }).n;
    return (db.prepare("SELECT COUNT(*) n FROM autonomy3_jobs WHERE part = 'rescue' AND outcome = 'moved' AND started_at >= ? AND json_extract(detail, '$.from') = ?").get(dayStart, agentId) as { n: number }).n;
  } catch {
    return 0;
  }
}

/** Whether an agent's last few finished jobs all failed: then it is no rescuer. */
function failingNow(agentId: string): boolean {
  try {
    const rows = getDb().prepare("SELECT status FROM tasks WHERE to_agent = ? AND status IN ('completed','failed') ORDER BY completed_at DESC LIMIT 3").all(agentId) as { status: string }[];
    if (rows.length === 3 && rows.every((r) => r.status === "failed")) return true;
    const broken = getDb().prepare("SELECT model_error FROM agents WHERE agent_id = ?").get(agentId) as { model_error?: string | null } | undefined;
    return Boolean(broken?.model_error);
  } catch {
    return false;
  }
}

/**
 * The agent to move a failed job to: offers at least half of the failed agent's skills, runs on Axon (not on a server
 * of its own, not an orchestrator), is free, and is not failing. Most skills in common first, then the router's own
 * ranking (Proof Score, load). Null when there is none.
 */
export function pickRescuer(failed: Agent, hirer: string, sharedSkills: number = RESCUE.sharedSkills): Agent | null {
  const skills = [...new Set((failed.capabilities ?? []).map((c) => c.toLowerCase()))];
  if (!skills.length) return null;
  const need = Math.max(1, Math.ceil(skills.length * sharedSkills));
  const seen = new Map<string, { agent: Agent; score: number }>();
  for (const capability of skills) {
    for (const c of rankAgents({ capability, exclude: [failed.agentId, hirer], candidateLimit: 24 })) {
      if (!seen.has(c.agent.agentId) || seen.get(c.agent.agentId)!.score < c.score) seen.set(c.agent.agentId, { agent: c.agent, score: c.score });
    }
  }
  const fits = [...seen.values()]
    .map(({ agent, score }) => ({ agent, score, shared: (agent.capabilities ?? []).filter((c) => skills.includes(c.toLowerCase())).length }))
    .filter(({ agent, shared }) => shared >= need && !agent.price && !agent.endpoint && !agent.orchestrator && !failingNow(agent.agentId))
    .sort((a, b) => b.shared - a.shared || b.score - a.score);
  return fits[0]?.agent ?? null;
}

/** Copy the files the person attached to the failed job onto the new one: the bytes are kept by their hash, so this is a row each. */
function carryFiles(fromTask: string, toTask: string): number {
  try {
    const db = getDb();
    const cols = (db.prepare("PRAGMA table_info(task_files)").all() as { name: string }[]).map((c) => c.name).filter((c) => !["id", "task_id", "source_task_id"].includes(c));
    const rows = db.prepare("SELECT id FROM task_files WHERE task_id = ? AND direction = 'in' AND deleted_at IS NULL").all(fromTask) as { id: string }[];
    const copy = db.prepare(`INSERT INTO task_files (id, task_id, source_task_id, ${cols.join(", ")}) SELECT ?, ?, ?, ${cols.join(", ")} FROM task_files WHERE id = ?`);
    for (const r of rows) copy.run(randomUUID(), toTask, fromTask, r.id);
    return rows.length;
  } catch {
    return 0; // before the files tables: a job with no files carries none
  }
}

export interface RescueResult { moved: boolean; why: string; to?: string; taskId?: string }

/**
 * Move one failed job, if it may be moved. Synchronous on purpose: called straight after the worker fails the job,
 * nothing can read the job in between and see the failure without the move.
 */
export function rescueTask(taskId: string, nowMs = Date.now(), env: Env = process.env): RescueResult {
  if (!partOn("rescue", env)) return { moved: false, why: "switched off" };
  const task = getTaskById(taskId);
  if (!task) return { moved: false, why: "no such job" };
  const not = whyNotRescue(task, nowMs);
  if (not) return { moved: false, why: not };
  const failed = getAgentById(task.toAgent);
  if (!failed) return { moved: false, why: "its agent is gone" };

  // From here on the attempt is recorded, whatever comes of it: the job's view reads the record to know a move is over.
  const jobId = claimJob("rescue", taskId, nowMs);
  if (!jobId) return { moved: false, why: "already handled" };
  const end = (outcome: string, summary: string, detail: Record<string, unknown>, r: RescueResult): RescueResult => {
    finishJob(jobId, { outcome, summary, detail: { from: failed.agentId, ...detail } }, nowMs);
    return r;
  };
  if (movedToday(nowMs) >= RESCUE.perDay) return end("not-moved", "Today's moves are all used", { reason: "per-day" }, { moved: false, why: "today's moves are used" });
  if (movedToday(nowMs, failed.agentId) >= RESCUE.perAgentPerDay) return end("not-moved", `${failed.name} has had its moves for today`, { reason: "per-agent" }, { moved: false, why: "this agent's moves for today are used" });

  const to = pickRescuer(failed, task.fromAgent);
  if (!to) return end("not-moved", `No free agent could take ${failed.name}'s job`, { reason: "no-agent" }, { moved: false, why: "no agent can take it" });

  try {
    const ctx = (task.context ?? {}) as Record<string, unknown>;
    const moved = createTask({ fromAgent: task.fromAgent, toAgent: to.agentId, task: task.task, context: { ...ctx, rescueOf: taskId } });
    const files = carryFiles(taskId, moved.taskId);
    logger.info("autonomy3.rescued", "A failed job was moved to another agent", { taskId, from: failed.agentId, to: to.agentId, newTaskId: moved.taskId, files });
    return end("moved", `${failed.name} failed it; moved to ${to.name}`, { to: to.agentId, toName: to.name, taskId: moved.taskId, files, error: (task.error ?? "").slice(0, 200) }, { moved: true, why: "moved", to: to.agentId, taskId: moved.taskId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return end("error", "The move could not be made", { reason }, { moved: false, why: reason });
  }
}

/** The failed jobs of the last half hour that nobody has looked at yet: the ones that failed outside the worker. */
export function sweepFailures(nowMs = Date.now(), env: Env = process.env): RescueResult[] {
  if (!partOn("rescue", env)) return [];
  let ids: string[] = [];
  try {
    ids = (getDb()
      .prepare(`SELECT t.task_id FROM tasks t WHERE t.status = 'failed' AND t.completed_at >= ?
                AND NOT EXISTS (SELECT 1 FROM autonomy3_jobs j WHERE j.part = 'rescue' AND j.subject = t.task_id)
                ORDER BY t.completed_at DESC LIMIT ?`)
      .all(new Date(nowMs - RESCUE.withinMinutes * 60_000).toISOString(), RESCUE.perTick * 5) as { task_id: string }[]).map((r) => r.task_id);
  } catch {
    return [];
  }
  const out: RescueResult[] = [];
  for (const id of ids) {
    const r = rescueTask(id, nowMs, env);
    if (r.why !== "switched off") out.push(r);
    if (out.filter((x) => x.moved).length >= RESCUE.perTick) break;
  }
  return out;
}

onTick("rescue", async ({ nowMs, env }: TickContext) => { sweepFailures(nowMs, env); });

export interface RescueView {
  /** the job it was moved to, readable with the token given here by whoever could read the failed one */
  rescued?: { taskId: string; claimToken: string; agentId: string; agentName: string };
  /** a move may still come: keep looking a little longer before showing the error */
  rescuing?: boolean;
}

/** What a failed job's view adds: where it went, or that it may still go. */
export function rescueView(task: Task, nowMs = Date.now(), env: Env = process.env): RescueView {
  if (task.status !== "failed") return {};
  const job = jobFor("rescue", task.taskId);
  const d = (job?.detail ?? {}) as { taskId?: string; to?: string; toName?: string };
  if (job?.outcome === "moved" && d.taskId && d.to) {
    return { rescued: { taskId: d.taskId, claimToken: claimTokenFor(d.taskId), agentId: d.to, agentName: d.toName ?? d.to } };
  }
  if (job) return {};
  if (!partOn("rescue", env) || whyNotRescue(task, nowMs)) return {};
  const ended = Date.parse(task.completedAt ?? task.createdAt);
  return nowMs - ended <= RESCUE.pendingMinutes * 60_000 ? { rescuing: true } : {};
}
