// Work with your agent: a follow-up.
//
// A finished job is not the end of the conversation. Whoever hired the agent can say more: the same agent is hired
// again and is given what was said before and the files from before, so it carries on instead of starting over. A
// follow-up is a hire like any other (its own price, its own receipt, its own place in the queue); what makes it a
// follow-up is the job it continues, written on it when it is created and covered by its commitment.
//
// Everything here is off until AGENT_FOLLOWUP=on. Off, a hire that names a job to follow is refused and nothing else
// changes.

import { getDb } from "./db";
import { getAgentById } from "./agents";
import { getTaskById, type Task } from "./tasks";
import { isWalletAddress } from "./address";
import { filesOfTask, fitForHire, latestOnly, type FileRow, type LeftBehind, type Reads } from "./agentFiles";

export function followUpEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AGENT_FOLLOWUP ?? "off").trim().toLowerCase() === "on";
}

/**
 * Bringing in another agent: a follow-up may go to a different agent than the one that did the job. The specialist
 * joins the same conversation, is given what was said and the files, and is hired and paid for its own turn like
 * any agent. Inside follow-ups: AGENT_BRINGIN=on, and only while follow-ups are on. Off, a follow-up goes to the
 * agent that did the job and nowhere else.
 */
export function bringInEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return followUpEnabled(env) && (env.AGENT_BRINGIN ?? "off").trim().toLowerCase() === "on";
}

/** How many turns one conversation may have, the first hire included. */
export function maxTurns(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AXON_FOLLOWUP_MAX_TURNS);
  return Number.isInteger(n) && n >= 2 && n <= 50 ? n : 12;
}

/** The key in a hire's context that says which job it follows. A caller may not set it themselves. */
export const FOLLOW_KEY = "followUp";

/** How much of the earlier conversation an agent is given: per question, per answer, and in all. */
export const HISTORY = { question: 2_000, answer: 6_000, total: 24_000 } as const;

