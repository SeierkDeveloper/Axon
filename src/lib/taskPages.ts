// The pages a job's browser was on.
//
// An agent that went somewhere to find its answer should be able to show where. Each page its browser lands on is
// written down with the job once, in the order it first got there: the address and the page's title, nothing of its
// contents. A page it came back to is still one page. Whoever may
// read the job gets the list with it, and the answer is shown with its pages as links.

import { getDb } from "./db";
import { logger } from "./logger";

/** Pages one job's list holds. A job has far fewer browser steps than this. */
export const MAX_PAGES_PER_JOB = 40;

export interface VisitedPage { n: number; url: string; title: string; at: string }

/** An address as it is compared: without what follows a #, which is a place on the same page. */
const same = (a: string, b: string): boolean => a.split("#")[0] === b.split("#")[0];

/**
 * Write down that a job's browser is on this page. Only a web address is ever kept; a page the job has been on
 * before is not written again; and a job keeps only so many. Never throws: a job must not fail over its list of pages.
 */
export function recordPage(taskId: string, page: { url: string; title?: string }, now = Date.now()): boolean {
  try {
    let url: URL;
    try { url = new URL(page.url); } catch { return false; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const db = getDb();
    const had = db.prepare("SELECT n, url FROM task_pages WHERE task_id = ? ORDER BY n ASC").all(taskId) as { n: number; url: string }[];
    const text = url.toString().slice(0, 2000);
    if (had.some((p) => same(p.url, text))) return false;
    if (had.length >= MAX_PAGES_PER_JOB) return false;
    db.prepare("INSERT INTO task_pages (task_id, n, url, title, at) VALUES (?,?,?,?,?)").run(taskId, (had.at(-1)?.n ?? 0) + 1, text, String(page.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200), new Date(now).toISOString());
    return true;
  } catch (err) {
    logger.warn("task_pages.write_failed", "A visited page could not be written down", { taskId, err });
    return false;
  }
}

/** The pages a job's browser was on, each once, in the order it first got there. */
export function pagesOf(taskId: string): VisitedPage[] {
  try {
    return getDb().prepare("SELECT n, url, title, at FROM task_pages WHERE task_id = ? ORDER BY n ASC").all(taskId) as VisitedPage[];
  } catch {
    return [];
  }
}
