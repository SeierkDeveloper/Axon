// Autonomy 3, "watches everything": what shipped after Autonomy 2 comes into the check.
//
// Autonomy 2's hourly pass knows agents, jobs, webhooks, prices and the main pages. It knows nothing of the pages
// agents build, the triggers people set, or the jobs that use a browser, because all of it came later. This part
// looks at those, at most every WATCH.everyMinutes, and records what it saw as one job with its findings:
//   - built pages: a live page with nothing to show, one that does not load, one people have reported
//   - triggers: ones that paused themselves (failures, their agent gone, an allowance run out), ones failing now, and
//     page watchers that stopped looking
//   - browser jobs: a day where most of them fail, the day's browsing nearly used up, no browser where one should be,
//     browsers left running
// It reports. It changes nothing: what it finds goes to the admin page, and acting on it is for the parts that react.

import { getDb } from "./db";
import { siteUrl } from "./networkChecks";
import { sitesEnabled } from "./agentSites";
import { dailyBrowsing } from "./browserTool";
import { browserStatus } from "./browserSession";
import { partOn } from "./autonomy3Policy";
import { startJob, finishJob, recentJobs, onTick, type TickContext } from "./autonomy3";

type Env = Record<string, string | undefined>;

export const WATCH = {
  everyMinutes: 30,
  /** live pages loaded on one look, the most recently changed first */
  pagesLoaded: 8,
  pageTimeoutMs: 10_000,
  /** a live page still without a version this long after it was made never got built */
  unbuiltAfterMinutes: 15,
  /** a trigger failing this many times in a row is named, before it pauses itself */
  triggerFailing: 2,
  /** a page watcher that has not looked for this many of its own intervals has stopped */
  watcherLate: 3,
  /** browser jobs in a day before their failure share means anything */
  browserMinJobs: 3,
  browserFailShare: 0.5,
  /** share of the day's browsing used that is worth saying */
  browserNearlyUsed: 0.8,
} as const;

export type WatchKind =
  | "page-empty" | "page-down" | "page-reported"
  | "trigger-paused" | "trigger-failing" | "watcher-stopped"
  | "browser-failing" | "browser-nearly-used" | "browser-missing" | "browser-leftovers";

export interface WatchFinding { kind: WatchKind; subject?: string; what: string }

const iso = (ms: number) => new Date(ms).toISOString();

/** Built pages: live with nothing to show, not loading, or reported by the people who saw them. */
export async function watchPages(nowMs: number, base = siteUrl(), fetchFn: typeof fetch = fetch): Promise<{ looked: number; found: WatchFinding[] }> {
  const db = getDb();
  const found: WatchFinding[] = [];
  let live: { site_id: string; title: string; version: number; created_at: string }[] = [];
  try {
    live = db.prepare("SELECT site_id, title, version, created_at FROM built_sites WHERE status = 'live' ORDER BY updated_at DESC").all() as typeof live;
  } catch {
    return { looked: 0, found }; // before the built pages tables
  }
  for (const s of live) {
    if (s.version === 0 && nowMs - Date.parse(s.created_at) > WATCH.unbuiltAfterMinutes * 60_000) {
      found.push({ kind: "page-empty", subject: s.site_id, what: `"${s.title}" is live with no version built` });
      continue;
    }
    if (s.version > 0) {
      const files = db.prepare("SELECT COUNT(*) n FROM built_site_files WHERE site_id = ? AND version = ?").get(s.site_id, s.version) as { n: number };
      if (files.n === 0) found.push({ kind: "page-empty", subject: s.site_id, what: `"${s.title}" shows version ${s.version}, which has no files` });
    }
  }
  try {
    for (const r of db.prepare(`SELECT r.site_id, s.title, COUNT(*) n FROM built_site_reports r JOIN built_sites s ON s.site_id = r.site_id
                                WHERE s.status = 'live' GROUP BY r.site_id`).all() as { site_id: string; title: string; n: number }[]) {
      found.push({ kind: "page-reported", subject: r.site_id, what: `"${r.title}" is live and has ${r.n} report${r.n === 1 ? "" : "s"}` });
    }
  } catch { /* no reports table yet */ }
  const toLoad = live.filter((s) => s.version > 0).slice(0, WATCH.pagesLoaded);
  for (const s of toLoad) {
    try {
      const res = await fetchFn(`${base}/s/${s.site_id}`, { signal: AbortSignal.timeout(WATCH.pageTimeoutMs), cache: "no-store" });
      if (!res.ok) found.push({ kind: "page-down", subject: s.site_id, what: `"${s.title}" answered ${res.status}` });
    } catch {
      found.push({ kind: "page-down", subject: s.site_id, what: `"${s.title}" did not answer` });
    }
  }
  return { looked: live.length, found };
}

