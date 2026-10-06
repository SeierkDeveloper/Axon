// Agent Minds 2: what a mind can sense.
//
// A mind used to be told its token's numbers as they stand, and how they stood at its last thought. That is a
// photograph. This is the film: the numbers are sampled every few minutes, and from those samples a mind is told how
// the market cap and the holders moved over the last hour, six hours and day, roughly how much was traded, how much
// of the token its ten largest holders own, what is unusual right now, and where it stands among the other tokens
// launched here. Everything is read from Axon's own records of the chain; nothing here is a prediction.

import { getDb } from "./db";

/** How often a token's numbers are written down. */
export const SAMPLE_MS = 10 * 60_000;
/** How long the samples are kept: enough for a day of change with room to spare. */
export const KEEP_DAYS = 14;

export interface Sample { mcapEth: number | null; priceEth: number | null; holders: number; top10Bps: number | null; feesEth: number; burnedTokens: number; treasuryEth: number }

/**
 * Write a token's numbers down, at most once per SAMPLE_MS. Returns whether a row was written. Old rows go as new
 * ones come, so the table never grows past KEEP_DAYS of history per token.
 */
export function sample(token: string, s: Sample, now = Date.now()): boolean {
  const db = getDb(), t = token.toLowerCase();
  const last = db.prepare("SELECT at FROM mind_history WHERE token = ? ORDER BY at DESC LIMIT 1").get(t) as { at: string } | undefined;
  if (last && now - Date.parse(last.at) < SAMPLE_MS) return false;
  db.prepare("INSERT OR IGNORE INTO mind_history (token, at, mcap_eth, price_eth, holders, top10_bps, fees_eth, burned_tokens, treasury_eth) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(t, new Date(now).toISOString(), s.mcapEth, s.priceEth, s.holders, s.top10Bps, s.feesEth, s.burnedTokens, s.treasuryEth);
  db.prepare("DELETE FROM mind_history WHERE token = ? AND at < ?").run(t, new Date(now - KEEP_DAYS * 86_400_000).toISOString());
  return true;
}

/**
 * What the ten largest holders own, in hundredths of a percent of everything holders hold. `skip` is who does not
 * count as a holder: the curve, the pool, the token's own contracts and the burn addresses. Null with no holders.
 */
export function top10Bps(token: string, skip: string[]): number | null {
  const lower = skip.map((a) => a.toLowerCase());
  const rows = getDb().prepare(`SELECT balance FROM mind_holders WHERE token = ? AND balance != '0'${lower.length ? ` AND address NOT IN (${lower.map(() => "?").join(",")})` : ""}`).all(token.toLowerCase(), ...lower) as { balance: string }[];
  if (!rows.length) return null;
  const held = rows.map((r) => BigInt(r.balance)).filter((b) => b > 0n).sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
  const total = held.reduce((s, b) => s + b, 0n);
  if (total === 0n) return null;
  return Number((held.slice(0, 10).reduce((s, b) => s + b, 0n) * 10_000n) / total);
}

interface Row { at: string; mcap_eth: number | null; holders: number; top10_bps: number | null; fees_eth: number }

/** The sample taken about `ms` ago: the newest one at least that old, and not so old that it is from another time. */
function about(token: string, now: number, ms: number): Row | null {
  const r = getDb().prepare("SELECT at, mcap_eth, holders, top10_bps, fees_eth FROM mind_history WHERE token = ? AND at <= ? ORDER BY at DESC LIMIT 1").get(token, new Date(now - ms).toISOString()) as Row | undefined;
  // a token younger than the window, or a gap in the samples, has nothing honest to compare with
  return r && now - Date.parse(r.at) <= ms * 1.5 + 2 * SAMPLE_MS ? r : null;
}

export interface Window { capPct: number | null; holders: number | null; volumeEth: number | null }
export interface Senses {
  hour: Window; sixHours: Window; day: Window;
  /** the highest market cap in the last day, and how far below it the token is now, in percent (0 or less) */
  high24hEth: number | null; fromHighPct: number | null;
  top10Pct: number | null; top10PctDayAgo: number | null;
  /** what is unusual right now, in plain words; empty when nothing is */
  radar: string[];
  peers: { count: number; rank: number | null; biggest: { symbol: string | null; mcapEth: number | null; holders: number }[] };
}

const pct = (now: number | null, then: number | null) => (now === null || then === null || then <= 0 ? null : ((now - then) / then) * 100);
const round = (v: number, d = 1) => +v.toFixed(d);

/**
 * How a token's numbers have moved, read from its samples. `taxBps` turns fees into an estimate of what was traded
 * (fees paid out divided by the tax), which is null for a token with no tax.
 */
export function sensesOf(token: string, taxBps: number | null, now = Date.now()): Senses {
  const db = getDb(), t = token.toLowerCase();
  const cur = db.prepare("SELECT s.mcap_eth, COALESCE(s.holders, 0) holders, COALESCE(s.fees_eth, 0) fees_eth FROM mind_stats s WHERE s.token = ?").get(t) as { mcap_eth: number | null; holders: number; fees_eth: number } | undefined;
  const latest = db.prepare("SELECT top10_bps FROM mind_history WHERE token = ? ORDER BY at DESC LIMIT 1").get(t) as { top10_bps: number | null } | undefined;
  const window = (ms: number): Window => {
    const then = cur ? about(t, now, ms) : null;
    if (!cur || !then) return { capPct: null, holders: null, volumeEth: null };
    const fees = Math.max(0, cur.fees_eth - then.fees_eth);
    const cap = pct(cur.mcap_eth, then.mcap_eth);
    return { capPct: cap === null ? null : round(cap), holders: cur.holders - then.holders, volumeEth: taxBps && taxBps > 0 ? +(fees / (taxBps / 10_000)).toPrecision(3) : null };
  };
  const hour = window(3_600_000), sixHours = window(6 * 3_600_000), day = window(86_400_000);

  const high = (db.prepare("SELECT MAX(mcap_eth) v FROM mind_history WHERE token = ? AND at >= ?").get(t, new Date(now - 86_400_000).toISOString()) as { v: number | null }).v;
  const high24hEth = high === null ? null : Math.max(high, cur?.mcap_eth ?? 0);
  const fromHigh = pct(cur?.mcap_eth ?? null, high24hEth);
  const dayAgo = about(t, now, 86_400_000);
  const top10Pct = latest?.top10_bps == null ? null : round(latest.top10_bps / 100), top10PctDayAgo = dayAgo?.top10_bps == null ? null : round(dayAgo.top10_bps / 100);

  const radar: string[] = [];
  if (hour.capPct !== null && Math.abs(hour.capPct) >= 10) radar.push(`market cap ${hour.capPct < 0 ? "down" : "up"} ${Math.abs(hour.capPct)}% in the last hour`);
  if (hour.holders !== null && cur && Math.abs(hour.holders) >= Math.max(3, Math.ceil(cur.holders * 0.05))) radar.push(`holders ${hour.holders < 0 ? "down" : "up"} ${Math.abs(hour.holders)} in the last hour`);
  if (hour.volumeEth !== null && day.volumeEth !== null && day.volumeEth > 0 && hour.volumeEth >= (day.volumeEth / 24) * 3 && hour.volumeEth > 0) radar.push(`about ${round(hour.volumeEth / (day.volumeEth / 24))} times the usual hourly volume`);
  if (fromHigh !== null && fromHigh <= -25) radar.push(`${Math.abs(round(fromHigh))}% below its high of the last day`);
  if (top10Pct !== null && top10PctDayAgo !== null && Math.abs(top10Pct - top10PctDayAgo) >= 5) radar.push(`the ten largest holders went from ${top10PctDayAgo}% to ${top10Pct}% in a day`);

  const others = db.prepare("SELECT t.token, t.symbol, s.mcap_eth mcapEth, COALESCE(s.holders, 0) holders FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token ORDER BY COALESCE(s.mcap_eth, 0) DESC").all() as { token: string; symbol: string | null; mcapEth: number | null; holders: number }[];
  const at = others.findIndex((o) => o.token === t);
  return {
    hour, sixHours, day, high24hEth, fromHighPct: fromHigh === null ? null : Math.min(0, round(fromHigh)), top10Pct, top10PctDayAgo, radar,
    peers: { count: others.length - (at >= 0 ? 1 : 0), rank: at >= 0 ? at + 1 : null, biggest: others.filter((o) => o.token !== t).slice(0, 3).map((o) => ({ symbol: o.symbol, mcapEth: o.mcapEth, holders: o.holders })) },
  };
}

const signed = (v: number, unit = "") => `${v > 0 ? "+" : ""}${v}${unit}`;
const windowText = (w: Window): string => (w.capPct === null && w.holders === null ? "not enough history yet"
  : [w.capPct === null ? null : `market cap ${signed(w.capPct, "%")}`, w.holders === null ? null : `holders ${signed(w.holders)}`, w.volumeEth === null ? null : `about ${w.volumeEth} ETH traded`].filter(Boolean).join(", "));
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** The senses as the lines a mind reads. Short on purpose: every word of this is paid for by its treasury. */
export function sensesLines(s: Senses): string[] {
  return [
    `last_hour: ${windowText(s.hour)}`,
    `last_6_hours: ${windowText(s.sixHours)}`,
    `last_24_hours: ${windowText(s.day)}${s.high24hEth !== null && s.fromHighPct !== null ? `; high ${+s.high24hEth.toPrecision(4)} ETH (${s.fromHighPct === 0 ? "at it now" : `now ${Math.abs(s.fromHighPct)}% below it`})` : ""}`,
    `ten_largest_holders_own: ${s.top10Pct === null ? "unknown" : `${s.top10Pct}% of what holders hold${s.top10PctDayAgo === null ? "" : ` (${s.top10PctDayAgo}% a day ago)`}`}`,
    `radar: ${s.radar.length ? s.radar.join("; ") : "nothing unusual"}`,
    `other_tokens_here: ${s.peers.count === 0 ? "none yet, you are the only one" : `${s.peers.count}${s.peers.rank ? `; you are ${ordinal(s.peers.rank)} by market cap` : ""}. ${s.peers.biggest.map((p) => `$${p.symbol ?? "?"} ${p.mcapEth === null ? "?" : +p.mcapEth.toPrecision(3)} ETH, ${p.holders} holders`).join("; ")}`}`,
  ];
}
