// Work with your agent: your library.
//
// Everything a person has had done, in one place: each conversation with the agents that worked on it, what was
// asked and answered, every file that came back and every version of it, and for each job the receipt that proves
// it. A conversation in the library can be opened again and carried on.
//
// The library is the person's, found by the same mark as their memory with agents: their wallet, or the key their
// browser keeps (of which only a hash is stored). Somebody who has both (signed in, on the browser they hired from)
// reads both as one library. Whoever holds a mark reads what hangs on it; nobody else can, the owner of an agent
// included. Taking a conversation out of the library unties it from the person; the jobs and
// their public receipts stay, as jobs and receipts always do.
//
// Off until AGENT_LIBRARY=on.

import { getDb } from "./db";
import { pagesOf } from "./taskPages";
import { getAgentById } from "./agents";
import { claimTokenFor } from "./claimToken";
import { filesEnabled, filesOfTask, latestOnly, outputFileFor, type FileRow, type OutputFile } from "./agentFiles";
import { sitesEnabled, siteViewOf } from "./agentSites";

type Env = Record<string, string | undefined>;

export function libraryEnabled(env: Env = process.env): boolean {
  return (env.AGENT_LIBRARY ?? "off").trim().toLowerCase() === "on";
}

export const LIBRARY = { page: 20, most: 50, askChars: 160, files: 100 } as const;

/** Whose library a job belongs to, or null. */
export function libraryOwnerOf(taskId: string): string | null {
  return (getDb().prepare("SELECT library_owner o FROM tasks WHERE task_id = ?").get(taskId) as { o: string | null } | undefined)?.o ?? null;
}
export function setLibraryOwner(taskId: string, owner: string | null): void {
  if (owner) getDb().prepare("UPDATE tasks SET library_owner = ? WHERE task_id = ?").run(owner, taskId);
}

const clip = (s: string, most: number): string => { const flat = s.replace(/\s+/g, " ").trim(); return flat.length > most ? `${flat.slice(0, most - 1).trimEnd()}…` : flat; };
const agentOf = (agentId: string): { id: string; name: string; price: string | null } => {
  const a = getAgentById(agentId);
  return { id: agentId, name: a?.name ?? agentId, price: a?.price ?? null };
};

/** One conversation as the library lists it. */
export interface ConversationSummary {
  thread: string;
  /** the agent hired first, and every agent that worked on it, in the order they joined */
  agent: { id: string; name: string };
  agents: string[];
  /** the agent that did the latest turn: the one a follow-up goes to */
  lastAgent: { id: string; name: string };
  turns: number;
  asked: string;
  startedAt: string;
  lastAt: string;
  /** where the latest turn stands */
  status: string;
  files: number;
  lastTaskId: string;
  /** hired on the site without signing in: it can be carried on from the agent's page */
  onSite: boolean;
}

interface Row { task_id: string; thread: string; from_agent: string; to_agent: string; task: string; status: string; created_at: string; completed_at: string | null }

const marks = (owners: string[]): string => owners.map(() => "?").join(",");
const mine = (owners: string[]): string[] => [...new Set(owners.filter(Boolean))].slice(0, 2);

/**
 * A person's conversations, the latest first. With `agentId`, only those that agent worked on. A hire that was never
 * followed up is a conversation of one turn.
 */
