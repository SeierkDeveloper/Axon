// Autonomy 3, "two agents and a judge": on a big job a second agent answers too, a third model picks the better
// answer, and the customer pays once.
//
// Which jobs: only while the part is on (AUTONOMY3_JUDGE), and only a job that asked for it (`bestOfTwo: true` on
// POST /api/tasks, which Axon writes into the job's context as JUDGE_KEY), or a paid job at or above
// AUTONOMY3_JUDGE_MIN_ETH when that is set (unset: never without being asked). Never a follow-up, a step of a workflow
// or quorum, a job one agent gave another, the network's own jobs, a job with files, a job that works to an approved
// plan, a job the person steered, or a job whose agent uses tools that act on the world (a browser, building pages,
// running code, pictures, MCP or commerce tools). Web search and web fetch only read, so they do not count.
//
// How: the worker starts the second agent alongside the hired one, on the same job text, without tools, at Axon's
// cost. The second agent is picked the way "no job dies" picks a rescuer (lib/autonomy3Rescue pickRescuer): free, runs
// on Axon, not an orchestrator, not failing, with at least half of the hired agent's skills. When the hired agent has
// answered, the cheap grader model scores both answers on Agent Studio's scale (GRADER_SYSTEM, parseGrade). Each answer
// is graded on its own and blind (no agent names, no other answer beside it), so there is no order for the grader to
// be biased by. The second answer is shown only when it scores strictly higher: a tie goes to the hired agent.
//
// What it never does:
//   - hold the customer's answer back for long: the second agent and the grades get at most JUDGE.waitMs after the
//     hired agent has answered. Slow, failed, empty, ungraded or too long to grade within the job's token limit, and
//     the hired agent's answer is delivered exactly as it would have been without this part
//   - touch money. The customer pays once, exactly as today, and the job is settled the normal way whichever answer
//     won: the hired agent is paid (or refunded on a failure) as it always is.
//
//     OPEN DECISION FOR THE OWNER: when the second agent's answer wins, the hired agent is still the one paid, and its
//     record counts the job as its own. Whether part of the payment should go to the second agent's owner, or the
//     hired agent's record should show the loss, is not decided here and nothing in payments, escrow or refunds was
//     changed for it.
//
// The record (autonomy3_jobs, part "judge", subject the job's id) keeps both agents, both scores and which was shown.
// The job's view (judgeView) tells the hire box that two agents worked on it. One judge per job: the record is the
// guard (migration 129), so a job the worker runs again is not judged twice.

import { getAgentById } from "./agents";
import { runWithProvider, claudeModel } from "./providers";
import { captureModelStep } from "./modelUsage";
import { estimateCostUsd, safeAppendTraceEvent, hashContent } from "./traceEvents";
import { parseGrade, GRADER_SYSTEM } from "./studioTest";
import { studioModels } from "./studioPolicy";
import { parsePriceToEth } from "./payments";
import { FOLLOW_KEY } from "./followUp";
import { PLAN_KEY } from "./planFirst";
import { CONTEXT_KEY, REPORT_KEY } from "./agentFiles";
import { partOn, jobsADay } from "./autonomy3Policy";
import { claimJob, finishJob, jobFor, recentJobs, startedInWindow, onTick, type TickContext } from "./autonomy3";
import { pickRescuer, NOT_A_HIRE } from "./autonomy3Rescue";
import { logger } from "./logger";
import type { Task } from "./tasks";
import type { Agent } from "@/sdk/types";

type Env = Record<string, string | undefined>;

/** The context key Axon writes on a job that asked for two agents. A caller may not write it themselves. */
export const JUDGE_KEY = "bestOfTwo";

