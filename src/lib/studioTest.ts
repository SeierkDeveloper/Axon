// Agent Studio, phase 3: a draft earns its listing. Axon writes test tasks for it, runs them, has a second agent grade
// every answer, rewrites the instructions where it scored low, and runs the same tasks again, until it is good enough
// or the rounds run out. The best version is kept, with its score and the rounds that led to it.
//
// Every call counts against studioPolicy.BUILD_BUDGET: the tasks, rounds, tokens and calls are hard stops, and so is the
// time. A build that is stopped, by its budget or by a restart, keeps the best version it had.
//
// Tests run without tools: every task carries the material it needs in its own text, so a score measures the
// instructions, not whether a page could be fetched that minute.

import { getDb } from "./db";
import { claudeModel } from "./providers";
import { validateAgentText } from "./agentContent";
import { extractJson, getBuild, updateBuild, type Draft } from "./studioDraft";
import { studioEnabled, studioModels, BUILD_BUDGET, LIMITS } from "./studioPolicy";
import { logger } from "./logger";

export interface TestTask { task: string; lookFor: string }
export interface Result extends TestTask { answer: string | null; score: number | null; feedback: string | null }
export interface Round { round: number; instructions: string; results: Result[]; score: number | null; createdAt: string }

/** The four kinds of model call a build makes. Real ones by default; tests pass their own. */
export interface Models {
  /** write the test tasks (grader model) */
  tasks(system: string, prompt: string): Promise<string>;
  /** the agent itself answering one task (the draft's own model) */
  answer(model: string, system: string, task: string): Promise<string>;
  /** grade one answer (grader model) */
  grade(system: string, prompt: string): Promise<string>;
  /** rewrite the instructions (writer model) */
  rewrite(system: string, prompt: string): Promise<string>;
}

const real: Models = {
  tasks: (s, p) => claudeModel(studioModels().grader).complete(s, p, 1_500),
  answer: (model, s, t) => claudeModel(model).complete(s, t, BUILD_BUDGET.answerTokens),
  grade: (s, p) => claudeModel(studioModels().grader).complete(s, p, BUILD_BUDGET.graderTokens),
  rewrite: (s, p) => claudeModel(studioModels().writer).complete(s, p, BUILD_BUDGET.rewriteTokens),
};

// ── The prompts ───────────────────────────────────────────────────────────────

export const TASKS_SYSTEM = `You write test tasks for an AI agent before it is listed on a marketplace where people pay it per task.
Write ${BUILD_BUDGET.testTasks} tasks a real buyer of this agent would send, as a JSON array and nothing else:
[{ "task": "the exact message a buyer sends", "lookFor": "what a great answer must do, in one sentence" }]
Mix them: typical requests, a hard one, an edge case (thin or messy input), and one that is slightly outside its job.
Put every bit of material the agent needs inside the task text itself (a transcript excerpt, the data, the document):
the agent cannot browse during the test. Keep each task under 1,500 characters.`;

export const GRADER_SYSTEM = `You grade one answer from an AI agent that people will pay per task. Be strict and fair: 10 is an answer an
expert would sign, 7 is useful but with clear gaps, 4 misses what was asked, 0 is wrong or harmful. Answer with JSON
and nothing else: { "score": 0-10 as a whole number, "feedback": "one or two sentences: the most important thing to fix" }`;

export const REWRITE_SYSTEM = `You improve an AI agent's instructions (its system prompt) after a test round. You get the current
instructions and every test task with its score and the grader's feedback. Rewrite the instructions so the weak answers
would score higher, keeping everything that worked. Fix causes, not single cases: add the missing rule, the clearer
format, the judgement call it got wrong. At most 6000 characters. Answer with the full new instructions between
<instructions> and </instructions>, and nothing else.`;

const purposeOf = (sentence: string, d: Draft) => `The agent: ${d.name}. ${d.description}\nIts owner described it as: ${sentence}`;
export const agentSystem = (d: Draft, instructions: string) => `You are ${d.name}, an agent on the Axon agent network. Your owner wrote these instructions for you:\n\n${instructions}`;

// ── Parsing what the models said ──────────────────────────────────────────────