export function conversationsOf(owners: string[], o: { agentId?: string | null; limit?: number } = {}): ConversationSummary[] {
  const who = mine(owners);
  if (!who.length) return [];
  const db = getDb(), limit = Math.max(1, Math.min(LIBRARY.most, Math.floor(o.limit ?? LIBRARY.page)));
  const rows = db.prepare(
    `SELECT task_id, COALESCE(thread_id, task_id) AS thread, from_agent, to_agent, task, status, created_at, completed_at
     FROM tasks WHERE library_owner IN (${marks(who)}) ORDER BY created_at ASC, rowid ASC`,
  ).all(...who) as Row[];
  const byThread = new Map<string, Row[]>();
  for (const r of rows) byThread.set(r.thread, [...(byThread.get(r.thread) ?? []), r]);
  const out: ConversationSummary[] = [];
  for (const [thread, turns] of byThread) {
    const agents = [...new Set(turns.map((t) => t.to_agent))];
    if (o.agentId && !agents.includes(o.agentId)) continue;
    const first = turns[0], last = turns.at(-1)!;
    // a file that was revised counts once, however many versions of it there are
    const files = filesEnabled()
      ? latestOnly(db.prepare(`SELECT * FROM task_files WHERE direction = 'out' AND deleted_at IS NULL AND task_id IN (${marks(turns.map((t) => t.task_id))})`).all(...turns.map((t) => t.task_id)) as FileRow[]).length
      : 0;
    out.push({
      thread,
      agent: { id: first.to_agent, name: agentOf(first.to_agent).name },
      agents: agents.map((a) => agentOf(a).name),
      lastAgent: { id: last.to_agent, name: agentOf(last.to_agent).name },
      turns: turns.length,
      asked: clip(first.task, LIBRARY.askChars),
      startedAt: first.created_at,
      lastAt: last.completed_at ?? last.created_at,
      status: last.status,
      files,
      lastTaskId: last.task_id,
      onSite: first.from_agent === "anonymous",
    });
  }
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0)).slice(0, limit);
}

/** One turn of a conversation, as its owner reads it back. */
export interface LibraryTurn {
  taskId: string;
  /** what reads this job again and follows it up: the person proved the conversation is theirs */
  claimToken: string;
  agent: { id: string; name: string; price: string | null };
  task: string;
  status: string;
  output: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  outputFiles: OutputFile[];
  /** where the job's browser went, for a job that used one */
  pages: { n: number; url: string; title: string }[];
  /** the page the job built or changed, for a job that did: what it is called, its version, and where it opens */
  site?: { siteId: string; title: string; version: number; url: string };
  /** the proof: the job's public receipt, which carries the hash of the answer and of every file */
  receipt: string;
}

/** A conversation in full, oldest turn first. Null when it is not in this person's library. */
export function conversationOf(owners: string[], thread: string): { thread: string; turns: LibraryTurn[] } | null {
  const who = mine(owners);
  if (!who.length) return null;
  const rows = getDb().prepare(
    `SELECT task_id, to_agent, task, status, output, error, created_at, completed_at
     FROM tasks WHERE library_owner IN (${marks(who)}) AND (task_id = ? OR thread_id = ?) ORDER BY created_at ASC, rowid ASC`,
  ).all(...who, thread, thread) as { task_id: string; to_agent: string; task: string; status: string; output: string | null; error: string | null; created_at: string; completed_at: string | null }[];
  if (!rows.length) return null;
  return {
    thread,
    turns: rows.map((r) => ({
      taskId: r.task_id,
      claimToken: claimTokenFor(r.task_id),
      agent: agentOf(r.to_agent),
      task: r.task,
      status: r.status,
      output: r.output,
      error: r.error,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      outputFiles: filesEnabled() ? filesOfTask(r.task_id, "out").map((f) => outputFileFor(f)) : [],
      pages: pagesOf(r.task_id).map((p) => ({ n: p.n, url: p.url, title: p.title })),
      ...(() => { const site = sitesEnabled() ? siteViewOf(r.task_id) : null; return site ? { site } : {}; })(),
      receipt: `/r/${r.task_id}`,
    })),
  };
}

/** A page an agent built for this person: where it opens, and the job (with what reads it) that last changed it. */
export interface LibraryPage { siteId: string; title: string; version: number; url: string; updatedAt: string; taskId: string; claimToken: string; thread: string; agent: { id: string; name: string }; receipt: string }

/**
 * Every page agents built for this person that is still up, the one changed last first. Each comes with the job
 * that made the version it shows, so its versions, its answers and its files can be reached from the list.
 */