/** Triggers: the ones that stopped themselves in the last day, the ones failing now, and page watchers that stopped looking. */
export function watchTriggers(nowMs: number): { looked: number; found: WatchFinding[] } {
  const db = getDb();
  const found: WatchFinding[] = [];
  let rows: { trigger_id: string; name: string; kind: string; status: string; pause_reason: string | null; consecutive_failures: number; updated_at: string; page_every_min: number | null; page_checked_at: string | null; created_at: string }[] = [];
  try {
    rows = db.prepare("SELECT trigger_id, name, kind, status, pause_reason, consecutive_failures, updated_at, page_every_min, page_checked_at, created_at FROM triggers").all() as typeof rows;
  } catch {
    return { looked: 0, found }; // before the triggers tables
  }
  const dayAgo = nowMs - 86_400_000;
  const why: Record<string, string> = { failures: "after failing again and again", agent_unavailable: "because its agent is gone", allowance_expired: "because its allowance ran out" };
  for (const t of rows) {
    if (t.status === "paused" && t.pause_reason && why[t.pause_reason] && Date.parse(t.updated_at) >= dayAgo) {
      found.push({ kind: "trigger-paused", subject: t.trigger_id, what: `"${t.name}" paused itself ${why[t.pause_reason]}` });
    } else if (t.status === "active" && t.consecutive_failures >= WATCH.triggerFailing) {
      found.push({ kind: "trigger-failing", subject: t.trigger_id, what: `"${t.name}" failed ${t.consecutive_failures} times in a row` });
    }
    if (t.status === "active" && t.kind === "page" && t.page_every_min) {
      const since = Date.parse(t.page_checked_at ?? t.created_at);
      const late = (nowMs - since) / 60_000 / t.page_every_min;
      if (late >= WATCH.watcherLate) found.push({ kind: "watcher-stopped", subject: t.trigger_id, what: `"${t.name}" should look every ${t.page_every_min} min and last looked ${Math.round((nowMs - since) / 60_000)} min ago` });
    }
  }
  return { looked: rows.length, found };
}

/** Jobs that used a browser today: how many failed, how much of the day's browsing is used, and the browser itself. */
export function watchBrowsing(nowMs: number, env: Env = process.env): { looked: number; found: WatchFinding[] } {
  const found: WatchFinding[] = [];
  const dayStart = iso(Math.floor(nowMs / 86_400_000) * 86_400_000);
  let jobs = { n: 0, failed: 0 };
  try {
    jobs = getDb().prepare(`SELECT COUNT(*) n, COALESCE(SUM(t.status = 'failed'), 0) failed FROM tasks t
                            WHERE t.created_at >= ? AND EXISTS (SELECT 1 FROM task_pages p WHERE p.task_id = t.task_id)`).get(dayStart) as typeof jobs;
  } catch { /* before the browser tables */ }
  if (jobs.n >= WATCH.browserMinJobs && jobs.failed / jobs.n >= WATCH.browserFailShare) {
    found.push({ kind: "browser-failing", what: `${jobs.failed} of today's ${jobs.n} browser jobs failed` });
  }
  const most = dailyBrowsing(env);
  if (most > 0 && jobs.n / most >= WATCH.browserNearlyUsed) found.push({ kind: "browser-nearly-used", what: `${jobs.n} of the day's ${most} browser jobs are used` });
  const browser = browserStatus(env);
  if (browser.enabled && !browser.installed) found.push({ kind: "browser-missing", what: "browsing is on and no browser is installed" });
  if (browser.leftovers) found.push({ kind: "browser-leftovers", what: `${browser.leftovers} browser${browser.leftovers === 1 ? "" : "s"} left running after their jobs` });
  return { looked: jobs.n, found };
}

/** One look at all three, recorded as a job. Skipped when the last look was less than WATCH.everyMinutes ago. */
export async function watch(nowMs = Date.now(), env: Env = process.env, deps: { fetchFn?: typeof fetch; base?: string } = {}): Promise<{ looked: boolean; found: WatchFinding[] }> {
  if (!partOn("watch", env)) return { looked: false, found: [] };
  const last = recentJobs(1, "watch")[0];
  if (last && nowMs - Date.parse(last.startedAt) < WATCH.everyMinutes * 60_000) return { looked: false, found: [] };
  const id = startJob("watch", null, nowMs);
  if (!id) return { looked: false, found: [] };
  const pages = sitesEnabled(env) ? await watchPages(nowMs, deps.base ?? siteUrl(env), deps.fetchFn ?? fetch) : { looked: 0, found: [] };
  const triggers = watchTriggers(nowMs);
  const browsing = watchBrowsing(nowMs, env);
  const found = [...pages.found, ...triggers.found, ...browsing.found];
  finishJob(id, {
    outcome: found.length ? "found" : "clear",
    summary: `Looked at ${pages.looked} built pages, ${triggers.looked} triggers and ${browsing.looked} browser jobs today: ${found.length ? `${found.length} to look at` : "all well"}`,
    detail: { looked: { pages: pages.looked, triggers: triggers.looked, browserJobs: browsing.looked }, found },
  }, Date.now());
  return { looked: true, found };
}

onTick("watch", async ({ nowMs, env }: TickContext) => { await watch(nowMs, env); });
