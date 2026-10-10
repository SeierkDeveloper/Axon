// Work with your agent: the agent asks.
//
// Some jobs cannot be done well without something only the person knows: which of two files is meant, a number that
// is not in the data, a choice that changes the whole result. An agent that may ask has one more tool. When it uses
// it, the job stops and waits: its status becomes "waiting", the question is shown to whoever hired it, and when
// they answer the job is queued again and the agent is run with the question and the answer. It is the same job
// throughout: one price, one receipt.
//
// Nobody is made to wait on a job nobody is watching. Asking is allowed only on a hire that said so
// (`allowQuestions`), so a trigger, a crew or a script never stalls on a question. And a question does not hold a
// job for ever: when the time runs out the job goes on, and the agent is told to use its best guess and say so.
//
// Off until AGENT_ASK=on.

import { getDb } from "./db";
import { getTaskById, type Task } from "./tasks";
import { emitAxonEvent } from "./eventBus";
import { syncToTurso } from "./db-turso";
import { safeAppendTraceEvent, hashContent } from "./traceEvents";
import { logger } from "./logger";
import type { LocalTool, ResolvedTools } from "./agentTools";

type Env = Record<string, string | undefined>;

export function askEnabled(env: Env = process.env): boolean {
  return (env.AGENT_ASK ?? "off").trim().toLowerCase() === "on";
}

const int = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
/** How many times one job may ask. */
export const maxQuestions = (env: Env = process.env): number => int(env.AXON_ASK_MAX, 2, 1, 5);
/** How long a job waits for an answer before it goes on without one, in minutes. */
export const waitMinutes = (env: Env = process.env): number => int(env.AXON_ASK_WAIT_MIN, 60, 1, 1440);

/** The key in a hire's context that says its agent may ask. Set from `allowQuestions` on the hire, never directly. */
export const ASK_KEY = "mayAsk";
export const ASK_TOOL = "ask_person";
export const QUESTION_CHARS = { min: 8, max: 600 } as const;
export const ANSWER_CHARS = 2_000;
const CHOICES = { most: 4, chars: 80 } as const;

export interface Question {
  n: number; text: string; choices?: string[]; askedAt: string; answerBy: string;
  answer?: string; answeredAt?: string; answeredHow?: "person" | "timeout";
}
interface Row { n: number; question: string; choices: string | null; asked_at: string; answer_by: string; answer: string | null; answered_at: string | null; answered_how: string | null }
const view = (r: Row): Question => {
  let choices: string[] = [];
  try { const c = r.choices ? JSON.parse(r.choices) : []; if (Array.isArray(c)) choices = c.filter((x) => typeof x === "string"); } catch { /* shown without choices */ }
  return {
    n: r.n, text: r.question, ...(choices.length ? { choices } : {}), askedAt: r.asked_at, answerBy: r.answer_by,
    ...(r.answered_at ? { ...(r.answer !== null ? { answer: r.answer } : {}), answeredAt: r.answered_at, answeredHow: r.answered_how === "person" ? "person" as const : "timeout" as const } : {}),
  };
};

/** Every question a job has asked, in order. */
export function questionsOf(taskId: string): Question[] {
  return (getDb().prepare("SELECT n, question, choices, asked_at, answer_by, answer, answered_at, answered_how FROM task_questions WHERE task_id = ? ORDER BY n ASC").all(taskId) as Row[]).map(view);
}

/** The question a job is waiting on, if it is waiting on one. */
export function openQuestion(taskId: string): Question | null {
  return questionsOf(taskId).find((q) => !q.answeredAt) ?? null;
}

/**
 * May this run of this job ask? The hire must have allowed it, the agent must be one Axon runs in the loop that runs
 * tools, and the job must not have used up its questions.
 */
export function mayAsk(task: Pick<Task, "taskId" | "context">, agent: { provider?: string | null; orchestrator?: boolean }, o: { viaMcp?: boolean; env?: Env } = {}): boolean {
  if (!askEnabled(o.env) || o.viaMcp || agent.orchestrator) return false;
  if ((agent.provider ?? "anthropic") !== "anthropic") return false;
  if (task.context?.[ASK_KEY] !== true) return false;
  return questionsOf(task.taskId).length < maxQuestions(o.env);
}

/**
 * The tool as one run of a job holds it. Using it writes the question down and tells the run (`onAsked`), which
 * stops and leaves the job waiting. A run asks once: the answer comes with the next run.
 */