export function pagesBuiltFor(owners: string[], o: { limit?: number } = {}): LibraryPage[] {
  const who = mine(owners);
  if (!who.length || !sitesEnabled()) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 50)));
  // a page is this person's when a job of theirs made a version of it; the job named is the newest such one
  const rows = getDb().prepare(
    `SELECT s.site_id, s.title, s.version, s.updated_at, s.agent_id, t.task_id, COALESCE(t.thread_id, t.task_id) AS thread
     FROM built_sites s
     JOIN built_site_versions v ON v.site_id = s.site_id
     JOIN tasks t ON t.task_id = v.task_id
     WHERE s.status = 'live' AND s.version > 0 AND t.library_owner IN (${marks(who)})
       AND v.version = (SELECT MAX(v2.version) FROM built_site_versions v2 JOIN tasks t2 ON t2.task_id = v2.task_id WHERE v2.site_id = s.site_id AND t2.library_owner IN (${marks(who)}))
     ORDER BY s.updated_at DESC LIMIT ?`,
  ).all(...who, ...who, limit) as { site_id: string; title: string; version: number; updated_at: string; agent_id: string; task_id: string; thread: string }[];
  return rows.map((r) => ({
    siteId: r.site_id, title: r.title, version: r.version, url: `/s/${r.site_id}`, updatedAt: r.updated_at, taskId: r.task_id, claimToken: claimTokenFor(r.task_id), thread: r.thread,
    agent: { id: r.agent_id, name: getAgentById(r.agent_id)?.name ?? r.agent_id }, receipt: `/r/${r.task_id}`,
  }));
}

/** A file in the library: the file as its reader gets it, and the job and conversation it came from. */
export interface LibraryFile extends OutputFile { taskId: string; thread: string; agent: { id: string; name: string }; createdAt: string; receipt: string }

/**
 * Every file agents handed back to this person, the latest first. Of a file that was revised only the latest
 * version is listed, with its version number; the earlier ones are reached from it (GET /api/files/{id}/versions).
 */
export function filesOf(owners: string[], o: { limit?: number } = {}): LibraryFile[] {
  const who = mine(owners);
  if (!who.length || !filesEnabled()) return [];
  const limit = Math.max(1, Math.min(LIBRARY.files, Math.floor(o.limit ?? LIBRARY.files)));
  const rows = getDb().prepare(
    `SELECT f.*, COALESCE(t.thread_id, t.task_id) AS thread, t.to_agent AS to_agent
     FROM task_files f JOIN tasks t ON t.task_id = f.task_id
     WHERE t.library_owner IN (${marks(who)}) AND f.direction = 'out' AND f.deleted_at IS NULL
     ORDER BY f.created_at DESC, f.id DESC LIMIT 500`,
  ).all(...who) as (FileRow & { thread: string; to_agent: string })[];
  // a line of versions lives inside one conversation: the same name in two conversations is two files
  const byThread = new Map<string, (FileRow & { thread: string; to_agent: string })[]>();
  for (const r of rows) byThread.set(r.thread, [...(byThread.get(r.thread) ?? []), r]);
  const keep = new Set<string>();
  for (const list of byThread.values()) for (const r of latestOnly(list)) keep.add(r.id);
  return rows.filter((r) => keep.has(r.id)).slice(0, limit).map((r) => ({
    ...outputFileFor(r),
    taskId: r.task_id!,
    thread: r.thread,
    agent: { id: r.to_agent, name: agentOf(r.to_agent).name },
    createdAt: r.created_at,
    receipt: `/r/${r.task_id}`,
  }));
}

/**
 * Take a conversation out of a person's library. The jobs, their files and their receipts are left as they are: only
 * the tie to the person goes. Returns how many jobs were untied.
 */
export function removeConversation(owners: string[], thread: string): number {
  const who = mine(owners);
  if (!who.length) return 0;
  return getDb().prepare(`UPDATE tasks SET library_owner = NULL WHERE library_owner IN (${marks(who)}) AND (task_id = ? OR thread_id = ?)`).run(...who, thread, thread).changes;
}
