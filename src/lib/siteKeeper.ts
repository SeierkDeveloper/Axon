// Agents that build: pages that update themselves.
//
// A job that starts itself runs again and again: on a schedule (a retainer), or when something happens (a trigger).
// When such a job builds a page, the next run does not build another: it is handed the page as it stands and changes
// it, so the page keeps one link and that link always shows the newest run's work. Nothing has to be set up for
// this. The page a schedule or a trigger keeps is simply the one its own earlier runs built.
//
// So a person asks once ("every morning, a page with today's menu", "when this address is called, put what arrived
// on the board") and shares one link.

import { getDb } from "./db";
import { getSite, siteOfTasks, type Site } from "./agentSites";

export interface Keeper { kind: "schedule" | "trigger"; id: string }

/** The schedule or trigger a job is a run of, or null for a job somebody started by hand. */
export function keeperOfTask(taskId: string): Keeper | null {
  const db = getDb();
  const r = db.prepare("SELECT retainer_id id FROM retainer_runs WHERE task_id = ? LIMIT 1").get(taskId) as { id: string } | undefined;
  if (r) return { kind: "schedule", id: r.id };
  const t = db.prepare("SELECT trigger_id id FROM trigger_runs WHERE task_id = ? LIMIT 1").get(taskId) as { id: string } | undefined;
  return t ? { kind: "trigger", id: t.id } : null;
}

/** The jobs a schedule or a trigger has started so far. */
function runsOf(k: Keeper): string[] {
  const rows = (k.kind === "schedule"
    ? getDb().prepare("SELECT task_id FROM retainer_runs WHERE retainer_id = ? AND task_id IS NOT NULL").all(k.id)
    : getDb().prepare("SELECT task_id FROM trigger_runs WHERE trigger_id = ? AND task_id IS NOT NULL").all(k.id)) as { task_id: string }[];
  return rows.map((r) => r.task_id);
}

/** The page a schedule or a trigger keeps: the newest live one its runs built or changed. Null when none has. */
export function siteKeptBy(k: Keeper): Site | null {
  return siteOfTasks(runsOf(k));
}

/** The page this job is to bring up to date, when it is a run of something that keeps one. */
export function siteKeptForTask(taskId: string): Site | null {
  const k = keeperOfTask(taskId);
  return k ? siteKeptBy(k) : null;
}

/** What keeps a page up to date, when something does: the schedule or trigger whose runs made its versions. */
export function keeperOfSite(siteId: string): Keeper | null {
  const site = getSite(siteId);
  if (!site) return null;
  const tasks = (getDb().prepare("SELECT DISTINCT task_id FROM built_site_versions WHERE site_id = ? ORDER BY version DESC").all(siteId) as { task_id: string }[]).map((r) => r.task_id);
  for (const taskId of tasks) {
    const k = keeperOfTask(taskId);
    // only while it still keeps this page: a schedule that has since built another no longer does
    if (k && siteKeptBy(k)?.siteId === siteId) return k;
  }
  return null;
}

export interface KeptPage { siteId: string; title: string; version: number; path: string; updatedAt: string }

/** The page a schedule or trigger keeps, as its owner is told about it. */
export function keptPage(k: Keeper): KeptPage | null {
  try {
    const site = siteKeptBy(k);
    return site ? { siteId: site.siteId, title: site.title, version: site.version, path: `/s/${site.siteId}`, updatedAt: site.updatedAt } : null;
  } catch {
    // a schedule is still a schedule where pages are not kept at all
    return null;
  }
}