export const JUDGE = {
  /** the longest answer the second agent gives */
  answerTokens: 700,
  gradeTokens: 200,
  /** a job longer than this (its words and context) gets no second agent: it would not fit the job's token limit */
  maxJobChars: 3_600,
  /** an answer longer than this is not graded (it would be cut, and judged on part of itself): the hired one stands */
  gradeChars: 3_000,
  /** the most the customer's answer waits, after the hired agent has answered, for the second agent and the grades */
  waitMs: 30_000,
  /** the second agent offers at least this share of the hired agent's skills */
  sharedSkills: 0.5,
  /** a judge still open after this long lost its worker (a restart): the tick closes it */
  staleMinutes: 30,
} as const;

export interface JudgeModels {
  /** the second agent answering, its own way, without tools */
  answer(agent: Agent, task: string, maxTokens: number): Promise<string>;
  /** the cheap grader model */
  grader(system: string, prompt: string, maxTokens: number): Promise<string>;
}

export const realJudgeModels: JudgeModels = {
  answer: (agent, task, maxTokens) => runWithProvider(agent, task, maxTokens),
  grader: (system, prompt, maxTokens) => claudeModel(studioModels().grader).complete(system, prompt, maxTokens),
};

/** The payment at or above which a job gets a second agent without asking, or null: never (the variable is unset). */
export function judgeMinEth(env: Env = process.env): number | null {
  const raw = env.AUTONOMY3_JUDGE_MIN_ETH?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** What the worker knows, at the moment the hired agent starts, about how it runs this job. */
export interface HowItRuns {
  /** the agent is an MCP server: its answer is a tool's output, not words to compare */
  viaMcp: boolean;
  /** the grants its owner gave it that resolved (web_search, web_fetch, code_execution, an MCP server ...) */
  grants: string[];
  /** tools of its own beyond the plain grants: MCP tools, commerce */
  localTools: number;
  /** files handed over with the hire */
  files: number;
  /** the answer is also kept as a file */
  report: boolean;
  sandbox: boolean;
  office: boolean;
  browsing: boolean;
  building: boolean;
  drawing: boolean;
  /** the person sent notes before it started */
  steered: boolean;
  /** it carries on a conversation */
  followUp: boolean;
}

/** Grants that only read, and so do not stop a job from being judged. */
const READ_ONLY = new Set(["web_search", "web_fetch"]);

/** Why a job gets no second agent, or null when it should get one (if the day's number allows: counted apart). */
export function whyNoJudge(task: Task, run: HowItRuns, env: Env = process.env): string | null {
  if (!partOn("judge", env)) return "switched off";
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  const asked = ctx[JUDGE_KEY] === true;
  const min = judgeMinEth(env);
  const paid = task.payment ? parsePriceToEth(task.payment) : null;
  if (!asked && !(min !== null && paid !== null && paid >= min)) return "it did not ask for two agents and is not a big paid job";
  if (task.workflowId || task.quorumId) return "it is a step of something larger";
  if (task.parentTaskId || run.followUp || FOLLOW_KEY in ctx) return "it is a follow-up";
  if (NOT_A_HIRE.some((k) => k in ctx)) return "it is not a hire somebody made";
  if (getAgentById(task.fromAgent)) return "an agent hired it";
  if (PLAN_KEY in ctx) return "it works to a plan its hirer approved";
  if (run.viaMcp) return "its agent answers through an MCP server";
  if (run.files > 0 || run.report || CONTEXT_KEY in ctx || REPORT_KEY in ctx) return "it has files";
  if (run.sandbox || run.office || run.browsing || run.building || run.drawing || run.localTools > 0 || run.grants.some((g) => !READ_ONLY.has(g))) {
    return "its agent uses tools that act on the world";
  }
  if (run.steered) return "its hirer steered it";
  return null;
}

export interface Verdict {
  /** what the customer gets */
  output: string;
  shown: "hired" | "second";
  outcome: string;
}

export interface Judge {
  second: Agent;
  /** Called with the hired agent's answer: waits at most JUDGE.waitMs, and returns the answer to deliver. Never throws. */
  decide(hiredAnswer: string, opts?: { steered?: boolean }): Promise<Verdict>;
  /** The job ended without an answer to judge (failed, stopped, waiting on a question). Nothing after a decision. */
  drop(reason: string): void;
}

const gradePrompt = (job: string, answer: string) => `The job:\n${job}\n\nThe answer:\n${answer}`;

type Judged =
  | { outcome: "hired-won" | "second-won"; hired: { score: number; feedback: string }; second: { score: number; feedback: string }; text: string }
  | { outcome: "second-failed" | "too-long" | "ungraded" | "timeout" | "error"; reason: string };

/**
 * Start a second agent on a job the hired agent is about to work on, when the job should have one. Returns null when it
 * should not (the reason is in whyNoJudge), when the day's number is used, when no agent fits, or when the job was
 * judged before. `message` is the job's own words and context, the same text the second agent and the grader read.
 */
export function startJudge(task: Task, hired: Agent, message: string, run: HowItRuns, env: Env = process.env, models: JudgeModels = realJudgeModels, nowMs = Date.now()): Judge | null {
  if (whyNoJudge(task, run, env)) return null;
  if (message.length > JUDGE.maxJobChars) {
    logger.info("autonomy3.judge_skipped", "A job was too long for a second agent within the judge's token limit", { taskId: task.taskId, chars: message.length });
    return null;
  }
  // The jobs come from customers, not the tick, so the day's number is counted over the day rather than spread over
  // it: a burst of jobs that asked is served until the number is used, and the day's cost is bounded all the same.
  if (startedInWindow("judge", nowMs, env) >= (jobsADay("judge", env) ?? 0)) return null;
  const second = pickRescuer(hired, task.fromAgent, JUDGE.sharedSkills);
  if (!second) return null;
  const id = claimJob("judge", task.taskId, nowMs);
  if (!id) return null;

  const asked = (task.context as Record<string, unknown> | undefined)?.[JUDGE_KEY] === true;
  let cost = 0;
  let closed = false;
  const spent = (s: { model?: string; inputTokens: number; outputTokens: number }) => { cost += estimateCostUsd(s.model, s.inputTokens, s.outputTokens) ?? 0; };
  const close = (outcome: string, summary: string, detail: Record<string, unknown> = {}) => {
    if (closed) return;
    closed = true;
    finishJob(id, {
      outcome,
      summary,
      detail: { hired: hired.agentId, hiredName: hired.name, second: second.agentId, secondName: second.name, why: asked ? "asked" : "big paid job", ...detail },
      costUsd: Math.round(cost * 1e6) / 1e6,
    }, Date.now());
  };

  // Started now, alongside the hired agent, so it is usually done by the time the hired agent is.
  const secondRun: Promise<{ ok: true; text: string } | { ok: false; error: string }> = captureModelStep(() => models.answer(second, message, JUDGE.answerTokens))
    .then((s) => {
      spent(s);
      const text = typeof s.result === "string" ? s.result.trim() : "";
      return text ? { ok: true as const, text } : { ok: false as const, error: "an empty answer" };
    })
    .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));

  const grade = async (answer: string) => {
    const g = await captureModelStep(() => models.grader(GRADER_SYSTEM, gradePrompt(message, answer), JUDGE.gradeTokens));
    spent(g);
    return parseGrade(g.result);
  };

  const judge = async (hiredAnswer: string): Promise<Judged> => {
    const s = await secondRun;
    if (!s.ok) return { outcome: "second-failed", reason: s.error.slice(0, 200) };
    if (hiredAnswer.length > JUDGE.gradeChars || s.text.length > JUDGE.gradeChars) return { outcome: "too-long", reason: "an answer was too long to grade whole within the job's limit" };
    const [h, o] = await Promise.all([grade(hiredAnswer).catch(() => null), grade(s.text).catch(() => null)]);
    if (!h || !o) return { outcome: "ungraded", reason: "the grader gave no readable score" };
    return { outcome: o.score > h.score ? "second-won" : "hired-won", hired: h, second: o, text: s.text };
  };

  return {
    second,
    drop(reason: string) {
      close("dropped", `${hired.name}'s job ended without an answer to judge`, { reason: reason.slice(0, 200) });
    },
    async decide(hiredAnswer: string, opts: { steered?: boolean } = {}): Promise<Verdict> {
      const keep = (outcome: string): Verdict => ({ output: hiredAnswer, shown: "hired", outcome });
      if (closed) return keep("closed");
      if (opts.steered) {
        close("not-judged", `Its hirer steered ${hired.name} while it worked; its answer stands`);
        return keep("not-judged");
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<Judged>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "timeout", reason: `no verdict within ${JUDGE.waitMs / 1000}s` }), JUDGE.waitMs);
        timer.unref?.();
      });
      let r: Judged;
      try {
        r = await Promise.race([judge(hiredAnswer), late]);
      } catch (err) {
        r = { outcome: "error", reason: err instanceof Error ? err.message : String(err) };
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!("text" in r)) {
        close(r.outcome, `${second.name} was asked too; ${r.reason}, so ${hired.name}'s answer stands`, { reason: r.reason });
        return keep(r.outcome);
      }
      const won = r.outcome === "second-won";
      close(r.outcome, won
        ? `${second.name} (${r.second.score}/10) beat ${hired.name} (${r.hired.score}/10); its answer was shown`
        : `${hired.name} (${r.hired.score}/10) held against ${second.name} (${r.second.score}/10)`, {
        hiredScore: r.hired.score, secondScore: r.second.score, hiredFeedback: r.hired.feedback, secondFeedback: r.second.feedback,
        shown: won ? "second" : "hired", secondAnswer: r.text.slice(0, 1_500),
      });
      const output = won ? r.text : hiredAnswer;
      // On the job's record: that a judge chose, and the fingerprint of what was delivered. Scores, never the words.
      safeAppendTraceEvent({
        traceId: task.traceId ?? task.taskId, taskId: task.taskId, kind: "progress", fromAgent: task.fromAgent, toAgent: task.toAgent,
        workflowId: task.workflowId ?? null, stepIndex: task.stepIndex ?? null, outputHash: hashContent(output),
        meta: { judge: { second: second.agentId, shown: won ? "second" : "hired", hiredScore: r.hired.score, secondScore: r.second.score } },
      });
      return { output, shown: won ? "second" : "hired", outcome: r.outcome };
    },
  };
}

