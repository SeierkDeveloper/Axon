// Work with your agent: stop and steer.
//
// A job that is running is not out of reach. Whoever hired it can send the agent a note while it works ("use the
// second sheet", "shorter", "leave out the prices"), and the agent reads it at its next step: between two of its
// tool calls, or, if it was about to finish, before it does, so it goes over its answer once more with the note in
// hand. And they can stop the job outright. A stopped job ends there: nothing is delivered, whatever was paid is
// refunded, and it counts neither for nor against the agent, exactly like a job cancelled at its plan.
//
// A note cannot reach an agent in the middle of a single model call. For a job that is one call, the note arrives
// after the answer; it stays marked as not read, and the page offers to send it as a follow-up instead.
//
// Off until AGENT_STEER=on.

import { getDb } from "./db";
import { getTaskById, type Task } from "./tasks";
import { refundPayment } from "./payments";
import { refundDebitForTask } from "./mpp";
import { emitAxonEvent } from "./eventBus";
import { syncToTurso } from "./db-turso";
import { safeAppendTraceEvent, hashContent } from "./traceEvents";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

export function steerEnabled(env: Env = process.env): boolean {
  return (env.AGENT_STEER ?? "off").trim().toLowerCase() === "on";
}

/** How many notes one job takes. */
export function maxNotes(env: Env = process.env): number {
  const n = Number(env.AXON_STEER_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 5;
}
export const NOTE_CHARS = 1_000;
export const STOPPED = "Stopped by the person who hired it. Nothing was delivered.";

export interface Note { n: number; text: string; sentAt: string; deliveredAt?: string }
interface Row { n: number; note: string; sent_at: string; delivered_at: string | null }
const view = (r: Row): Note => ({ n: r.n, text: r.note, sentAt: r.sent_at, ...(r.delivered_at ? { deliveredAt: r.delivered_at } : {}) });

/** Every note a job was sent, in order. */
export function notesOf(taskId: string): Note[] {
  return (getDb().prepare("SELECT n, note, sent_at, delivered_at FROM task_notes WHERE task_id = ? ORDER BY n ASC").all(taskId) as Row[]).map(view);
}

export type NoteRefusal = "off" | "finished" | "waiting" | "empty" | "too_long" | "too_many";
export type NoteResult = { ok: true; note: Note } | { ok: false; refused: NoteRefusal; reason: string; status: 400 | 409 };

/** Send a running job's agent a note. The job must be queued or running: a finished job takes a follow-up instead. */
export function sendNote(taskId: string, text: string, o: { now?: number; env?: Env } = {}): NoteResult {
  const no = (refused: NoteRefusal, reason: string, status: 400 | 409 = 400): NoteResult => ({ ok: false, refused, reason, status });
  if (!steerEnabled(o.env)) return no("off", "Notes to a running job are not switched on here.");
  const note = text.replace(/\s+\n/g, "\n").trim();
  if (!note) return no("empty", "Write the note first.");
  if (note.length > NOTE_CHARS) return no("too_long", `Keep the note under ${NOTE_CHARS.toLocaleString("en-US")} characters.`);
  const db = getDb(), sentAt = new Date(o.now ?? Date.now()).toISOString();
  const done = db.transaction((): Note | NoteRefusal => {
    const job = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(taskId) as { status: string } | undefined;
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return "finished";
    if (job.status === "waiting") return "waiting";
    const had = (db.prepare("SELECT COUNT(*) c FROM task_notes WHERE task_id = ?").get(taskId) as { c: number }).c;
    if (had >= maxNotes(o.env)) return "too_many";
    db.prepare("INSERT INTO task_notes (task_id, n, note, sent_at) VALUES (?,?,?,?)").run(taskId, had + 1, note, sentAt);
    return { n: had + 1, text: note, sentAt };
  })();
  if (done === "finished") return no("finished", "This job has finished. Send a follow-up instead.", 409);
  if (done === "waiting") return no("waiting", "This job is waiting on you. Answer it, and say it there.", 409);
  if (done === "too_many") return no("too_many", `A job takes ${maxNotes(o.env)} notes. Let it finish, then follow up.`);
  if (typeof done === "string") return no("finished", "This job has finished. Send a follow-up instead.", 409);
  return { ok: true, note: done };
}

/** The notes the agent has not been handed yet, now handed: each is marked as read from this moment. */
export function takeNotes(taskId: string, now = Date.now()): Note[] {
  const db = getDb(), at = new Date(now).toISOString();
  return db.transaction((): Note[] => {
    const rows = db.prepare("SELECT n, note, sent_at, delivered_at FROM task_notes WHERE task_id = ? AND delivered_at IS NULL ORDER BY n ASC").all(taskId) as Row[];
    if (rows.length) db.prepare("UPDATE task_notes SET delivered_at = ? WHERE task_id = ? AND delivered_at IS NULL").run(at, taskId);
    return rows.map((r) => view({ ...r, delivered_at: at }));
  })();
}

/** Notes as the agent is handed them at the start of a run, after the job's own words. Empty for none. */
export const notesAtStart = (notes: Note[]): string =>
  notes.length ? `\n\nThe person added this after hiring you:\n${notes.map((n) => `- ${n.text}`).join("\n")}` : "";

/** Notes as the agent is handed them in the middle of its work. */
export const notesMidway = (notes: Note[]): string =>
  `A note from the person who hired you, sent while you work. Take it into account from here on, and in your answer:\n${notes.map((n) => `- ${n.text}`).join("\n")}`;

export type StopResult = { ok: true; task: Task } | { ok: false; refused: "off" | "finished"; reason: string; status: 400 | 409 };

/**
 * Stop a job that has not finished: queued, running, or waiting on its hirer. It ends as cancelled, whatever was
 * paid for it is refunded, and anything it was waiting on is closed. A run in progress notices and stops working.
 */
export function stopJob(taskId: string, o: { now?: number; env?: Env } = {}): StopResult {
  if (!steerEnabled(o.env)) return { ok: false, refused: "off", reason: "Stopping a job is not switched on here.", status: 400 };
  const db = getDb(), at = new Date(o.now ?? Date.now()).toISOString();
  const stopped = db.transaction((): boolean => {
    const changed = db.prepare("UPDATE tasks SET status = 'cancelled', error = ?, completed_at = ? WHERE task_id = ? AND status IN ('queued', 'running', 'waiting')").run(STOPPED, at, taskId).changes;
    if (!changed) return false;
    // nobody is being asked any more
    db.prepare("UPDATE task_questions SET answered_at = ?, answered_how = 'cancelled' WHERE task_id = ? AND answered_at IS NULL").run(at, taskId);
    return true;
  })();
  if (!stopped) return { ok: false, refused: "finished", reason: "This job has already finished.", status: 409 };
  const task = getTaskById(taskId)!;
  // nothing was delivered: what paid for the job goes back, as it does for a job that fails
  refundPayment(taskId);
  refundDebitForTask(taskId);
  safeAppendTraceEvent({
    traceId: task.traceId ?? task.taskId, taskId, kind: "progress", fromAgent: task.fromAgent, toAgent: task.toAgent,
    workflowId: task.workflowId ?? null, stepIndex: task.stepIndex ?? null, meta: { stopped: "by the hirer" },
  });
  emitAxonEvent({ type: "task.updated", data: { taskId, status: "cancelled", agentId: task.toAgent, fromAgent: task.fromAgent } });
  void syncToTurso();
  logger.info("steer.stopped", "A job was stopped by its hirer", { taskId });
  return { ok: true, task };
}

/** True once a job has been called off: a run in progress asks this, and stops working. */
export const wasStopped = (taskId: string): boolean =>
  (getDb().prepare("SELECT status FROM tasks WHERE task_id = ?").get(taskId) as { status: string } | undefined)?.status === "cancelled";

/** On the record that a note reached the agent, as a hash: never the words. */
export function recordDelivered(task: Pick<Task, "taskId" | "traceId" | "fromAgent" | "toAgent" | "workflowId" | "stepIndex">, notes: Note[]): void {
  for (const n of notes) {
    safeAppendTraceEvent({
      traceId: task.traceId ?? task.taskId, taskId: task.taskId, kind: "progress", fromAgent: task.fromAgent, toAgent: task.toAgent,
      workflowId: task.workflowId ?? null, stepIndex: task.stepIndex ?? null, inputHash: hashContent(n.text), meta: { note: n.n },
    });
  }
}

/**
 * What a reader of a job is told about steering it: whether a note or a stop is possible now, how many notes are
 * left, and the notes sent with whether each was read. Nothing while steering is off.
 */
export function steerView(task: Pick<Task, "taskId" | "status">, env: Env = process.env): { steer?: { open: boolean; stoppable: boolean; notesLeft: number }; notes?: Note[] } {
  if (!steerEnabled(env)) return {};
  const notes = notesOf(task.taskId), live = task.status === "queued" || task.status === "running";
  return {
    steer: { open: live && notes.length < maxNotes(env), stoppable: live || task.status === "waiting", notesLeft: Math.max(0, maxNotes(env) - notes.length) },
    ...(notes.length ? { notes } : {}),
  };
}