export function askTool(ctx: { taskId: string; onAsked: (q: Question) => void; env?: Env; now?: () => number }): LocalTool {
  let asked = false;
  return {
    name: ASK_TOOL,
    label: ASK_TOOL,
    description:
      "Ask the person who hired you one question, and wait for the answer. Use it only when the job cannot be done well without something only they know: which of two things they mean, a fact or number that is not in what you were given, a choice that changes the whole result. Do not ask about anything you can find out, work out or reasonably assume, and never ask for permission or confirmation. Ask before you do the work, not after. One short, plain question; offer two to four short answers to pick from when that fits. After you call this, stop: you are run again with the answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in one or two plain sentences" },
        choices: { type: "array", items: { type: "string" }, maxItems: CHOICES.most, description: "Optional: two to four short answers the person can pick with one tap. They can always write their own" },
      },
      required: ["question"],
    },
    async run(args) {
      if (asked) throw new Error("You have already asked. Stop now and wait for the answer.");
      const text = typeof args.question === "string" ? args.question.replace(/\s+/g, " ").trim() : "";
      if (text.length < QUESTION_CHARS.min) throw new Error("Write the question out in a full sentence.");
      if (text.length > QUESTION_CHARS.max) throw new Error(`Keep the question under ${QUESTION_CHARS.max} characters.`);
      const env = ctx.env ?? process.env;
      const had = questionsOf(ctx.taskId);
      if (had.length >= maxQuestions(env)) throw new Error("This job has asked all it may. Go on with your best assumption and say what you assumed.");
      const choices = Array.isArray(args.choices)
        ? [...new Set(args.choices.filter((c): c is string => typeof c === "string").map((c) => c.replace(/\s+/g, " ").trim()).filter((c) => c.length > 0 && c.length <= CHOICES.chars))].slice(0, CHOICES.most)
        : [];
      const now = ctx.now?.() ?? Date.now();
      const askedAt = new Date(now).toISOString(), answerBy = new Date(now + waitMinutes(env) * 60_000).toISOString();
      const n = had.length + 1;
      getDb().prepare("INSERT INTO task_questions (task_id, n, question, choices, asked_at, answer_by) VALUES (?,?,?,?,?,?)")
        .run(ctx.taskId, n, text, choices.length >= 2 ? JSON.stringify(choices) : null, askedAt, answerBy);
      asked = true;
      ctx.onAsked({ n, text, ...(choices.length >= 2 ? { choices } : {}), askedAt, answerBy });
      return "The question was sent. Stop now. You are run again when the answer is in.";
    },
  };
}

export const canAsk = (t: ResolvedTools | null | undefined): boolean => Boolean(t?.localTools.some((x) => x.name === ASK_TOOL));
/** The same tools with the ask tool added, if it is not there already. */
export function withAsk(t: ResolvedTools | null | undefined, tool: LocalTool): ResolvedTools {
  const base: ResolvedTools = t ?? { serverTools: [], localTools: [], grants: [] };
  return canAsk(base) ? base : { ...base, localTools: [...base.localTools, tool], grants: [...base.grants, ASK_TOOL] };
}

const say = (task: Task, status: string): void => emitAxonEvent({ type: "task.updated", data: { taskId: task.taskId, status, agentId: task.toAgent, fromAgent: task.fromAgent } });

/** A run has asked and stopped: the job waits. False when the job is not running or has no open question. */
export function parkForAnswer(taskId: string): boolean {
  if (!openQuestion(taskId)) return false;
  const changed = getDb().prepare("UPDATE tasks SET status = 'waiting' WHERE task_id = ? AND status = 'running'").run(taskId).changes;
  if (!changed) return false;
  const task = getTaskById(taskId)!;
  say(task, "waiting");
  void syncToTurso();
  logger.info("ask.waiting", "A job is waiting for an answer", { taskId });
  return true;
}

export type AnswerRefusal = "not_waiting" | "empty" | "too_long";
export type AnswerResult = { ok: true; task: Task; question: Question } | { ok: false; refused: AnswerRefusal; reason: string };

/**
 * The answer to the question a job is waiting on, from the person or, with `how: "timeout"`, from the clock. The
 * answer is written down and the job is queued again in one step, so a job is never queued without its answer.
 */
