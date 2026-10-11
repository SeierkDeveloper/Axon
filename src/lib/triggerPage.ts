// Jobs that start themselves, when a web page changes.
//
// A page trigger is an address, optionally the words to watch for on it, and how often to look. The worker calls
// this once a minute. Each trigger that is due has its page read in a real browser (the same one agents use, behind
// the same guard, so only the public web is ever read), and what it shows is compared with the look before. When it
// differs the agent is hired with what changed, by the path every trigger takes: a task, a receipt, a price, the
// owner's daily limit.
//
// What keeps it sensible:
//
//   No model is asked until something has changed. A look costs a few seconds of a browser and nothing else.
//
//   The first look only notes how the page is. So does the first look after a pause. What a page said before
//   somebody started watching it is not news.
//
//   Watching for words keeps it quiet. A whole page changes for reasons nobody cares about: a clock, a counter, an
//   advert. With words to watch for ("Price", "In stock") only the lines that mention them are compared.
//
//   A page that cannot be read is not a change. It is tried again at the next look; after several in a row the
//   trigger pauses itself and says why.
//
//   One tick looks at a few pages and comes back for the rest, oldest look first, so a great many watched pages
//   slow each other down and never the server.

import { createHash } from "node:crypto";
import { getDb } from "./db";
import { logger } from "./logger";
import { browserEnabled, browserLimits } from "./agentBrowser";
import { openBrowser } from "./browserSession";
import { fireTrigger, getTrigger, limitReached, noteSkipped, pauseFor, triggersEnabled, type Trigger, type TriggerEvent } from "./triggers";

type Env = Record<string, string | undefined>;

/** Pages one tick looks at. */
export const PAGES_PER_TICK = 3;
/** Looks in a row that may fail before a trigger pauses itself. */
export const FAILED_LOOKS_BEFORE_PAUSE = 5;
/** How much of what a page shows is kept from one look to the next, and how much of a change is told to the agent. */
export const KEPT_CHARS = 20_000;
export const TOLD_CHARS = 3_000;

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();

// A line that is only the time of day, or how long ago something was: it changes with every look and says nothing.
const CLOCK = /^(\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?m\.?)?|(updated |last updated )?(just now|\d+\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+ago))$/i;

/**
 * What of a page is compared from look to look: its lines, each with its spaces evened out, without the empty ones
 * and without the ones that are only a clock. With words to watch for, only the lines that mention them, each with
 * the line after it (a label is often on one line and its value on the next).
 */
export function watchedLines(pageText: string, watch: string | null): string[] {
  const lines = pageText.split(/\n+/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && !CLOCK.test(l));
  const want = (watch ?? "").trim().toLowerCase();
  if (!want) return lines;
  const kept: string[] = [];
  let last = -1;
  lines.forEach((l, i) => {
    if (!l.toLowerCase().includes(want)) return;
    for (const j of [i, i + 1]) if (j < lines.length && j > last) { kept.push(lines[j]); last = j; }
  });
  return kept;
}

/** The same, as one text with a fingerprint: what a look keeps. */
export function watched(pageText: string, watch: string | null): { text: string; hash: string } {
  const text = watchedLines(pageText, watch).join("\n").slice(0, KEPT_CHARS);
  return { text, hash: sha(text) };
}

/** What is in one look and not in the other: the lines that went, and the lines that came. */
export function changed(before: string, now: string): { gone: string[]; came: string[] } {
  const a = before.split("\n").filter(Boolean), b = now.split("\n").filter(Boolean);
  const inA = new Set(a), inB = new Set(b);
  return { gone: a.filter((l) => !inB.has(l)), came: b.filter((l) => !inA.has(l)) };
}

const siteOf = (url: string): string => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80); } catch { return url.slice(0, 80); } };
const told = (lines: string[]): string => { const t = lines.join("\n"); return t.length > TOLD_CHARS ? `${t.slice(0, TOLD_CHARS)}\n[and more: ${t.length - TOLD_CHARS} more characters]` : t; };

