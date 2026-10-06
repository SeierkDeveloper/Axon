// Agent Minds 2: the daily report.
//
// A journal of single thoughts is hard to follow from the outside. Once a day a mind writes a short report on the day
// that just ended: what happened to its token, what it did and why, where it stands against its plan and its
// promises, and what it is watching next. The report goes on the token's page and into the inbox of its creator and
// of the holders who use Mylo.
//
// The facts of the day are worked out here by plain code from Axon's own records and handed to the mind; the mind
// writes the report from them. A report is a thought like any other and the mind pays for it from its own treasury,
// so the same care applies: a mind whose treasury is too small to check in does not write one, a day on which
// nothing happened gets no report, and one that has not been written by noon UTC is not written at all.
//
// Off with MINDS_REPORTS=off; on otherwise, wherever minds think.

import { getDb } from "./db";
import { agentMindsEnabled } from "./mindsPolicy";
import { thinkingMode } from "./mindsThinker";
import { thinkOnce, FAILED_GAP_MS, type ThinkOptions } from "./mindsMind";
import { pulseState } from "./mindsPulse";
import { mindsHalted } from "./mindsAdmin";
import { OWN_MIND } from "./mindsModels";
import { ethUsd } from "./ethPrice";
import { logger } from "./logger";

/** A report on yesterday is written in the first hours of today, and not after this hour (UTC). */
export const REPORT_UNTIL_HOUR = 12;
/** A change this large over the day is worth a report on its own. */
const MOVED_PCT = 5;
/** After this many attempts that failed, a day's report is given up. */
const MAX_TRIES = 3;
// when each mind last tried to report and could not start (its treasury could not pay, a budget was reached): it
// waits before trying again, so a mind that cannot report costs no call to the chain on every pass
const tried = new Map<string, number>();

export function reportsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MINDS_REPORTS ?? "on").trim().toLowerCase() !== "off";
}

/** The UTC day before the one `now` falls in, as YYYY-MM-DD. */
export const dayBefore = (now: number): string => new Date(Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000).toISOString().slice(0, 10);
/** A day in words: "5 October". */
export const dayLabel = (day: string): string => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

export interface DayFacts { day: string; label: string; /** whether anything happened that is worth a report */ eventful: boolean; lines: string[] }