export interface JudgeView {
  /** two agents worked on the job and a judge picked the answer shown */
  judged?: { shown: "hired" | "second"; secondAgent: { id: string; name: string } };
}

/** What a finished job's view adds: that two agents worked on it, and whose answer is shown. */
export function judgeView(task: Task): JudgeView {
  if (task.status !== "completed") return {};
  const job = jobFor("judge", task.taskId);
  if (job?.outcome !== "hired-won" && job?.outcome !== "second-won") return {};
  const d = (job.detail ?? {}) as { second?: string; secondName?: string };
  return { judged: { shown: job.outcome === "second-won" ? "second" : "hired", secondAgent: { id: d.second ?? "", name: d.secondName ?? d.second ?? "" } } };
}

/** Judges left open by a worker that stopped (a restart, a deploy) are closed, so the record does not show them running. */
export function closeStale(nowMs = Date.now()): number {
  let n = 0;
  for (const j of recentJobs(200, "judge")) {
    if (j.finishedAt || nowMs - Date.parse(j.startedAt) < JUDGE.staleMinutes * 60_000) continue;
    finishJob(j.id, { outcome: "dropped", summary: "The worker stopped before the judge finished; the hired agent's answer stood" }, nowMs);
    n++;
  }
  return n;
}

onTick("judge", async ({ nowMs }: TickContext) => { closeStale(nowMs); });
