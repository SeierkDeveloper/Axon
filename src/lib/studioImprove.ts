// Agent Studio, phase 7: a live agent keeps getting better from its real jobs.
//
// When enough of a Studio agent's real jobs go wrong (a task that failed, a review of two stars or less), Axon writes a
// better version from what went wrong, then tests the current version and the new one on the same tasks: the agent's
// original tests plus a few new ones modelled on its weak jobs. Only a version that clearly beats the current one is
// proposed, and only its owner can apply it: nothing changes their agent unasked.
//
// Buyers' tasks are not copied into tests. The writer turns each weak job into a similar test of its own, with no names,
// numbers or details from the original, and the owner sees the tests, never the jobs.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { getInstructions, setInstructions } from "./agentKnowledge";
import { studioInfo } from "./studioPublish";
import { getBuild, type Draft } from "./studioDraft";
import { gradeRound, parseRewrite, parseTasks, type Models, type TestTask } from "./studioTest";
import { STUCK } from "./autonomyPolicy";
import { studioEnabled, IMPROVE, LIMITS } from "./studioPolicy";
import { validateAgentText } from "./agentContent";
import { logger } from "./logger";

export interface Improvement { id: string; agentId: string; status: string; weakJobs: number; fromScore: number | null; toScore: number | null; createdAt: string }

export const IMPROVE_SYSTEM = `You improve a live AI agent that people pay per task, from the jobs it got wrong. You get its current instructions
and a summary of each weak job: what was asked, and what went wrong (an error, or a buyer's low review). Do two things.

1. Rewrite the instructions so jobs like these go right, keeping everything that works. Fix causes, not single cases.
2. Write ${IMPROVE.newTests} new test tasks like the weak jobs, as a buyer would send them, with all the material inside
   the task. Do NOT copy the jobs: no names, numbers, companies, wallets or details from them. Make up your own.

Answer in exactly this shape and nothing else:
<instructions>the full new instructions, at most 6000 characters</instructions>
<tests>[{ "task": "...", "lookFor": "what a great answer must do" }]</tests>`;

interface WeakJob { kind: "failed" | "review"; what: string; why: string }

/** The agent's real jobs that went wrong since `since`: failed tasks (not ones Axon itself closed) and low reviews. */
export function weakJobs(agentId: string, since: string): WeakJob[] {
  const db = getDb();
  const closedByAxon = Object.values(STUCK.reasons);
  const failed = (db.prepare("SELECT task, error FROM tasks WHERE to_agent = ? AND status = 'failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 20").all(agentId, since) as { task: string; error: string | null }[])
    .filter((t) => !closedByAxon.some((r) => (t.error ?? "").includes(r)))
    .map((t): WeakJob => ({ kind: "failed", what: t.task.slice(0, 600), why: (t.error ?? "it failed").slice(0, 200) }));
  const reviews = (db.prepare("SELECT rating, comment FROM reviews WHERE agent_id = ? AND rating <= 2 AND created_at >= ? ORDER BY created_at DESC LIMIT 20").all(agentId, since) as { rating: number; comment: string | null }[])
    .map((r): WeakJob => ({ kind: "review", what: "(a buyer's review)", why: `${r.rating}/5: ${(r.comment ?? "no comment").slice(0, 300)}` }));
  return [...failed, ...reviews];
}

export function improvementsOf(agentId: string): Improvement[] {
  return getDb().prepare("SELECT id, agent_id agentId, status, weak_jobs weakJobs, from_score fromScore, to_score toScore, created_at createdAt FROM studio_improvements WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10").all(agentId) as Improvement[];
}

const setStatus = (id: string, status: string, fields: { fromScore?: number | null; toScore?: number | null; instructions?: string } = {}) =>
  getDb().prepare("UPDATE studio_improvements SET status = ?, from_score = COALESCE(?, from_score), to_score = COALESCE(?, to_score), instructions = COALESCE(?, instructions), updated_at = ? WHERE id = ?")
    .run(status, fields.fromScore ?? null, fields.toScore ?? null, fields.instructions ?? null, new Date().toISOString(), id);

/** When this agent's weak jobs start counting: its publication, or its last attempt to improve, within the window. */
function countFrom(agentId: string): string {
  const last = (getDb().prepare("SELECT MAX(created_at) at FROM studio_improvements WHERE agent_id = ?").get(agentId) as { at: string | null }).at;
  const window = new Date(Date.now() - IMPROVE.windowDays * 86_400_000).toISOString();
  return last && last > window ? last : window;
}

/**
 * Try to improve one live Studio agent from its weak jobs. Writes the attempt as a row and returns its status:
 * "proposed" when the new version clearly beats the current one on the same tests, "no-better" otherwise.
 */
