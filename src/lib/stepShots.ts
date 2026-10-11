// Watch it work, with pictures.
//
// A line in a job's live log says what the agent did ("Clicking Search"). When it did it in a browser, the line can
// carry a picture of the page as it was right after. The picture is a stored file like any other: held once per
// content, read only with its own token by whoever may read the job, gone when its time is up. It is not one of the
// job's deliverables, it is on no receipt, and nothing that lists a job's files ever shows it.
//
// Off unless files are on: the file store is where a picture lives.

import { getDb } from "./db";
import { filesEnabled, fileTokenFor, getFile, storeFile } from "./agentFiles";
import { logger } from "./logger";

/** Pictures one job's log may carry. */
export const MAX_SHOTS_PER_JOB = 40;
/** A picture larger than this is not kept: a screen of a page is far smaller. */
export const MAX_SHOT_BYTES = 1_500_000;

/** A step's picture as the job's reader gets it: the path and token that fetch it. */
export interface StepShot { id: string; token: string; path: string; size: number }

/**
 * Keep a picture with one line of a job's log. Returns false, and keeps nothing, when pictures cannot be kept here,
 * when the bytes are not a picture, or when the job already has its share. Never throws: a job must not fail
 * because a picture of it could not be kept.
 */
export function keepStepShot(input: { taskId: string; sequence: number; bytes: Buffer; wallet?: string | null }, o: { now?: number; env?: Record<string, string | undefined> } = {}): boolean {
  try {
    if (!filesEnabled(o.env) || !Number.isInteger(input.sequence) || input.sequence < 1) return false;
    if (input.bytes.length === 0 || input.bytes.length > MAX_SHOT_BYTES) return false;
    const db = getDb();
    const had = db.prepare("SELECT COUNT(*) n FROM task_step_shots WHERE task_id = ?").get(input.taskId) as { n: number };
    if (had.n >= MAX_SHOTS_PER_JOB) return false;
    const kept = storeFile({ bytes: input.bytes, name: `step-${input.sequence}.jpg`, wallet: input.wallet ?? null, direction: "shot", taskId: input.taskId }, o);
    if (!kept.ok || kept.file.kind !== "image") {
      if (kept.ok) db.prepare("UPDATE task_files SET deleted_at = ? WHERE id = ?").run(new Date(o.now ?? Date.now()).toISOString(), kept.file.id);
      else logger.info("step_shot.refused", "A step's picture was not kept", { taskId: input.taskId, refused: kept.refused });
      return false;
    }
    db.prepare("INSERT OR REPLACE INTO task_step_shots (task_id, sequence, file_id) VALUES (?,?,?)").run(input.taskId, input.sequence, kept.file.id);
    return true;
  } catch (err) {
    logger.warn("step_shot.failed", "A step's picture could not be kept", { taskId: input.taskId, err });
    return false;
  }
}

/** The pictures of a job's steps that are still stored, by the step's place in the log. */
export function shotsOf(taskId: string, now = Date.now()): Map<number, StepShot> {
  const out = new Map<number, StepShot>();
  try {
    const rows = getDb().prepare("SELECT sequence, file_id FROM task_step_shots WHERE task_id = ? ORDER BY sequence ASC").all(taskId) as { sequence: number; file_id: string }[];
    for (const r of rows) {
      const f = getFile(r.file_id, now);
      if (f && f.direction === "shot" && f.task_id === taskId) out.set(r.sequence, { id: f.id, token: fileTokenFor(f.id), path: `/api/files/${f.id}/content`, size: f.size });
    }
  } catch {
    /* a log without its pictures is still a log */
  }
  return out;
}
