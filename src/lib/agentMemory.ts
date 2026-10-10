// Work with your agent: it remembers you.
//
// The second time somebody hires an agent should not start from nothing. An agent keeps two things about a person:
// what it chose to note during earlier jobs (a preference about how they want work done, a lasting fact about them
// or their project), and a short record of the work it did for them before. On the next hire it is told both.
//
// The memory is the person's. It is kept per person and per agent, never shared between agents or between people.
// They can see every line and delete any of it, or all of it, and a hire can say not to use or add to it. A line
// that looks like a secret is not kept. Who a memory is about is a wallet, or for somebody who hires without
// signing in, a key their own browser holds: we keep only its hash, so the key is the one way in.
//
// Off until AGENT_MEMORY=on.

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { isWalletAddress } from "./address";
import { scrubSecrets } from "./scrubSecrets";
import { filesOfTask } from "./agentFiles";
import type { LocalTool, ResolvedTools } from "./agentTools";

type Env = Record<string, string | undefined>;

export function memoryEnabled(env: Env = process.env): boolean {
  return (env.AGENT_MEMORY ?? "off").trim().toLowerCase() === "on";
}

export const MEMORY = {
  /** lines one agent keeps about one person; past it the oldest goes */
  lines: 20,
  lineChars: 240,
  /** lines one job may add */
  perJob: 3,
  /** earlier jobs the agent is reminded of */
  jobs: 4,
  askChars: 200,
  answerChars: 320,
} as const;
export const REMEMBER_TOOL = "remember";

/** A key a browser holds for somebody who hires without signing in: long, random, and nothing else. */
export const validMemoryKey = (key: unknown): key is string => typeof key === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(key);

/**
 * Whose memory this is. A signed-in wallet's memory is its own, whatever key the request also carries. Without a
 * wallet it is the key's, kept as a hash. Null when there is neither: nothing is read and nothing is kept.
 */
export function memoryOwnerFor(who: { wallet?: string | null; key?: unknown }): string | null {
  if (who.wallet && isWalletAddress(who.wallet)) return `w:${who.wallet.toLowerCase()}`;
  return validMemoryKey(who.key) ? `v:${createHash("sha256").update(`axon-memory:${who.key}`).digest("hex")}` : null;
}

/** Whose memory a job reads and adds to, or null. */
export function memoryOwnerOf(taskId: string): string | null {
  return (getDb().prepare("SELECT memory_owner o FROM tasks WHERE task_id = ?").get(taskId) as { o: string | null } | undefined)?.o ?? null;
}
export function setMemoryOwner(taskId: string, owner: string | null): void {
  if (owner) getDb().prepare("UPDATE tasks SET memory_owner = ? WHERE task_id = ?").run(owner, taskId);
}

export interface MemoryLine { id: string; text: string; createdAt: string; taskId: string | null }
interface Row { id: string; text: string; created_at: string; source_task_id: string | null }
const view = (r: Row): MemoryLine => ({ id: r.id, text: r.text, createdAt: r.created_at, taskId: r.source_task_id });

/** What an agent has noted about a person, oldest first. */
export function memoriesOf(owner: string, agentId: string): MemoryLine[] {
  return (getDb().prepare("SELECT id, text, created_at, source_task_id FROM agent_memories WHERE owner = ? AND agent_id = ? ORDER BY created_at ASC, rowid ASC").all(owner, agentId) as Row[]).map(view);
}

/** What one job added to the memory. */
export function rememberedBy(taskId: string): MemoryLine[] {
  return (getDb().prepare("SELECT id, text, created_at, source_task_id FROM agent_memories WHERE source_task_id = ? ORDER BY created_at ASC, rowid ASC").all(taskId) as Row[]).map(view);
}

const looksSecret = (text: string): boolean => scrubSecrets(text) !== text || /\b(?:0x)?[0-9a-fA-F]{64}\b/.test(text) || /\b(?:\d[ -]?){13,19}\b/.test(text);
const same = (a: string, b: string): boolean => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type RememberRefusal = "empty" | "too_long" | "secret" | "known" | "enough";
export type RememberResult = { ok: true; line: MemoryLine } | { ok: false; refused: RememberRefusal; reason: string };