export async function improveAgent(agentId: string, models: Models): Promise<string> {
  const agent = getAgentById(agentId);
  const info = studioInfo(agentId);
  const current = getInstructions(agentId);
  const source = info ? getBuild(info.buildId) : null;
  if (!agent || !info || !current || !source?.draft || !agent.walletAddress) return "not-studio";
  const jobs = weakJobs(agentId, countFrom(agentId));
  if (jobs.length < IMPROVE.minWeakJobs) return "not-enough";

  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO studio_improvements (id, agent_id, wallet, build_id, status, weak_jobs, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, agentId, agent.walletAddress.toLowerCase(), info.buildId, "testing", jobs.length, now, now);
  try {
    const summary = jobs.map((j, i) => `JOB ${i + 1} (${j.kind}): ${j.what}\nWHAT WENT WRONG: ${j.why}`).join("\n\n");
    const raw = await models.rewrite(IMPROVE_SYSTEM, `THE AGENT: ${agent.name}. ${source.draft.description}\n\nCURRENT INSTRUCTIONS:\n${current}\n\nITS WEAK JOBS:\n${summary}`);
    const next = parseRewrite(raw).slice(0, LIMITS.instructionsChars);
    const fresh = parseTasks(raw.match(/<tests>([\s\S]*?)(?:<\/tests>|$)/i)?.[1] ?? "").slice(0, IMPROVE.newTests);
    if (next.length < 80 || validateAgentText(next) || !fresh.length) { setStatus(id, "failed"); return "failed"; }

    // the same tests for both: the agent's originals and the new ones, so the comparison is fair
    const original = (getDb().prepare("SELECT tasks FROM studio_builds WHERE id = ?").get(info.buildId) as { tasks: string | null }).tasks;
    const tasks: TestTask[] = [...(original ? (JSON.parse(original) as TestTask[]) : []), ...fresh];
    const draft: Draft = { ...source.draft, instructions: current };
    const base = 1_000 + (getDb().prepare("SELECT COUNT(*) n FROM studio_improvements WHERE agent_id = ?").get(agentId) as { n: number }).n * 10;
    const before = await gradeRound(info.buildId, base, source.sentence, draft, current, tasks, models);
    const after = await gradeRound(info.buildId, base + 1, source.sentence, draft, next, tasks, models);
    const better = before.score !== null && after.score !== null && after.score >= before.score + IMPROVE.margin;
    setStatus(id, better ? "proposed" : "no-better", { fromScore: before.score, toScore: after.score, instructions: better ? next : undefined });
    logger.info("studio.improve", "Tried a better version of a Studio agent", { agentId, weakJobs: jobs.length, from: before.score, to: after.score, proposed: better });
    return better ? "proposed" : "no-better";
  } catch (err) {
    setStatus(id, "failed");
    logger.warn("studio.improve_failed", "Improving a Studio agent failed", { agentId, reason: err instanceof Error ? err.message : String(err) });
    return "failed";
  }
}

/** The owner applies a proposed version (it becomes the agent's instructions and score) or dismisses it. */
export function decideImprovement(id: string, wallet: string, apply: boolean): { ok: true } | string {
  const r = getDb().prepare("SELECT agent_id, wallet, status, to_score, instructions FROM studio_improvements WHERE id = ?").get(id) as { agent_id: string; wallet: string; status: string; to_score: number | null; instructions: string | null } | undefined;
  if (!r || r.wallet !== wallet.toLowerCase()) return "No such proposal.";
  if (r.status !== "proposed") return "This proposal is no longer open.";
  if (apply) {
    if (!r.instructions) return "This proposal has nothing to apply.";
    const bad = setInstructions(r.agent_id, r.instructions);
    if (bad) return bad;
    getDb().prepare("UPDATE agents SET studio_score = ? WHERE agent_id = ?").run(r.to_score, r.agent_id);
  }
  setStatus(id, apply ? "applied" : "dismissed");
  return { ok: true };
}

/** Open proposals for a wallet's agents, for the Studio page. */
export function proposalsOf(wallet: string): Improvement[] {
  return getDb().prepare("SELECT id, agent_id agentId, status, weak_jobs weakJobs, from_score fromScore, to_score toScore, created_at createdAt FROM studio_improvements WHERE wallet = ? AND status = 'proposed' ORDER BY created_at DESC").all(wallet.toLowerCase()) as Improvement[];
}

/**
 * The hourly upkeep: a few live Studio agents with enough weak jobs, and no attempt in the last day, get one. Run from
 * the autonomy pass, inside its kill switch.
 */
export async function improveStudioAgents(models: Models): Promise<{ tried: string[]; proposed: string[] }> {
  const out = { tried: [] as string[], proposed: [] as string[] };
  if (!studioEnabled()) return out;
  const recent = new Date(Date.now() - IMPROVE.everyHours * 3_600_000).toISOString();
  const agents = (getDb().prepare(
    `SELECT a.agent_id FROM agents a WHERE a.studio_build IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM studio_improvements i WHERE i.agent_id = a.agent_id AND (i.created_at >= ? OR i.status IN ('testing','proposed')))`,
  ).all(recent) as { agent_id: string }[]).map((r) => r.agent_id);
  for (const agentId of agents) {
    if (out.tried.length >= IMPROVE.maxPerPass) break;
    if (weakJobs(agentId, countFrom(agentId)).length < IMPROVE.minWeakJobs) continue;
    out.tried.push(agentId);
    if ((await improveAgent(agentId, models)) === "proposed") out.proposed.push(agentId);
  }
  return out;
}
