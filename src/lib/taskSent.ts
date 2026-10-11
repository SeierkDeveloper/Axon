// What a job's browser sent.
//
// A form an agent fills in and sends is something done in the person's name on somebody else's site. The person
// has to be able to see exactly what went where: each form sent is written down with the job, the page it was on,
// the button that sent it and every field with what was in it. Whoever may read the job reads this with it. It is
// on no receipt and in no public trace: what a person had typed into a form is theirs.

import { getDb } from "./db";
import { scrubSecrets } from "./scrubSecrets";
import { logger } from "./logger";

/** Forms one job may send. Far more than any job should. */
export const MAX_SENT_PER_JOB = 10;
export const MAX_SENT_FIELDS = 30;

export interface SentField { label: string; value: string }
export interface SentForm { n: number; url: string; button: string; fields: SentField[]; at: string }

const clip = (s: unknown, n: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Write down a form a job's browser sent. Returns false when it is not kept. Never throws. */
export function recordSent(taskId: string, sent: { url: string; button?: string; fields: SentField[] }, now = Date.now()): boolean {
  try {
    let url: URL;
    try { url = new URL(sent.url); } catch { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const db = getDb();
    const had = db.prepare("SELECT COALESCE(MAX(n), 0) n FROM task_sent WHERE task_id = ?").get(taskId) as { n: number };
    if (had.n >= MAX_SENT_PER_JOB) return false;
    const fields = (Array.isArray(sent.fields) ? sent.fields : []).slice(0, MAX_SENT_FIELDS)
      .map((f) => ({ label: clip(f?.label, 80), value: scrubSecrets(clip(f?.value, 400)) }))
      .filter((f) => f.label || f.value);
    db.prepare("INSERT INTO task_sent (task_id, n, url, button, fields, at) VALUES (?,?,?,?,?,?)")
      .run(taskId, had.n + 1, `${url.origin}${url.pathname}`.slice(0, 2000), clip(sent.button, 80), JSON.stringify(fields), new Date(now).toISOString());
    return true;
  } catch (err) {
    logger.warn("task_sent.write_failed", "A sent form could not be written down", { taskId, err });
    return false;
  }
}

/** The forms a job's browser sent, in the order it sent them. */
export function sentOf(taskId: string): SentForm[] {
  try {
    const rows = getDb().prepare("SELECT n, url, button, fields, at FROM task_sent WHERE task_id = ? ORDER BY n ASC").all(taskId) as { n: number; url: string; button: string; fields: string; at: string }[];
    return rows.map((r) => {
      let fields: SentField[] = [];
      try { const f = JSON.parse(r.fields) as unknown; if (Array.isArray(f)) fields = f.filter((x): x is SentField => Boolean(x) && typeof (x as SentField).label === "string" && typeof (x as SentField).value === "string"); } catch { /* an unreadable row shows no fields */ }
      return { n: r.n, url: r.url, button: r.button, fields, at: r.at };
    });
  } catch {
    return [];
  }
}