const eth = (v: number) => +v.toPrecision(4);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What happened to a token and what its mind did on one UTC day, read from Axon's own records. */
export function dayFacts(token: string, day: string): DayFacts {
  const db = getDb(), t = token.toLowerCase();
  const from = `${day}T00:00:00.000Z`, to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const tax = (db.prepare("SELECT tax_bps v FROM mind_tokens WHERE token = ?").get(t) as { v: number | null } | undefined)?.v ?? null;
  type Sample = { mcap_eth: number | null; holders: number; fees_eth: number };
  const first = db.prepare("SELECT mcap_eth, holders, fees_eth FROM mind_history WHERE token = ? AND at >= ? AND at < ? ORDER BY at ASC LIMIT 1").get(t, from, to) as Sample | undefined;
  const last = db.prepare("SELECT mcap_eth, holders, fees_eth FROM mind_history WHERE token = ? AND at >= ? AND at < ? ORDER BY at DESC LIMIT 1").get(t, from, to) as Sample | undefined;
  const lines: string[] = [];
  let eventful = false;

  if (first && last) {
    const pct = first.mcap_eth && last.mcap_eth !== null && first.mcap_eth > 0 ? +(((last.mcap_eth - first.mcap_eth) / first.mcap_eth) * 100).toFixed(1) : null;
    const held = last.holders - first.holders, fees = Math.max(0, last.fees_eth - first.fees_eth);
    lines.push(`market cap ${first.mcap_eth === null ? "unknown" : `${eth(first.mcap_eth)} ETH`} at the start of the day, ${last.mcap_eth === null ? "unknown" : `${eth(last.mcap_eth)} ETH`} at the end${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`}`);
    lines.push(`holders ${first.holders} at the start, ${last.holders} at the end (${held > 0 ? "+" : ""}${held})`);
    lines.push(fees > 0 ? `fees paid out: ${eth(fees)} ETH${tax && tax > 0 ? `, from about ${eth(fees / (tax / 10_000))} ETH traded` : ""}` : "fees paid out: none");
    if ((pct !== null && Math.abs(pct) >= MOVED_PCT) || held !== 0 || fees > 0) eventful = true;
  } else {
    lines.push("market cap and holders: not read on that day");
  }

  const events = db.prepare("SELECT kind, COUNT(*) n, COALESCE(SUM(eth), 0) eth, COALESCE(SUM(tokens), 0) tokens FROM mind_events WHERE token = ? AND at >= ? AND at < ? AND kind != 'thought' GROUP BY kind").all(t, from, to) as { kind: string; n: number; eth: number; tokens: number }[];
  const ev = (kind: string) => events.find((e) => e.kind === kind);
  if (events.length) eventful = true;
  if (ev("burn")) lines.push(`the burn pot burned ${Math.round(ev("burn")!.tokens).toLocaleString("en-US")} tokens in ${plural(ev("burn")!.n, "burn")}`);
  if (ev("graduated")) lines.push("the token graduated to its pool");
  if (ev("earned")) lines.push(`its agent earned ${eth(ev("earned")!.eth)} ETH from work`);

  const thoughts = db.prepare("SELECT source, verdict, COUNT(*) n, COALESCE(SUM(cost_eth), 0) cost FROM mind_thoughts WHERE token = ? AND at >= ? AND at < ? AND status = 'thought' AND source != 'report' GROUP BY source, verdict").all(t, from, to) as { source: string; verdict: string; n: number; cost: number }[];
  const by = (source: string) => thoughts.filter((r) => r.source === source).reduce((s, r) => s + r.n, 0);
  const thought = by("event") + by("pulse"), refused = thoughts.filter((r) => r.verdict === "refused").reduce((s, r) => s + r.n, 0), cost = thoughts.reduce((s, r) => s + r.cost, 0);
  lines.push(thought ? `you thought ${plural(thought, "time")} (${by("event")} woken by something happening, ${plural(by("pulse"), "check-in")} of your own)${cost > 0 ? `, which cost ${eth(cost)} ETH` : ""}` : "you did not think that day");
  if (refused) lines.push(`the rule check refused ${plural(refused, "proposal")} of yours`);
  if (by("event")) eventful = true;

  const moves = db.prepare("SELECT kind, COUNT(*) n, COALESCE(SUM(eth), 0) eth FROM mind_actions WHERE token = ? AND at >= ? AND at < ? AND status = 'done' AND kind IN ('buyback', 'reward', 'burn_axon') GROUP BY kind").all(t, from, to) as { kind: string; n: number; eth: number }[];
  const DID: Record<string, [string, string]> = { buyback: ["buyback", "buybacks"], reward: ["reward", "rewards"], burn_axon: ["$AXON burn", "$AXON burns"] };
  lines.push(moves.length ? `you carried out ${moves.map((m) => `${plural(m.n, ...DID[m.kind])} (${eth(m.eth)} ETH)`).join(", ")}` : "you carried out no moves");
  if (moves.length) eventful = true;

  const orders = db.prepare("SELECT promise, status, COUNT(*) n FROM mind_orders WHERE token = ? AND fired_at >= ? AND fired_at < ? GROUP BY promise, status").all(t, from, to) as { promise: number; status: string; n: number }[];
  const made = (db.prepare("SELECT COUNT(*) n FROM mind_orders WHERE token = ? AND promise = 1 AND created_at >= ? AND created_at < ?").get(t, from, to) as { n: number }).n;
  const said = (promise: number) => { const o = orders.filter((r) => r.promise === promise), n = (s: string) => o.filter((r) => r.status === s).reduce((x, r) => x + r.n, 0); return [n("kept") && `${n("kept")} carried out`, n("missed") && `${n("missed")} not carried out`, n("fired") && `${n("fired")} on its way`].filter(Boolean).join(", "); };
  if (said(0)) { lines.push(`standing orders that fired: ${said(0)}`); eventful = true; }
  if (made || said(1)) { lines.push(`promises: ${[made && `${made} made`, said(1) && `called on: ${said(1)}`].filter(Boolean).join("; ")}`); eventful = true; }

  return { day, label: dayLabel(day), eventful, lines };
}

export interface Report { id: number; token: string; day: string; label: string; text: string; thoughtId: number | null; at: string }

/** A mind's reports, newest first. A day that had nothing to report is not among them. */
export function reportsOf(token: string, limit = 7): Report[] {
  const rows = getDb().prepare("SELECT id, token, day, text, thought_id, at FROM mind_reports WHERE token = ? AND text != '' ORDER BY day DESC LIMIT ?").all(token.toLowerCase(), Math.min(60, Math.max(1, limit))) as { id: number; token: string; day: string; text: string; thought_id: number | null; at: string }[];
  return rows.map((r) => ({ id: r.id, token: r.token, day: r.day, label: dayLabel(r.day), text: r.text, thoughtId: r.thought_id, at: r.at }));
}

/**
 * Let the minds that owe a report on yesterday write it: a couple a pass, in the first hours of the day. A day with
 * nothing to report is closed without one, so it is looked at once.
 */
export async function reportDue(o: ThinkOptions = {}, limit = 2): Promise<{ written: number; skipped: number; quiet: number } | null> {
  const env = o.env ?? process.env, now = o.now ?? Date.now();
  if (!agentMindsEnabled(env) || thinkingMode(env) === "off" || mindsHalted() || !reportsEnabled(env)) return null;
  if (new Date(now).getUTCHours() >= REPORT_UNTIL_HOUR) return null;
  const db = getDb(), day = dayBefore(now), dayEnd = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
  // minds that were thinking before that day ended, have no report for it, and have not just tried and failed
  const due = db.prepare(
    `SELECT t.token, t.model FROM mind_tokens t JOIN mind_stats s ON s.token = t.token
      WHERE t.stopped_at IS NULL AND s.updated_at IS NOT NULL AND t.launched_at < ?
        AND EXISTS (SELECT 1 FROM mind_thoughts h WHERE h.token = t.token AND h.status = 'thought' AND h.source NOT IN ('order', 'report') AND h.at < ?)
        AND NOT EXISTS (SELECT 1 FROM mind_reports r WHERE r.token = t.token AND r.day = ?)
        AND NOT EXISTS (SELECT 1 FROM mind_thoughts h WHERE h.token = t.token AND h.source = 'report' AND h.at >= ?)
        AND (SELECT COUNT(*) FROM mind_thoughts h WHERE h.token = t.token AND h.source = 'report' AND h.status = 'failed' AND h.at >= ?) < ?
      ORDER BY t.launched_at ASC LIMIT 40`,
  ).all(dayEnd, dayEnd, day, new Date(now - FAILED_GAP_MS).toISOString(), dayEnd, MAX_TRIES) as { token: string; model: string | null }[];
  if (!due.length) return { written: 0, skipped: 0, quiet: 0 };

  const usdPerEth = o.usdPerEth === undefined ? await ethUsd().catch(() => null) : o.usdPerEth;
  let written = 0, skipped = 0, quiet = 0, room = limit;
  for (const m of due) {
    if (room <= 0) break;
    // a treasury too small to check in is too small to report
    if (pulseState(m.token, now, { usdPerEth: m.model === OWN_MIND ? 1 : usdPerEth ?? null }).everyMs === null) continue;
    if (now - (tried.get(m.token) ?? 0) < FAILED_GAP_MS && now >= (tried.get(m.token) ?? 0)) continue;
    const facts = dayFacts(m.token, day);
    if (!facts.eventful) {
      db.prepare("INSERT OR IGNORE INTO mind_reports (token, day, text, thought_id, at) VALUES (?,?,'',NULL,?)").run(m.token, day, new Date(now).toISOString());
      quiet++;
      continue;
    }
    room--;
    const r = await thinkOnce(m.token, { ...o, usdPerEth, report: { day, label: facts.label, facts: facts.lines } }).catch((err) => { logger.warn("minds.report_error", "A mind's report went wrong", { err, token: m.token }); return { skipped: "error" }; });
    if ("skipped" in r) { skipped++; tried.set(m.token, now); } else { written++; tried.delete(m.token); }
  }
  return { written, skipped, quiet };
}