/**
 * Keep one line about a person for an agent. A line that says what is already kept is not kept twice; one that looks
 * like a secret (a key, a token, a password, a card number) is refused; past the cap the oldest line goes.
 */
export function remember(input: { owner: string; agentId: string; text: string; taskId?: string | null }, o: { now?: number } = {}): RememberResult {
  const no = (refused: RememberRefusal, reason: string): RememberResult => ({ ok: false, refused, reason });
  const text = input.text.replace(/\s+/g, " ").trim();
  if (text.length < 4) return no("empty", "Say what to remember in a short sentence.");
  if (text.length > MEMORY.lineChars) return no("too_long", `Keep it to one short sentence, under ${MEMORY.lineChars} characters.`);
  if (looksSecret(text)) return no("secret", "That looks like a secret. Passwords, keys, tokens and card numbers are never kept.");
  const db = getDb();
  const had = memoriesOf(input.owner, input.agentId);
  if (had.some((m) => same(m.text, text))) return no("known", "That is already remembered.");
  if (input.taskId && rememberedBy(input.taskId).length >= MEMORY.perJob) return no("enough", `One job notes at most ${MEMORY.perJob} things. Go on with the work.`);
  const id = `m_${randomBytes(12).toString("hex")}`, createdAt = new Date(o.now ?? Date.now()).toISOString();
  db.transaction(() => {
    db.prepare("INSERT INTO agent_memories (id, owner, agent_id, text, source_task_id, created_at) VALUES (?,?,?,?,?,?)").run(id, input.owner, input.agentId, text, input.taskId ?? null, createdAt);
    const over = had.length + 1 - MEMORY.lines;
    if (over > 0) db.prepare("DELETE FROM agent_memories WHERE id IN (SELECT id FROM agent_memories WHERE owner = ? AND agent_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?)").run(input.owner, input.agentId, over);
  })();
  return { ok: true, line: { id, text, createdAt, taskId: input.taskId ?? null } };
}

/**
 * Delete one line, or with no id everything this agent keeps about this person: every line, and the tie between
 * them and the jobs it did for them, so it is no longer reminded of that work either. Returns how many lines went.
 */
export function forget(owner: string, agentId: string, id?: string): number {
  const db = getDb();
  if (id) return db.prepare("DELETE FROM agent_memories WHERE owner = ? AND agent_id = ? AND id = ?").run(owner, agentId, id).changes;
  return db.transaction(() => {
    db.prepare("UPDATE tasks SET memory_owner = NULL WHERE memory_owner = ? AND to_agent = ?").run(owner, agentId);
    return db.prepare("DELETE FROM agent_memories WHERE owner = ? AND agent_id = ?").run(owner, agentId).changes;
  })();
}

export interface PastJob { taskId: string; when: string; asked: string; answered: string; files: string[] }
const clip = (s: string, most: number): string => { const flat = s.replace(/\s+/g, " ").trim(); return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat; };

/** The last finished jobs this agent did for this person, latest first, as short reminders. Never the job in hand. */
export function pastWork(owner: string, agentId: string, exceptTaskId?: string | null, limit: number = MEMORY.jobs): PastJob[] {
  const rows = getDb().prepare(
    `SELECT task_id, task, output, completed_at FROM tasks
     WHERE memory_owner = ? AND to_agent = ? AND status = 'completed' AND task_id != ?
     ORDER BY completed_at DESC LIMIT ?`,
  ).all(owner, agentId, exceptTaskId ?? "", limit) as { task_id: string; task: string; output: string | null; completed_at: string | null }[];
  return rows.map((r) => ({
    taskId: r.task_id,
    when: (r.completed_at ?? "").slice(0, 10),
    asked: clip(r.task, MEMORY.askChars),
    answered: clip(r.output ?? "", MEMORY.answerChars),
    files: filesOfTask(r.task_id, "out").map((f) => f.name),
  }));
}

