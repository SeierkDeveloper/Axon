// Autonomy 3, "hires its own agents": the network's chores are done by agents on the network, each a real hire with
// a receipt, the way a customer's job is.
//
// Up to the day's fixed number (JOBS_A_DAY.upkeep, 4), each tick that has a turn hires one free agent that runs on
// Axon, picked by the router for the skill the chore needs (the best one that is not out of routing):
//   - the daily report: soon after midnight UTC, a writing agent turns yesterday's record of Autonomy 3 (what it moved,
//     tested, attacked, improved, built, found) into a short report in plain words for the admin page
//   - a second opinion: for a test an agent scored under 6 on (phase 4), a reviewing agent says what is wrong with the
//     answer and how the agent should change; "makes agents better" reads it with the rest of the evidence
// The hire goes through the worker like any other (context source "axon-autonomy-upkeep", so it is never counted as
// a customer's job, never moved by "no job dies" and never replayed). A later tick reads the finished job and files its
// result; the record keeps the job's receipt.
//
// With "its own budget" on (lib/autonomy3Budget, AUTONOMY3_BUDGET), a chore may go to a PAID agent that runs on Axon,
// paid from the network's allowance like any allowance hire. Whenever the budget cannot pay (unset, empty, refused,
// expired, no paid agent within its limit), the chore goes to a free agent exactly as before.

import { getDb } from "./db";
import { createTask, getTaskById } from "./tasks";
import { getAgentById } from "./agents";
import { rankAgents } from "./routing";
import { parsePaymentAmount } from "./money";
import { payForChore, type Pay } from "./autonomy3Budget";
import { partOn } from "./autonomy3Policy";
import { startJob, finishJob, mayStart, recentJobs, onTick, type TickContext } from "./autonomy3";
import type { Agent } from "@/sdk/types";

type Env = Record<string, string | undefined>;
const DAY = 86_400_000;

export const UPKEEP = {
  /** who hires: the network itself, not an agent and not a wallet */
  hirer: "axon-autonomy",
  source: "axon-autonomy-upkeep",
  /** a chore not done in this long is given up */
  giveUpHours: 3,
  /** the report waits until this long after midnight UTC, so the day's replay is in */
  reportAfterMinutes: 30,
  /** a test answer scored under this gets a second opinion */
  reviewBelow: 6,
} as const;

/** The skills each chore needs, the best fit first. */
const SKILLS = {
  report: ["writing", "summarization", "summarisation", "copywriting", "report writing", "content writing"],
  // a reviewer first; where the network has none free, a careful generalist
  review: ["quality assurance", "editing", "proofreading", "review", "feedback", "writing", "research", "analysis", "summarization"],
} as const;
export type Chore = keyof typeof SKILLS;

/** A free agent that runs on Axon and has the skill, best first; never the agent a second opinion is about. */
export function choreAgent(chore: Chore, not: string[] = []): Agent | null {
  for (const capability of SKILLS[chore]) {
    const fit = rankAgents({ capability, exclude: not, candidateLimit: 12 }).find((c) => !c.agent.price && !c.agent.endpoint && !c.agent.orchestrator);
    if (fit) return fit.agent;
  }
  return null;
}

/**
 * The paid agent for a chore, for the budget: runs on Axon (a chore's material is the network's own record, so it never
 * goes to a server of somebody else's), not an orchestrator, priced in ETH at or under the budget's per-task limit.
 * The best for the skill first, as for a free one.
 */
export function paidChoreAgent(chore: Chore, not: string[], maxPerTaskWei: bigint): Agent | null {
  for (const capability of SKILLS[chore]) {
    const fit = rankAgents({ capability, exclude: not, candidateLimit: 12 }).find((c) => {
      const wei = c.agent.price ? parsePaymentAmount(c.agent.price)?.wei ?? null : null;
      return wei !== null && wei > 0n && wei <= maxPerTaskWei && !c.agent.endpoint && !c.agent.orchestrator;
    });
    if (fit) return fit.agent;
  }
  return null;
}

