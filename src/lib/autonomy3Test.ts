// Autonomy 3, "tests every agent": small real jobs, graded, so the network knows how good each agent is before a
// customer finds out.
//
// One test is one of the day's fixed number (autonomy3Policy JOBS_A_DAY.test, 45: on 136 agents each is tested about
// every three days). The agent whose turn it is: one never tested first (a new agent is tested before most customers
// meet it), then the one tested longest ago. The test:
//   1. a job a real buyer would send: one of the starter jobs that fit the agent, in turn, or, when none fits, one
//      written for it from its name and skills by the cheap grader model
//   2. the agent answers it the way it answers a hire: its own model and instructions, no tools, a short answer
//   3. the grader model scores the answer 0 to 10 with one line of feedback, on the same scale Agent Studio uses
// An agent that does not answer, or scores 2 or less, leaves routing the way a failing agent does (Autonomy 2's
// pause, within its caps); the hourly pass re-tests it and puts it back. Everything else is recorded: the score is on
// the admin page, and it is what the parts after this one (improving, attacking) build on.
//
// Only agents that run on Axon are tested: an agent on its own server is checked by Autonomy 2 already, and a job sent
// there would be work done for nothing by somebody else's machine. Orchestrators are left out (one test of theirs is
// many hires), and so are MCP servers and gateway providers, which do not answer in words.

import { getDb } from "./db";
import { getAgentById } from "./agents";
import { runWithProvider, claudeModel } from "./providers";
import { captureModelStep } from "./modelUsage";
import { estimateCostUsd } from "./traceEvents";
import { startersFor } from "./starterJobs";
import { parseGrade, parseTasks, GRADER_SYSTEM } from "./studioTest";
import { studioModels } from "./studioPolicy";
import { pauseFailing } from "./autonomyActions";
import { actionsEnabled } from "./autonomyPolicy";
import { partOn } from "./autonomy3Policy";
import { startJob, finishJob, mayStart, onTick, type TickContext } from "./autonomy3";
import { logger } from "./logger";
import type { Agent } from "@/sdk/types";

type Env = Record<string, string | undefined>;

export const TEST = {
  /** the longest answer a test asks for */
  answerTokens: 600,
  gradeTokens: 200,
  writeTokens: 400,
  /** a test that takes longer than this is a failed test */
  timeoutMs: 60_000,
  /** at or below this the agent failed its test */
  failAt: 2,
  /** below this it is weak: recorded, not acted on */
  weakBelow: 6,
} as const;

export interface TestModels {
  /** the agent answering, its own way */
  answer(agent: Agent, task: string): Promise<string>;
  /** the cheap grader model: writes a task when none fits, and grades */
  grader(system: string, prompt: string, maxTokens: number): Promise<string>;
}

export const realTestModels: TestModels = {
  answer: (agent, task) => runWithProvider(agent, task, TEST.answerTokens),
  grader: (system, prompt, maxTokens) => claudeModel(studioModels().grader).complete(system, prompt, maxTokens),
};

/** The agents that can be tested, the one whose turn it is first: never tested, then tested longest ago. */
export function testQueue(limit = 5): string[] {
  try {
    return (getDb().prepare(`
      SELECT a.agent_id FROM agents a
      LEFT JOIN (SELECT subject, MAX(started_at) last FROM autonomy3_jobs WHERE part = 'test' GROUP BY subject) j ON j.subject = a.agent_id
      WHERE a.agent_id NOT LIKE 'build-%' AND (a.endpoint IS NULL OR a.endpoint = '') AND COALESCE(a.orchestrator, 0) = 0
        AND a.agent_id NOT IN (SELECT provider_id FROM gateway_providers) AND a.agent_id NOT IN (SELECT server_id FROM mcp_servers)
      ORDER BY j.last IS NOT NULL, j.last ASC, a.created_at DESC
      LIMIT ?`).all(limit) as { agent_id: string }[]).map((r) => r.agent_id);
  } catch {
    return [];
  }
}

const WRITE_SYSTEM = `You write one test job for an AI agent on a marketplace where people pay it per job. Write the exact message a real
buyer would send it: a typical request that fits its skills, with every bit of material it needs inside the message.
The test runs without tools: the agent answers in words only. It cannot make pictures or files, browse, or run code, so
never ask for those; for an agent that makes pictures, ask for what it can say in words (a description, a plan, alt
text, a critique of a described design). Under 800 characters. Answer with JSON and nothing else: [{ "task": "...", "lookFor": "what a great answer must do" }]`;

