// Autonomy, the third update: the record of the jobs the network gives itself, and the tick that starts them.
//
// Each part of the update (lib/autonomy3Policy.ts) registers what it does on a tick. The tick runs every few
// minutes, asks each part that is switched on whether it has a turn (the day's fixed number of jobs, spread over
// the day), and lets it work. Every job is a row in autonomy3_jobs: opened when it starts, closed when it ends.
//
// Nothing here is public. The admin page reads the whole record; the public page will get counts at the release.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { logger } from "./logger";
import { PARTS, PART_ORDER, autonomy3On, partOn, partSwitch, jobsADay, paceWindow, dueByNow, hasTurn, worstDayUsd, type Part } from "./autonomy3Policy";

type Env = Record<string, string | undefined>;

export interface Autonomy3Job {
  id: string;
  part: Part;
  subject: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  summary: string | null;
  detail: unknown;
  costUsd: number;
}

type Row = { id: string; part: string; subject: string | null; started_at: string; finished_at: string | null; outcome: string | null; summary: string | null; detail: string | null; cost_usd: number };

function fromRow(r: Row): Autonomy3Job {
  let detail: unknown = null;
  try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* kept as null: a record that cannot be read is not worth a failed page */ }
  return { id: r.id, part: r.part as Part, subject: r.subject, startedAt: r.started_at, finishedAt: r.finished_at, outcome: r.outcome, summary: r.summary, detail, costUsd: r.cost_usd };
}