/** Yesterday's record of Autonomy 3, as plain counts and lines for the report writer. */
export function yesterdayInWords(nowMs: number): string {
  const day = Math.floor(nowMs / DAY) * DAY - DAY;
  const rows = getDb().prepare("SELECT part, outcome, summary FROM autonomy3_jobs WHERE started_at >= ? AND started_at < ? AND part != 'upkeep' ORDER BY started_at").all(new Date(day).toISOString(), new Date(day + DAY).toISOString()) as { part: string; outcome: string | null; summary: string | null }[];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(`${r.part} ${r.outcome ?? "running"}`, (counts.get(`${r.part} ${r.outcome ?? "running"}`) ?? 0) + 1);
  const lines = rows.filter((r) => r.summary && r.outcome !== "clear" && r.outcome !== "held" && r.outcome !== "passed").slice(0, 40).map((r) => `- ${r.part}: ${r.summary}`);
  return `Day: ${new Date(day).toISOString().slice(0, 10)}\nCounts: ${[...counts].map(([k, n]) => `${k}: ${n}`).join("; ") || "nothing recorded"}\nWorth knowing:\n${lines.join("\n") || "- nothing out of the ordinary"}`;
}

const REPORT_TASK = (record: string) => `Write a short daily report for the admin of an AI agent network, from the record below of what the network did by
itself yesterday. Plain words, no headers, at most 120 words: what it did, anything that went wrong or needs a person,
and one line on whether the day looked healthy. Do not invent anything that is not in the record.

${record}`;

const REVIEW_TASK = (agent: Agent, task: string, answer: string, feedback: string) => `Give a second opinion on an answer an AI agent gave in a test. The agent: ${agent.name} (${(agent.capabilities ?? []).join(", ")}).
A grader scored it low and said: "${feedback}". Say in at most 80 words what is really wrong with the answer, and the one
change to the agent's instructions that would fix it. No headers.

THE JOB:
${task.slice(0, 1_500)}

ITS ANSWER:
${answer.slice(0, 1_500)}`;

export interface NextChore { chore: Chore; about: string | null; task: string; not: string[]; /** this chore and no other, for paying it once */ key: string }

/**
 * Hire one agent for a chore, recorded as a running job with the task as its subject: a paid one from the network's
 * budget when that is on and can pay, else a free one as always.
 */
async function hire(next: NextChore, nowMs: number, env: Env, pay?: Pay): Promise<{ taskId: string; agentId: string; paid: boolean } | null> {
  const context = { source: UPKEEP.source, automated: true, chore: next.chore, ...(next.about ? { about: next.about } : {}) };
  const paid = await payForChore({ choreKey: next.key, chore: next.chore === "report" ? "daily report" : "second opinion", pick: (max) => paidChoreAgent(next.chore, next.not, max), task: next.task, context, hirer: UPKEEP.hirer }, nowMs, env, pay);
  if (paid) return startJob("upkeep", paid.taskId, nowMs) ? { ...paid, paid: true } : null;
  const agent = choreAgent(next.chore, next.not);
  if (!agent) return null;
  const t = createTask({ fromAgent: UPKEEP.hirer, toAgent: agent.agentId, task: next.task, context });
  if (!startJob("upkeep", t.taskId, nowMs)) return null;
  return { taskId: t.taskId, agentId: agent.agentId, paid: false };
}

/** The next chore that is due: the report once a day, else a second opinion on a weak test that has none. */
export function nextChore(nowMs: number): NextChore | null {
  const today = Math.floor(nowMs / DAY) * DAY;
  const reportedToday = getDb().prepare("SELECT 1 FROM autonomy3_jobs j JOIN tasks t ON t.task_id = j.subject WHERE j.part = 'upkeep' AND j.started_at >= ? AND json_extract(t.context, '$.chore') = 'report' LIMIT 1").get(new Date(today).toISOString());
  if (!reportedToday && nowMs - today >= UPKEEP.reportAfterMinutes * 60_000) return { chore: "report", about: null, task: REPORT_TASK(yesterdayInWords(nowMs)), not: [], key: `report:${new Date(today).toISOString().slice(0, 10)}` };
  const weak = getDb().prepare(`SELECT j.id, j.subject, j.detail FROM autonomy3_jobs j WHERE j.part = 'test' AND j.started_at >= ?
      AND json_extract(j.detail, '$.score') < ? AND NOT EXISTS (SELECT 1 FROM tasks t WHERE json_extract(t.context, '$.source') = ? AND json_extract(t.context, '$.about') = j.id)
      ORDER BY j.started_at DESC LIMIT 1`).get(new Date(nowMs - 3 * DAY).toISOString(), UPKEEP.reviewBelow, UPKEEP.source) as { id: string; subject: string; detail: string } | undefined;
  if (weak) {
    const agent = getAgentById(weak.subject);
    const d = JSON.parse(weak.detail ?? "{}") as { task?: string; answer?: string; feedback?: string };
    if (agent && d.task && d.answer) return { chore: "review", about: weak.id, task: REVIEW_TASK(agent, d.task, d.answer, d.feedback ?? ""), not: [agent.agentId], key: `review:${weak.id}` };
  }
  return null;
}