/** The job for this test: the agent's starter jobs in turn, or one written for it. */
async function jobFor(agent: Agent, round: number, models: TestModels, env: Env): Promise<{ task: string; label: string; lookFor: string }> {
  const fits = startersFor(agent, {}, { ...env, AGENT_STARTERS: "on" }).filter((s) => s.id !== "show" && !s.sample && !s.builds);
  if (fits.length) {
    const s = fits[round % fits.length];
    return { task: s.task, label: s.label, lookFor: "" };
  }
  const raw = await models.grader(WRITE_SYSTEM, `The agent: ${agent.name}. ${agent.description ?? ""}\nIts skills: ${(agent.capabilities ?? []).join(", ")}`, TEST.writeTokens);
  const [t] = parseTasks(raw);
  if (!t) throw new Error("no test job could be written for it");
  return { task: t.task, label: "A job written for it", lookFor: t.lookFor };
}

export interface TestOutcome { agentId: string; outcome: "passed" | "weak" | "failed" | "error"; score: number | null; summary: string }

/** One test of one agent, recorded as a job. */
export async function testAgent(agentId: string, nowMs = Date.now(), env: Env = process.env, models: TestModels = realTestModels): Promise<TestOutcome | null> {
  const agent = getAgentById(agentId);
  if (!agent) return null;
  const id = startJob("test", agentId, nowMs);
  if (!id) return null;
  const round = (getDb().prepare("SELECT COUNT(*) n FROM autonomy3_jobs WHERE part = 'test' AND subject = ?").get(agentId) as { n: number }).n - 1;
  let cost = 0;
  const spent = (s: { model?: string; inputTokens: number; outputTokens: number }) => { cost += estimateCostUsd(s.model, s.inputTokens, s.outputTokens) ?? 0; };
  const close = (o: TestOutcome, detail: Record<string, unknown>): TestOutcome => {
    finishJob(id, { outcome: o.outcome, summary: o.summary, detail, costUsd: Math.round(cost * 1e6) / 1e6 }, Date.now());
    return o;
  };
  let job: { task: string; label: string; lookFor: string };
  try {
    const w = await captureModelStep(() => jobFor(agent, round, models, env));
    spent(w);
    job = w.result;
  } catch (err) {
    return close({ agentId, outcome: "error", score: null, summary: `No test job for ${agent.name}` }, { reason: err instanceof Error ? err.message : String(err) });
  }

  // the agent answers, as it would a hire
  let answer = "";
  let answerError: string | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer within a minute")), TEST.timeoutMs).unref());
    const a = await captureModelStep(() => Promise.race([models.answer(agent, job.task), timeout]));
    spent(a);
    answer = typeof a.result === "string" ? a.result.trim() : "";
    if (!answer) answerError = "an empty answer";
  } catch (err) {
    answerError = err instanceof Error ? err.message : String(err);
  }

  let score: number | null = null, feedback = "";
  if (!answerError) {
    try {
      const g = await captureModelStep(() => models.grader(GRADER_SYSTEM, `The agent: ${agent.name}. ${agent.description ?? ""}\n\nThe job:\n${job.task}\n${job.lookFor ? `\nA great answer must: ${job.lookFor}\n` : ""}\nIts answer:\n${answer.slice(0, 6_000)}`, TEST.gradeTokens));
      spent(g);
      const parsed = parseGrade(g.result);
      if (parsed) ({ score, feedback } = parsed);
    } catch (err) {
      logger.warn("autonomy3.grade_failed", "A test answer could not be graded", { agentId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const outcome: TestOutcome["outcome"] = answerError ? "failed" : score === null ? "error" : score <= TEST.failAt ? "failed" : score < TEST.weakBelow ? "weak" : "passed";
  const summary = answerError
    ? `${agent.name} did not answer "${job.label}": ${answerError.slice(0, 120)}`
    : score === null
      ? `${agent.name} answered "${job.label}"; the grade could not be read`
      : `${agent.name} scored ${score}/10 on "${job.label}"`;

  // a failed test is a failing agent: out of routing within Autonomy 2's caps, until its hourly re-test passes
  let paused = false;
  if (outcome === "failed" && actionsEnabled(env)) {
    paused = pauseFailing([{ kind: "agent-failing", subject: agentId, what: `failed its test: ${summary}`.slice(0, 200) }], nowMs).some((f) => f.kind === "agent-paused");
  }
  return close({ agentId, outcome, score, summary: paused ? `${summary}; taken out of routing` : summary }, {
    job: job.label, task: job.task.slice(0, 1_500), score, feedback, answerChars: answer.length, answer: answer.slice(0, 1_500), ...(answerError ? { error: answerError.slice(0, 300) } : {}), paused,
  });
}

/** On a tick: one test when it is the part's turn (the day's tests are spread over the day). */
export async function testTurn(nowMs = Date.now(), env: Env = process.env, models: TestModels = realTestModels): Promise<TestOutcome | null> {
  if (!partOn("test", env) || !mayStart("test", nowMs, env)) return null;
  const [next] = testQueue(1);
  return next ? testAgent(next, nowMs, env, models) : null;
}

onTick("test", async ({ nowMs, env }: TickContext) => { await testTurn(nowMs, env); });