/** Open a job. Returns its id, or null when the record cannot be written (before migration 126): then the job is not done either. */
export function startJob(part: Part, subject: string | null = null, nowMs = Date.now()): string | null {
  const id = randomUUID();
  try {
    getDb().prepare("INSERT INTO autonomy3_jobs (id, part, subject, started_at) VALUES (?, ?, ?, ?)").run(id, part, subject, new Date(nowMs).toISOString());
    return id;
  } catch (err) {
    logger.warn("autonomy3.job_not_recorded", "An Autonomy 3 job could not be recorded, so it was not started", { part, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Open a job only if no job of this part is recorded for the same subject yet, for the parts that may act on a thing
 * once (a failed job is moved once). Returns null when one is already there.
 */
export function claimJob(part: Part, subject: string, nowMs = Date.now()): string | null {
  const id = randomUUID();
  try {
    const db = getDb();
    const taken = db.prepare("SELECT 1 FROM autonomy3_jobs WHERE part = ? AND subject = ? LIMIT 1").get(part, subject);
    if (taken) return null;
    const { changes } = db.prepare("INSERT OR IGNORE INTO autonomy3_jobs (id, part, subject, started_at) VALUES (?, ?, ?, ?)").run(id, part, subject, new Date(nowMs).toISOString());
    return changes === 1 ? id : null;
  } catch (err) {
    logger.warn("autonomy3.job_not_recorded", "An Autonomy 3 job could not be recorded, so it was not started", { part, reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The job of a part about one subject, if there is one. */
export function jobFor(part: Part, subject: string): Autonomy3Job | null {
  try {
    const r = getDb().prepare("SELECT * FROM autonomy3_jobs WHERE part = ? AND subject = ? ORDER BY started_at DESC LIMIT 1").get(part, subject) as Row | undefined;
    return r ? fromRow(r) : null;
  } catch {
    return null;
  }
}

/** Close a job with how it ended. */
export function finishJob(id: string, end: { outcome: string; summary?: string; detail?: unknown; costUsd?: number }, nowMs = Date.now()): void {
  try {
    getDb()
      .prepare("UPDATE autonomy3_jobs SET finished_at = ?, outcome = ?, summary = ?, detail = ?, cost_usd = ? WHERE id = ?")
      .run(new Date(nowMs).toISOString(), end.outcome, end.summary ?? null, end.detail === undefined ? null : JSON.stringify(end.detail), end.costUsd ?? 0, id);
  } catch (err) {
    logger.warn("autonomy3.job_not_closed", "An Autonomy 3 job could not be closed in the record", { id, reason: err instanceof Error ? err.message : String(err) });
  }
}

/** How many jobs a part has started in the stretch its number is counted over (a day, for most). */
export function startedInWindow(part: Part, nowMs = Date.now(), env: Env = process.env): number {
  const perDay = jobsADay(part, env);
  const from = perDay === null ? Math.floor(nowMs / 86_400_000) * 86_400_000 : paceWindow(perDay, nowMs).from;
  try {
    const { n } = getDb().prepare("SELECT COUNT(*) n FROM autonomy3_jobs WHERE part = ? AND started_at >= ?").get(part, new Date(from).toISOString()) as { n: number };
    return n;
  } catch {
    return 0; // before migration 126
  }
}

/** Whether a part may start one more job now: it is switched on, and its jobs for the day so far are not all started. */
export function mayStart(part: Part, nowMs = Date.now(), env: Env = process.env): boolean {
  return hasTurn(part, startedInWindow(part, nowMs, env), nowMs, env);
}

/** The latest jobs, newest first. */
export function recentJobs(limit = 100, part?: Part): Autonomy3Job[] {
  try {
    const db = getDb();
    const rows = part
      ? db.prepare("SELECT * FROM autonomy3_jobs WHERE part = ? ORDER BY started_at DESC LIMIT ?").all(part, limit)
      : db.prepare("SELECT * FROM autonomy3_jobs ORDER BY started_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(fromRow);
  } catch {
    return [];
  }
}

// ── The tick ──────────────────────────────────────────────────────────────────

export interface TickContext { nowMs: number; env: Env }
type Handler = (ctx: TickContext) => Promise<void>;

/** What each part does on a tick. A part registers itself here when it is built; a part with nothing here does nothing. */
const HANDLERS = new Map<Part, Handler>();

export function onTick(part: Part, handler: Handler): void {
  HANDLERS.set(part, handler);
}

export interface TickResult { on: boolean; ran: Part[]; failed: { part: Part; reason: string }[] }

/**
 * One tick: every part that is switched on and has something to do gets its go. A part that throws is named in the
 * result and the others still run; the next tick tries it again.
 */
export async function tick(nowMs = Date.now(), env: Env = process.env): Promise<TickResult> {
  const result: TickResult = { on: autonomy3On(env), ran: [], failed: [] };
  if (!result.on) return result;
  for (const part of PART_ORDER) {
    const handler = HANDLERS.get(part);
    if (!handler || !partOn(part, env)) continue;
    try {
      await handler({ nowMs, env });
      result.ran.push(part);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push({ part, reason });
      logger.warn("autonomy3.part_failed", "An Autonomy 3 part failed on this tick", { part, reason });
    }
  }
  return result;
}

// ── What the admin page shows ─────────────────────────────────────────────────

export interface PartState {
  part: Part;
  name: string;
  does: string;
  switch: string;
  on: boolean;
  built: boolean;
  /** the day's fixed number, or null when the part has none */
  aDay: number | null;
  started: number;
  dueByNow: number | null;
  lastJobAt: string | null;
}

export interface Autonomy3State {
  on: boolean;
  parts: PartState[];
  /** what today's finished jobs cost, estimated */
  spentTodayUsd: number;
  /** the most a day can cost with every part on */
  worstDayUsd: number;
  jobs: Autonomy3Job[];
}

export function autonomy3State(nowMs = Date.now(), env: Env = process.env): Autonomy3State {
  const dayStart = new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();
  let spent = 0;
  const last = new Map<string, string>();
  try {
    const db = getDb();
    spent = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) s FROM autonomy3_jobs WHERE started_at >= ?").get(dayStart) as { s: number }).s;
    for (const r of db.prepare("SELECT part, MAX(started_at) at FROM autonomy3_jobs GROUP BY part").all() as { part: string; at: string }[]) last.set(r.part, r.at);
  } catch { /* before migration 126 */ }
  return {
    on: autonomy3On(env),
    parts: PART_ORDER.map((part) => {
      const aDay = jobsADay(part, env);
      return {
        part,
        name: PARTS[part].name,
        does: PARTS[part].does,
        switch: partSwitch(part),
        on: partOn(part, env),
        built: HANDLERS.has(part),
        aDay,
        started: startedInWindow(part, nowMs, env),
        dueByNow: aDay === null ? null : dueByNow(aDay, nowMs),
        lastJobAt: last.get(part) ?? null,
      };
    }),
    spentTodayUsd: spent,
    worstDayUsd: worstDayUsd(env),
    jobs: recentJobs(100),
  };
}