/** File the chores that finished: the report and the second opinions go into the record, with each job's receipt. */
export function fileFinished(nowMs = Date.now()): number {
  let filed = 0;
  for (const j of recentJobs(100, "upkeep").filter((x) => !x.finishedAt)) {
    const t = getTaskById(j.subject ?? "");
    if (!t) { finishJob(j.id, { outcome: "error", summary: "The chore's job is gone" }, nowMs); continue; }
    const ctx = (t.context ?? {}) as { chore?: Chore; about?: string };
    const by = getAgentById(t.toAgent)?.name ?? t.toAgent;
    const receipt = `/r/${t.taskId}`;
    if (t.status === "completed" && t.output) {
      const what = ctx.chore === "report" ? `${by} wrote yesterday's report` : `${by} gave a second opinion on a weak test`;
      finishJob(j.id, { outcome: "done", summary: what, detail: { chore: ctx.chore, about: ctx.about ?? null, by: t.toAgent, receipt, payment: t.payment ?? null, text: t.output.slice(0, 2_000) } }, nowMs);
      filed++;
    } else if (t.status === "failed" || t.status === "cancelled" || nowMs - Date.parse(t.createdAt) > UPKEEP.giveUpHours * 3_600_000) {
      finishJob(j.id, { outcome: "failed", summary: `${by} did not finish the ${ctx.chore ?? "chore"}`, detail: { chore: ctx.chore, by: t.toAgent, receipt, error: (t.error ?? "not done in time").slice(0, 200) } }, nowMs);
    }
  }
  return filed;
}

/** On a tick: file what finished (free), then hire for the next chore when it is the part's turn. */
export async function upkeepTurn(nowMs = Date.now(), env: Env = process.env, pay?: Pay): Promise<{ taskId: string; agentId: string; chore: Chore; paid: boolean } | null> {
  if (!partOn("upkeep", env)) return null;
  fileFinished(nowMs);
  if (!mayStart("upkeep", nowMs, env)) return null;
  const next = nextChore(nowMs);
  if (!next) return null;
  const hired = await hire(next, nowMs, env, pay);
  return hired ? { ...hired, chore: next.chore } : null;
}

/** The second opinions on an agent's tests, for "makes agents better". */
export function secondOpinionsOn(agentId: string, sinceMs: number): string[] {
  const testIds = new Set((getDb().prepare("SELECT id FROM autonomy3_jobs WHERE part = 'test' AND subject = ? AND started_at >= ?").all(agentId, new Date(sinceMs).toISOString()) as { id: string }[]).map((r) => r.id));
  return recentJobs(200, "upkeep")
    .map((j) => j.detail as { chore?: string; about?: string; text?: string } | null)
    .filter((d): d is { chore: string; about: string; text: string } => Boolean(d?.chore === "review" && d.about && testIds.has(d.about) && d.text))
    .map((d) => d.text);
}

/** The latest daily report, for the admin page. */
export function latestReport(): { text: string; by: string; receipt: string; at: string } | null {
  const j = recentJobs(100, "upkeep").find((x) => x.outcome === "done" && (x.detail as { chore?: string } | null)?.chore === "report");
  const d = j?.detail as { text?: string; by?: string; receipt?: string } | undefined;
  return j && d?.text ? { text: d.text, by: d.by ?? "", receipt: d.receipt ?? "", at: j.finishedAt ?? j.startedAt } : null;
}

onTick("upkeep", async ({ nowMs, env }: TickContext) => { await upkeepTurn(nowMs, env); });