export function answerQuestion(taskId: string, answer: string | null, how: "person" | "timeout" = "person", now = Date.now()): AnswerResult {
  const text = (answer ?? "").trim();
  if (how === "person" && !text) return { ok: false, refused: "empty", reason: "Write an answer first." };
  if (text.length > ANSWER_CHARS) return { ok: false, refused: "too_long", reason: `Keep the answer under ${ANSWER_CHARS.toLocaleString("en-US")} characters.` };
  const db = getDb(), at = new Date(now).toISOString();
  const done = db.transaction((): number | null => {
    const open = db.prepare("SELECT n FROM task_questions WHERE task_id = ? AND answered_at IS NULL ORDER BY n ASC LIMIT 1").get(taskId) as { n: number } | undefined;
    if (!open) return null;
    // back into the queue, its wait counted from now: the time spent waiting on a person is not the queue's
    const queued = db.prepare("UPDATE tasks SET status = 'queued', started_at = NULL, started_by = NULL, requeued_at = ? WHERE task_id = ? AND status = 'waiting'").run(at, taskId).changes;
    if (!queued) return null;
    db.prepare("UPDATE task_questions SET answer = ?, answered_at = ?, answered_how = ? WHERE task_id = ? AND n = ?").run(how === "person" ? text : null, at, how, taskId, open.n);
    return open.n;
  })();
  if (done === null) return { ok: false, refused: "not_waiting", reason: "This job is not waiting for an answer." };
  const task = getTaskById(taskId)!;
  // on the record that a question was answered and by what, as hashes: never the words
  safeAppendTraceEvent({
    traceId: task.traceId ?? task.taskId, taskId, kind: "progress", fromAgent: task.fromAgent, toAgent: task.toAgent,
    workflowId: task.workflowId ?? null, stepIndex: task.stepIndex ?? null,
    inputHash: how === "person" ? hashContent(text) : null,
    meta: { question: done, answered: how },
  });
  say(task, "queued");
  void syncToTurso();
  return { ok: true, task, question: questionsOf(taskId).find((q) => q.n === done)! };
}

/** Jobs whose question has waited long enough go on without an answer. Returns how many. */
export function resumeOverdue(now = Date.now()): number {
  const due = getDb().prepare(
    `SELECT DISTINCT q.task_id FROM task_questions q JOIN tasks t ON t.task_id = q.task_id
     WHERE q.answered_at IS NULL AND q.answer_by <= ? AND t.status = 'waiting'`,
  ).all(new Date(now).toISOString()) as { task_id: string }[];
  let resumed = 0;
  for (const { task_id } of due) if (answerQuestion(task_id, null, "timeout", now).ok) resumed++;
  if (resumed) logger.info("ask.resumed_unanswered", "Jobs went on without an answer", { resumed });
  return resumed;
}

/**
 * A question left open by a run that died before the job could wait for it. The job is running again, so nobody is
 * being asked: it is closed as unanswered rather than left looking like something to answer.
 */
export function closeStrays(taskId: string, now = Date.now()): number {
  return getDb().prepare("UPDATE task_questions SET answered_at = ?, answered_how = 'timeout' WHERE task_id = ? AND answered_at IS NULL").run(new Date(now).toISOString(), taskId).changes;
}

/** What an agent is told, after the job itself, about what it asked and what came back. Empty when it asked nothing. */
export function askedSoFar(taskId: string): string {
  const asked = questionsOf(taskId).filter((q) => q.answeredAt);
  if (!asked.length) return "";
  const lines = asked.map((q) => `You asked: ${q.text}\n${q.answeredHow === "person" ? `The person answered: ${q.answer ?? ""}` : "No answer came in time. Go on with your best assumption, and say in your answer what you assumed."}`);
  return `\n\nEarlier in this job you stopped to ask the person:\n\n${lines.join("\n\n")}\n\nNow do the job with that. Do not ask the same thing again.`;
}

/** What a reader of a job is told about its questions. Nothing while asking is off or the job asked nothing. */
export function questionsView(task: Pick<Task, "taskId" | "status">, env: Env = process.env): { question?: Question; questions?: Question[] } {
  if (!askEnabled(env)) return {};
  const all = questionsOf(task.taskId);
  if (!all.length) return {};
  const open = task.status === "waiting" ? all.find((q) => !q.answeredAt) : undefined;
  return { ...(open ? { question: open } : {}), questions: all };
}