/**
 * What an agent is told about the person at the start of a job: what it noted before, and, on a hire that is not
 * a follow-up, the work it did for them earlier. Empty when it knows nothing.
 */
export function memoryNote(owner: string, agentId: string, o: { taskId?: string | null; withWork?: boolean } = {}): string {
  const lines = memoriesOf(owner, agentId), work = o.withWork === false ? [] : pastWork(owner, agentId, o.taskId);
  if (!lines.length && !work.length) return "";
  const parts = ["\n\nYou have worked for this person before. What you know from then:"];
  if (lines.length) parts.push(`What you noted about them:\n${lines.map((m) => `- ${m.text}`).join("\n")}`);
  if (work.length) {
    parts.push(`Earlier jobs you did for them, latest first:\n${work.map((j) => `- ${j.when}: they asked "${j.asked}". You answered: "${j.answered}"${j.files.length ? ` and handed back ${j.files.join(", ")}` : ""}.`).join("\n")}`);
  }
  parts.push("Use this where it helps the job in hand, and follow what they asked for before unless they now say otherwise. Do not recite it back to them.");
  return parts.join("\n\n");
}

/**
 * The tool as one job holds it: the agent notes one thing about the person for next time. `onNoted` hears of each
 * line kept.
 */
export function rememberTool(ctx: { owner: string; agentId: string; taskId: string; onNoted?: (line: MemoryLine) => void }): LocalTool {
  return {
    name: REMEMBER_TOOL,
    label: REMEMBER_TOOL,
    description:
      "Note one thing about the person who hired you, to use the next time they hire you. Use it when they tell you how they want work done (a language, a tone, a format, a length, units, a name to use) or a lasting fact about them or their project that later jobs will need, and whenever they ask you to remember something. One short sentence in the third person, for example: Wants every answer in Swedish. Never note the job itself, a guess about them, or anything they would not expect you to keep, and never a password, key, token or card number. Then go on with the job: do not mention that you noted it unless they asked you to remember.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string", description: "The one thing to remember, as one short sentence" } },
      required: ["note"],
    },
    async run(args) {
      const kept = remember({ owner: ctx.owner, agentId: ctx.agentId, text: typeof args.note === "string" ? args.note : "", taskId: ctx.taskId });
      if (!kept.ok) {
        if (kept.refused === "known") return "Already remembered. Go on with the job.";
        throw new Error(kept.reason);
      }
      ctx.onNoted?.(kept.line);
      return "Noted for next time. Go on with the job.";
    },
  };
}

export const canRemember = (t: ResolvedTools | null | undefined): boolean => Boolean(t?.localTools.some((x) => x.name === REMEMBER_TOOL));
/** The same tools with the remember tool added, if it is not there already. */
export function withRemember(t: ResolvedTools | null | undefined, tool: LocalTool): ResolvedTools {
  const base: ResolvedTools = t ?? { serverTools: [], localTools: [], grants: [] };
  return canRemember(base) ? base : { ...base, localTools: [...base.localTools, tool], grants: [...base.grants, REMEMBER_TOOL] };
}

/** An agent Axon runs on Claude, in the loop that runs tools, can note things. Others are still reminded of past work. */
export const canNote = (agent: { provider?: string | null; orchestrator?: boolean }, o: { viaMcp?: boolean } = {}): boolean =>
  !o.viaMcp && !agent.orchestrator && (agent.provider ?? "anthropic") === "anthropic";

/** What a person sees of an agent's memory of them. */
export function memoryView(owner: string, agentId: string): { lines: MemoryLine[]; jobs: number; most: number } {
  const jobs = (getDb().prepare("SELECT COUNT(*) c FROM tasks WHERE memory_owner = ? AND to_agent = ? AND status = 'completed'").get(owner, agentId) as { c: number }).c;
  return { lines: memoriesOf(owner, agentId), jobs, most: MEMORY.lines };
}