/** A change as one event: its key, a line for the list, and what the agent is told happened. */
export function describeChange(t: Pick<Trigger, "pageUrl" | "pageWatch" | "pageChanges">, before: string, now: { text: string; hash: string }): TriggerEvent {
  const { gone, came } = changed(before, now.text);
  const where = siteOf(t.pageUrl ?? "");
  const what = t.pageWatch ? `the lines that mention "${t.pageWatch}"` : "the whole page";
  const first = (came[0] ?? gone[0] ?? "").slice(0, 90);
  return {
    key: `page:${t.pageChanges + 1}:${now.hash.slice(0, 16)}`,
    summary: `${where} changed${first ? `: ${came.length ? "" : "gone: "}${first}` : ""}`,
    text: [
      "A web page that is being watched has changed.",
      `Address: ${t.pageUrl}`,
      `Watched: ${what}`,
      "",
      gone.length ? `No longer on the page:\n${told(gone)}` : "Nothing that was there has gone.",
      "",
      came.length ? `New on the page:\n${told(came)}` : now.text ? "Nothing new has appeared." : `The page no longer shows ${t.pageWatch ? `anything that mentions "${t.pageWatch}"` : "any words"}.`,
    ].join("\n"),
  };
}

/** What a page shows, or why it could not be read. */
export type ReadPage = (url: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;

/**
 * Read a page as a person's browser would show it: opened in the job browser, given a moment to finish drawing
 * itself, and its words taken once two readings agree. A browser of its own, closed again at once.
 */
export const readPage: ReadPage = async (url) => {
  const base = browserLimits();
  // a look is small and never waits long for a browser: when they are all busy, the page is looked at next time
  const opened = await openBrowser({ limits: { ...base, steps: 2, seconds: 45, megabytes: Math.min(base.megabytes, 20), waitSeconds: 3 }, taskId: "page-watch" });
  if (!opened.ok) return { ok: false, reason: opened.reason };
  const s = opened.session;
  try {
    const page = await s.goto(url);
    if (!page.ok) return { ok: false, reason: page.reason };
    if (page.status !== null && page.status >= 400) return { ok: false, reason: `The site answered with an error (${page.status}).` };
    const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    await pause(1200);
    let text = await s.text(200_000);
    for (let i = 0; i < 6; i++) {
      await pause(400);
      const again = await s.text(200_000);
      const same = again === text;
      text = again;
      if (same) break;
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "The page could not be read." };
  } finally {
    await s.close();
  }
};

export type LookResult =
  | { looked: true; changed: false; first: boolean }
  | { looked: true; changed: true; fired: boolean; message: string; taskId?: string }
  | { looked: false; reason: string; paused?: boolean };

/**
 * Look at one trigger's page now and act on what is there. The first look keeps what it sees and fires nothing. A
 * look that cannot read the page changes nothing but the count of failed looks.
 */
export async function lookAt(t: Trigger, o: { nowMs?: number; read?: ReadPage } = {}): Promise<LookResult> {
  const nowMs = o.nowMs ?? Date.now(), db = getDb();
  if (t.kind !== "page" || !t.pageUrl) return { looked: false, reason: "This trigger does not watch a page." };
  const got = await (o.read ?? readPage)(t.pageUrl);
  if (!got.ok) {
    const failures = t.pageFailures + 1;
    db.prepare("UPDATE triggers SET page_failures = ?, page_checked_at = ?, updated_at = ? WHERE trigger_id = ?").run(failures, iso(nowMs), iso(nowMs), t.triggerId);
    // one line a day in the owner's list, however many looks fail
    noteSkipped(t.triggerId, `unread:${iso(nowMs).slice(0, 10)}`, `${siteOf(t.pageUrl)} could not be read`, got.reason, nowMs);
    if (failures >= FAILED_LOOKS_BEFORE_PAUSE) {
      pauseFor(t.triggerId, "page_unreachable", nowMs);
      logger.info("trigger.page_paused", "A page trigger paused itself: its page could not be read", { triggerId: t.triggerId, failures });
      return { looked: false, reason: got.reason, paused: true };
    }
    return { looked: false, reason: got.reason };
  }
  const now = watched(got.text, t.pageWatch);
  const first = t.pageLastHash === null;
  if (first || now.hash === t.pageLastHash) {
    db.prepare("UPDATE triggers SET page_last_hash = ?, page_last_text = ?, page_checked_at = ?, page_failures = 0, updated_at = ? WHERE trigger_id = ?").run(now.hash, now.text, iso(nowMs), iso(nowMs), t.triggerId);
    return { looked: true, changed: false, first };
  }
  // It changed. What the page says now is kept whether or not a job starts: a change that could not be run (the
  // day's runs are used up, the agent costs more than the most set) is not tried again at every look after it.
  const event = describeChange(t, t.pageLastText ?? "", now);
  db.prepare("UPDATE triggers SET page_last_hash = ?, page_last_text = ?, page_checked_at = ?, page_changed_at = ?, page_changes = page_changes + 1, page_failures = 0, updated_at = ? WHERE trigger_id = ?")
    .run(now.hash, now.text, iso(nowMs), iso(nowMs), iso(nowMs), t.triggerId);
  const r = await fireTrigger(t.triggerId, event, { nowMs });
  return r.fired ? { looked: true, changed: true, fired: true, message: "The page changed and the agent was hired.", taskId: r.taskId } : { looked: true, changed: true, fired: false, message: r.message };
}

/** Whether a page trigger is due a look. */
export const due = (t: Pick<Trigger, "pageCheckedAt" | "pageEveryMin">, nowMs: number): boolean =>
  !t.pageCheckedAt || nowMs - Date.parse(t.pageCheckedAt) >= (t.pageEveryMin ?? 60) * 60_000 - 5_000;

/**
 * One tick: the page triggers that are due, oldest look first, a few of them. Never throws; a trigger that fails
 * is tried again when it is next due. Does nothing while triggers or browsers are off.
 */
export async function runPageTriggers(o: { nowMs?: number; read?: ReadPage; limit?: number; env?: Env } = {}): Promise<{ looked: number; changed: number; started: number }> {
  const env = o.env ?? process.env;
  if (!triggersEnabled(env) || !browserEnabled(env)) return { looked: 0, changed: 0, started: 0 };
  const nowMs = o.nowMs ?? Date.now();
  const ids = getDb().prepare("SELECT trigger_id FROM triggers WHERE kind = 'page' AND status = 'active' ORDER BY (page_checked_at IS NOT NULL), page_checked_at ASC LIMIT 200").all() as { trigger_id: string }[];
  let looked = 0, changedN = 0, started = 0;
  for (const { trigger_id } of ids) {
    if (looked >= (o.limit ?? PAGES_PER_TICK)) break;
    const t = getTrigger(trigger_id);
    if (!t || t.status !== "active" || !due(t, nowMs)) continue;
    // A trigger that has made its runs for the day does not look: a change it could not act on is passed over, and
    // it starts again tomorrow from how the page is then.
    if (limitReached(t, nowMs, env)) {
      noteSkipped(t.triggerId, `limit:${iso(nowMs).slice(0, 10)}`, "Today's runs are used up. The page is not looked at again until tomorrow.", "The trigger has made all its runs for today.", nowMs);
      getDb().prepare("UPDATE triggers SET page_last_hash = NULL, page_last_text = NULL, page_checked_at = ?, updated_at = ? WHERE trigger_id = ?").run(iso(nowMs), iso(nowMs), t.triggerId);
      continue;
    }
    looked++;
    try {
      const r = await lookAt(t, { nowMs, read: o.read });
      if (r.looked && r.changed) { changedN++; if (r.fired) started++; }
    } catch (err) {
      logger.warn("trigger.page_look_failed", "A watched page could not be looked at this tick", { err, triggerId: trigger_id });
    }
  }
  return { looked, changed: changedN, started };
}