const sameParty = (a: string, b: string): boolean => (isWalletAddress(a) && isWalletAddress(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The jobs a job follows, the first of the conversation first. Empty for a hire that follows nothing. */
export function earlierTurns(task: Pick<Task, "taskId" | "parentTaskId">): Task[] {
  const chain: Task[] = [], seen = new Set<string>([task.taskId]);
  let next = task.parentTaskId;
  // a conversation is capped far below this; the guard is for a row somebody edited into a loop
  while (next && !seen.has(next) && chain.length < 60) {
    seen.add(next);
    const t = getTaskById(next);
    if (!t) break;
    chain.unshift(t);
    next = t.parentTaskId;
  }
  return chain;
}

/** Which turn of its conversation a job is. 1 for a hire that follows nothing. */
export const turnOf = (task: Pick<Task, "taskId" | "parentTaskId">): number => earlierTurns(task).length + 1;

export type FollowRefusal = "off" | "not_found" | "not_finished" | "other_agent" | "own_server" | "kind" | "too_long";
export type FollowCheck =
  | { ok: true; parent: Task; thread: string; turn: number; broughtIn: boolean }
  | { ok: false; refused: FollowRefusal; reason: string; status: 400 | 404 | 409 };

/**
 * May this caller follow this job up? The job must be theirs: proven with that hire's own token (`tokenOk`), or
 * hired under the same name (a hire made without signing in has only its token). A job that is not theirs is answered exactly like one
 * that does not exist. It must have finished, be a single hire (not a step of a crew), and go to the same agent.
 */
export function checkFollowUp(input: { parentId: string; from: string; to?: string | null; tokenOk: boolean }, env: Record<string, string | undefined> = process.env): FollowCheck {
  const no = (refused: FollowRefusal, reason: string, status: 400 | 404 | 409 = 400): FollowCheck => ({ ok: false, refused, reason, status });
  if (!followUpEnabled(env)) return no("off", "Follow-ups are not switched on here.");
  const parent = getTaskById(input.parentId);
  const missing = () => no("not_found", "That job was not found, or it is not yours to follow up.", 404);
  if (!parent) return missing();
  // The job's own token proves that whoever holds it hired the job, under whatever name the follow-up is made:
  // somebody who hired a free agent without signing in may pay for the next turn from their wallet. Without the
  // token the names must match, and a job hired without signing in cannot be followed at all.
  if (!input.tokenOk && (parent.fromAgent === "anonymous" || !sameParty(parent.fromAgent, input.from))) return missing();
  if (parent.workflowId || parent.quorumId) return no("kind", "A follow-up continues a single hire. This job was one step of a larger piece of work.");
  if (parent.status !== "completed") return no("not_finished", "That job has not finished. A follow-up continues a finished job.", 409);
  const broughtIn = Boolean(input.to && input.to !== parent.toAgent);
  if (broughtIn) {
    if (!bringInEnabled(env)) return no("other_agent", `A follow-up goes to the agent that did the job (${parent.toAgent}).`);
    // an agent on its own server is sent a job's words and nothing else: it would join without the conversation
    const joining = getAgentById(input.to!);
    if (joining?.endpoint && !joining.orchestrator) return no("own_server", `${joining.name} runs on its own server and cannot be brought into a conversation. Hire it with a job of its own.`);
  }
  const turn = turnOf(parent) + 1, most = maxTurns(env);
  if (turn > most) return no("too_long", `This conversation has reached ${most} turns. Start a new hire to go on.`);
  return { ok: true, parent, thread: parent.threadId ?? parent.taskId, turn, broughtIn };
}

/**
 * The files a follow-up carries from the job before: what the agent handed back first (that is what a follow-up is
 * most often about), then what it was given. Files uploaded with the follow-up itself (`fresh`) come before both.
 * Together they stay inside what one hire may carry; what does not fit is left behind and named. Of a file that has
 * been revised only the latest version goes along: the earlier ones stay with the jobs that made them.
 */
export function carriedFiles(parent: Pick<Task, "taskId">, fresh: FileRow[], reads: Reads, paid: boolean): { carried: FileRow[]; left: LeftBehind[] } {
  const made = filesOfTask(parent.taskId, "out").reverse(), given = filesOfTask(parent.taskId, "in");
  const fit = fitForHire(latestOnly([...fresh, ...made, ...given]), reads, paid);
  const isFresh = new Set(fresh.map((f) => f.id));
  return { carried: fit.rows.filter((r) => !isFresh.has(r.id)), left: fit.left };
}

/** What a follow-up's context says about itself. */
export interface FollowNote { of: string; thread: string; turn: number; notCarried?: LeftBehind[]; broughtIn?: true; after?: string }
export const followNote = (check: { parent: Task; thread: string; turn: number; broughtIn?: boolean }, left: LeftBehind[]): FollowNote => ({
  of: check.parent.taskId,
  thread: check.thread,
  turn: check.turn,
  // another agent was brought in: the agent whose work it follows is named, so the job's commitment covers the hand-over
  ...(check.broughtIn ? { broughtIn: true as const, after: check.parent.toAgent } : {}),
  ...(left.length ? { notCarried: left } : {}),
});

const cut = (text: string, most: number): string => (text.length <= most ? text : `${text.slice(0, most)}\n[The rest is left out here: ${text.length - most} more characters.]`);

/**
 * What an agent is told before a follow-up's own words: that it is one, and the conversation so far. The latest
 * turns are kept whole first; when the conversation is longer than an agent is given, the oldest turns are left out
 * and that is said. Empty for a hire that follows nothing.
 */
export function conversationBefore(task: Pick<Task, "taskId" | "parentTaskId" | "context"> & { toAgent?: string }): string {
  const earlier = earlierTurns(task);
  if (!earlier.length) return "";
  // More than one agent can have worked on a conversation. Each earlier answer is put down as the agent's own or as
  // the named agent's that gave it, so an agent brought in knows whose work it is building on.
  const me = task.toAgent ?? earlier.at(-1)!.toAgent;
  const names = new Map<string, string>();
  const nameOf = (agentId: string): string => {
    if (!names.has(agentId)) names.set(agentId, getAgentById(agentId)?.name ?? agentId);
    return names.get(agentId)!;
  };
  const blocks: string[] = [];
  let room: number = HISTORY.total;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const t = earlier[i];
    const who = t.toAgent === me ? "You answered" : `${nameOf(t.toAgent)}, another agent, answered`;
    const block = `[Turn ${i + 1}] The person asked:\n${cut(t.task, HISTORY.question)}\n\n${who}:\n${cut(t.output ?? "", HISTORY.answer)}`;
    if (block.length > room && blocks.length) break;
    blocks.unshift(block);
    room -= block.length;
  }
  const dropped = earlier.length - blocks.length;
  const note = (task.context?.[FOLLOW_KEY] ?? null) as FollowNote | null;
  const left = Array.isArray(note?.notCarried) && note.notCarried.length
    ? `\n\nNot carried over from before: ${note.notCarried.map((f) => `${f.name} (${f.why})`).join("; ")}.`
    : "";
  const mine = earlier.filter((t) => t.toAgent === me).length;
  const others = [...new Set(earlier.filter((t) => t.toAgent !== me).map((t) => nameOf(t.toAgent)))];
  const intro = mine === earlier.length
    ? "This is a follow-up. You did the earlier work in this conversation: carry on from it, do not start over. The files from before, the ones you were given and the ones you made, are attached again where they fit."
    : mine === 0
      ? `You are being brought into a job that ${others.join(" and ")} started. The person now asks you for something: build on the work that is there, do not start it over. The files from before, the ones the person gave and the ones made so far, are attached again where they fit.`
      : `This is a follow-up in a conversation you have worked on together with ${others.join(" and ")}. Carry on from where it stands, do not start over. The files from before, the ones the person gave and the ones made so far, are attached again where they fit.`;
  return [
    intro,
    `Conversation so far:${dropped ? `\n(${dropped} earlier ${dropped === 1 ? "turn is" : "turns are"} left out to keep this short.)` : ""}`,
    blocks.join("\n\n"),
  ].join("\n\n") + left + "\n\nThe person now says:\n";
}

/** What a reader of a job is told about following it up. Null while follow-ups are off. */
export function followUpView(task: Task, env: Record<string, string | undefined> = process.env): { thread: string; turn: number; of?: string; open: boolean; turnsLeft: number } | null {
  if (!followUpEnabled(env)) return null;
  const turn = turnOf(task), left = Math.max(0, maxTurns(env) - turn);
  return {
    thread: task.threadId ?? task.taskId,
    turn,
    ...(task.parentTaskId ? { of: task.parentTaskId } : {}),
    open: task.status === "completed" && !task.workflowId && !task.quorumId && left > 0,
    turnsLeft: left,
  };
}

/** The follow-ups of a job, oldest first: the turns that came directly after it. */
export function followUpsOf(taskId: string): string[] {
  return (getDb().prepare("SELECT task_id FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC").all(taskId) as { task_id: string }[]).map((r) => r.task_id);
}