export function parseTasks(raw: string): TestTask[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as unknown[];
    return arr
      .map((t) => t as Record<string, unknown>)
      .filter((t) => typeof t?.task === "string" && t.task.trim().length > 10)
      .map((t) => ({ task: String(t.task).trim().slice(0, 2_000), lookFor: String(t.lookFor ?? "").trim().slice(0, 300) }))
      .slice(0, BUILD_BUDGET.testTasks);
  } catch {
    return [];
  }
}

/**
 * The rewritten instructions: between <instructions> tags, which survive the line breaks instructions are made of (a
 * JSON string must escape every one, and a long rewrite often does not). JSON is still read, should a model answer so.
 */
export function parseRewrite(raw: string): string {
  const tagged = raw.match(/<instructions>([\s\S]*?)(?:<\/instructions>|$)/i)?.[1];
  const text = tagged ?? String((extractJson(raw) as { instructions?: unknown } | null)?.instructions ?? "");
  return text.trim().slice(0, LIMITS.instructionsChars);
}

export function parseGrade(raw: string): { score: number; feedback: string } | null {
  const j = extractJson(raw) as { score?: unknown; feedback?: unknown } | null;
  const score = Number(j?.score);
  if (!j || !Number.isFinite(score)) return null;
  return { score: Math.max(0, Math.min(10, Math.round(score))), feedback: String(j.feedback ?? "").slice(0, 400) };
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

// ── Rounds ────────────────────────────────────────────────────────────────────

export function roundsOf(buildId: string): Round[] {
  return (getDb().prepare("SELECT round, instructions, results, score, created_at createdAt FROM studio_rounds WHERE build_id = ? ORDER BY round").all(buildId) as { round: number; instructions: string; results: string; score: number | null; createdAt: string }[])
    .map((r) => ({ ...r, results: JSON.parse(r.results) as Result[] }));
}

function saveRound(buildId: string, round: number, instructions: string, results: Result[], score: number | null) {
  getDb().prepare(
    `INSERT INTO studio_rounds (build_id, round, instructions, results, score, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(build_id, round) DO UPDATE SET results = excluded.results, score = excluded.score`,
  ).run(buildId, round, instructions, JSON.stringify(results), score, new Date().toISOString());
}

/** A build left mid-test (the server restarted, say) is closed with the best version it had. */
export function settleStale(buildId: string, now = Date.now()): void {
  const b = getBuild(buildId);
  if (!b || (b.status !== "testing" && b.status !== "improving")) return;
  if (now - Date.parse(b.updatedAt) < (BUILD_BUDGET.maxMinutes + 2) * 60_000) return;
  finish(buildId, b.draft!, "stopped", "Stopped before it finished. The best version so far is kept.");
}

/**
 * Keep the best round's instructions as the draft, with its score: the best of this run only (rounds after `after`),
 * since a change asked for in chat makes the earlier rounds measure instructions that are no longer the agent's.
 */
function finish(buildId: string, draft: Draft, status: "ready" | "stopped" | "failed", error: string | null, after = 0) {
  const best = roundsOf(buildId).filter((r) => r.round > after && r.score !== null).sort((a, b) => b.score! - a.score! || a.round - b.round)[0];
  updateBuild(buildId, { status, draft: best ? { ...draft, instructions: best.instructions } : draft, score: best?.score ?? null, error });
}

/**
 * Test a drafted build and improve it, start to finish. Meant to run in the background: the build's status and its
 * rounds show where it has got to. Returns the finished build's status.
 */
export async function runBuild(buildId: string, models: Models = real, now: () => number = Date.now): Promise<string> {
  const b = getBuild(buildId);
  if (!b?.draft || b.status !== "drafted") return b?.status ?? "missing";
  const draft = b.draft;
  const started = now();
  let calls = 0;
  const spend = (n: number) => {
    calls += n;
    if (calls > BUILD_BUDGET.maxCalls) throw new Error("budget");
  };
  const late = () => now() - started > BUILD_BUDGET.maxMinutes * 60_000;

  // a build tested before (and changed in chat since) keeps its rounds as history and continues the numbering
  const prior = roundsOf(buildId);
  const after = prior.length ? Math.max(...prior.map((r) => r.round)) : 0;
  updateBuild(buildId, { status: "testing", error: null });
  try {
    // the tasks, once per build: every round is graded on the same ones, so the scores compare, before and after a change
    const saved = (getDb().prepare("SELECT tasks FROM studio_builds WHERE id = ?").get(buildId) as { tasks: string | null }).tasks;
    let tasks: TestTask[] = saved ? (JSON.parse(saved) as TestTask[]) : [];
    if (!tasks.length) {
      spend(1);
      tasks = parseTasks(await models.tasks(TASKS_SYSTEM, purposeOf(b.sentence, draft)));
      if (tasks.length < 3) {
        finish(buildId, draft, "failed", "Studio could not write test tasks for this agent. Try describing it a little more.", after);
        return "failed";
      }
      getDb().prepare("UPDATE studio_builds SET tasks = ? WHERE id = ?").run(JSON.stringify(tasks), buildId);
    }

    let instructions = draft.instructions;
    for (let step = 1; step <= BUILD_BUDGET.maxRounds; step++) {
      const round = after + step;
      if (!studioEnabled()) { finish(buildId, draft, "stopped", "Agent Studio was paused. The best version so far is kept.", after); return "stopped"; }
      if (late()) { finish(buildId, draft, "stopped", "The build ran out of time. The best version so far is kept.", after); return "stopped"; }
      updateBuild(buildId, { status: "testing" });
      const results: Result[] = tasks.map((t) => ({ ...t, answer: null, score: null, feedback: null }));
      saveRound(buildId, round, instructions, results, null);

      // every task at once: answer, then grade, each saved the moment it lands
      spend(tasks.length * 2);
      await Promise.all(tasks.map(async (t, i) => {
        const answer = await models.answer(draft.model, agentSystem(draft, instructions), t.task).catch(() => "");
        results[i].answer = answer.slice(0, 4_000);
        const g = answer.trim()
          ? parseGrade(await models.grade(GRADER_SYSTEM, `${purposeOf(b.sentence, draft)}\n\nTASK:\n${t.task}\n\nA GREAT ANSWER: ${t.lookFor}\n\nTHE AGENT'S ANSWER:\n${answer}`).catch(() => ""))
          : { score: 0, feedback: "No answer came back." };
        results[i].score = g?.score ?? null;
        results[i].feedback = g?.feedback ?? "The grader gave no verdict.";
        saveRound(buildId, round, instructions, results, null);
      }));
      const score = mean(results.map((r) => r.score).filter((s): s is number => s !== null));
      saveRound(buildId, round, instructions, results, score);
      updateBuild(buildId, { score });

      if (score !== null && score >= BUILD_BUDGET.goodEnough) break;
      if (step === BUILD_BUDGET.maxRounds) break;

      // rewrite from the feedback, and test the new version on the same tasks
      updateBuild(buildId, { status: "improving" });
      spend(1);
      const report = results.map((r, i) => `TASK ${i + 1} (score ${r.score ?? "?"}/10): ${r.task.slice(0, 600)}\nFEEDBACK: ${r.feedback}`).join("\n\n");
      const raw = await models.rewrite(REWRITE_SYSTEM, `${purposeOf(b.sentence, draft)}\n\nCURRENT INSTRUCTIONS:\n${instructions}\n\nTHE ROUND:\n${report}`);
      const next = parseRewrite(raw);
      // a rewrite that is thin or fails the content check is not tested; the best so far stands, and the log says why
      const why = next.length < 80 ? `unreadable or thin rewrite (${raw.length} chars back)` : validateAgentText(next);
      if (why) {
        logger.warn("studio.rewrite_unused", "A Studio rewrite was not tested", { buildId, round, why });
        break;
      }
      instructions = next;
    }
    finish(buildId, draft, "ready", null, after);
    return "ready";
  } catch (err) {
    const budget = err instanceof Error && err.message === "budget";
    if (!budget) logger.warn("studio.build_failed", "A Studio build failed", { buildId, reason: err instanceof Error ? err.message : String(err) });
    finish(buildId, draft, roundsOf(buildId).some((r) => r.round > after && r.score !== null) ? "stopped" : "failed",
      budget ? "The build used its whole budget. The best version so far is kept." : "Something went wrong while testing. The best version so far is kept.", after);
    return "stopped";
  }
}
