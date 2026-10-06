// Agent Minds 2: the track record.
//
// A mind that never looks back cannot get better at its job. Every move it makes that is carried out on chain (a
// buyback, a reward, a $AXON burn) is written down with the token's market cap and holders at the moment it decided,
// and measured again an hour later. The next time the mind thinks it is shown what its recent moves were followed by,
// and writes one sentence on what it takes from each. Holders read the same record on the token's page.
//
// What a move was followed by is not what it caused: a market moves for many reasons, and an hour is short. The
// record says "followed by" and nothing stronger, the mind is told the same, and nothing here is a forecast.

import { getDb } from "./db";
import { validateAgentText } from "./agentContent";

/** A move is measured this long after it was made. */
export const MEASURE_AFTER_MS = 3_600_000;
/** A move that could not be measured within this long of its hour is written down as not measured. */
const MEASURE_WINDOW_MS = 30 * 60_000;
const LESSON_CHARS = 180;
const KINDS = ["buyback", "reward", "burn_axon"] as const;
type Kind = (typeof KINDS)[number];
const DID: Record<Kind, string> = { buyback: "buyback", reward: "reward", burn_axon: "$AXON burn" };

export interface Outcome {
  actionId: number; token: string; kind: Kind; eth: number; at: string;
  mcapBefore: number | null; holdersBefore: number | null; mcapAfter: number | null; holdersAfter: number | null;
  /** when it was measured; set with no numbers after it when it could not be */
  measuredAt: string | null;
  /** how the market cap stood an hour later against when the move was decided, in percent; null when either is unknown */
  capPct: number | null;
  holdersDelta: number | null;
  lesson: string | null; lessonThoughtId: number | null;
}

interface Row { action_id: number; token: string; kind: string; eth: number; at: string; mcap_before: number | null; holders_before: number | null; mcap_after: number | null; holders_after: number | null; measured_at: string | null; lesson: string | null; lesson_thought_id: number | null }
const toOutcome = (r: Row): Outcome => ({
  actionId: r.action_id, token: r.token, kind: r.kind as Kind, eth: r.eth, at: r.at, mcapBefore: r.mcap_before, holdersBefore: r.holders_before, mcapAfter: r.mcap_after, holdersAfter: r.holders_after, measuredAt: r.measured_at,
  capPct: r.mcap_before && r.mcap_after !== null && r.mcap_before > 0 ? +(((r.mcap_after - r.mcap_before) / r.mcap_before) * 100).toFixed(1) : null,
  holdersDelta: r.holders_before !== null && r.holders_after !== null ? r.holders_after - r.holders_before : null,
  lesson: r.lesson, lessonThoughtId: r.lesson_thought_id,
});

/**
 * Keep the record up to date: write down every move that has been carried out since the last pass, and measure the
 * ones whose hour is up. Reads and writes Axon's own records only.
 */
export function trackOutcomes(now = Date.now()): { recorded: number; measured: number } {
  const db = getDb();
  // moves carried out and not written down yet, with the numbers the mind decided on
  const fresh = db.prepare(
    `SELECT a.id, a.token, a.kind, a.eth, a.at, h.mcap_eth, h.holders FROM mind_actions a LEFT JOIN mind_thoughts h ON h.id = a.thought_id
      WHERE a.status = 'done' AND a.kind IN ('buyback', 'reward', 'burn_axon') AND NOT EXISTS (SELECT 1 FROM mind_outcomes o WHERE o.action_id = a.id)
      ORDER BY a.id ASC LIMIT 200`,
  ).all() as { id: number; token: string; kind: string; eth: number; at: string; mcap_eth: number | null; holders: number | null }[];
  const put = db.prepare("INSERT OR IGNORE INTO mind_outcomes (action_id, token, kind, eth, at, mcap_before, holders_before) VALUES (?,?,?,?,?,?,?)");
  for (const a of fresh) {
    let cap = a.mcap_eth, holders = a.holders;
    if (cap === null || holders === null) {
      // no snapshot with the thought: the sample taken closest before the move
      const s = db.prepare("SELECT mcap_eth, holders FROM mind_history WHERE token = ? AND at <= ? ORDER BY at DESC LIMIT 1").get(a.token, a.at) as { mcap_eth: number | null; holders: number } | undefined;
      cap = cap ?? s?.mcap_eth ?? null; holders = holders ?? s?.holders ?? null;
    }
    put.run(a.id, a.token, a.kind, a.eth, a.at, cap, holders);
  }

  const due = db.prepare("SELECT action_id, token, at FROM mind_outcomes WHERE measured_at IS NULL AND at <= ? ORDER BY action_id ASC LIMIT 200").all(new Date(now - MEASURE_AFTER_MS).toISOString()) as { action_id: number; token: string; at: string }[];
  const close = db.prepare("UPDATE mind_outcomes SET mcap_after = ?, holders_after = ?, measured_at = ? WHERE action_id = ? AND measured_at IS NULL");
  const stamp = new Date(now).toISOString();
  let measured = 0;
  for (const o of due) {
    const hour = Date.parse(o.at) + MEASURE_AFTER_MS;
    // the first sample taken once its hour was up, as long as it is close to that hour
    const s = db.prepare("SELECT at, mcap_eth, holders FROM mind_history WHERE token = ? AND at >= ? ORDER BY at ASC LIMIT 1").get(o.token, new Date(hour).toISOString()) as { at: string; mcap_eth: number | null; holders: number } | undefined;
    if (s && Date.parse(s.at) - hour <= MEASURE_WINDOW_MS) { measured += close.run(s.mcap_eth, s.holders, stamp, o.action_id).changes; continue; }
    if (now - hour <= MEASURE_WINDOW_MS) {
      const cur = db.prepare("SELECT mcap_eth, COALESCE(holders, 0) holders FROM mind_stats WHERE token = ?").get(o.token) as { mcap_eth: number | null; holders: number } | undefined;
      if (cur) { measured += close.run(cur.mcap_eth, cur.holders, stamp, o.action_id).changes; continue; }
    }
    // its hour is long past and nothing was read near it: it is closed as not measured rather than given a wrong number
    if (now - hour > MEASURE_WINDOW_MS) measured += close.run(null, null, stamp, o.action_id).changes;
  }
  return { recorded: fresh.length, measured };
}

/** A token's moves and what each was followed by, newest first. */
export function outcomesOf(token: string, limit = 10): Outcome[] {
  return (getDb().prepare("SELECT * FROM mind_outcomes WHERE token = ? ORDER BY action_id DESC LIMIT ?").all(token.toLowerCase(), Math.min(50, Math.max(1, limit))) as Row[]).map(toOutcome);
}

export interface KindRecord { kind: Kind; moves: number; measured: number; avgCapPct: number | null; timesUp: number; avgHolders: number | null; eth: number }
export interface TrackRecord { moves: number; measured: number; byKind: KindRecord[] }

/** A mind's record in numbers: for each kind of move, how often it was made and what it was followed by on average. */
export function recordOf(token: string): TrackRecord {
  const rows = (getDb().prepare("SELECT * FROM mind_outcomes WHERE token = ?").all(token.toLowerCase()) as Row[]).map(toOutcome);
  const avg = (v: number[], d = 1) => (v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(d) : null);
  const byKind = KINDS.map((kind) => {
    const of = rows.filter((r) => r.kind === kind), caps = of.map((r) => r.capPct).filter((v): v is number => v !== null), held = of.map((r) => r.holdersDelta).filter((v): v is number => v !== null);
    return { kind, moves: of.length, measured: caps.length, avgCapPct: avg(caps), timesUp: caps.filter((v) => v > 0).length, avgHolders: avg(held), eth: +of.reduce((s, r) => s + r.eth, 0).toFixed(9) };
  }).filter((k) => k.moves > 0);
  return { moves: rows.length, measured: rows.filter((r) => r.capPct !== null).length, byKind };
}

const signed = (v: number, unit = "") => `${v > 0 ? "+" : ""}${v}${unit}`;
const ago = (iso: string, now: number): string => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`; };
const eth = (v: number) => +v.toPrecision(4);

/** What one move was followed by, in words. */
export function followedBy(o: Outcome): string {
  if (!o.measuredAt) return "not measured yet: its hour is not up";
  if (o.capPct === null && o.holdersDelta === null) return "could not be measured";
  return [
    o.capPct === null ? null : `market cap ${eth(o.mcapBefore as number)} to ${eth(o.mcapAfter as number)} ETH (${signed(o.capPct, "%")})`,
    o.holdersDelta === null ? null : `holders ${o.holdersBefore} to ${o.holdersAfter}`,
  ].filter(Boolean).join(", ") + " an hour later";
}

/** A mind's record as the lines it reads. Short on purpose: every word of this is paid for by its treasury. */
export function recordLines(token: string, now = Date.now()): string[] {
  const rec = recordOf(token);
  if (!rec.moves) return ["your_track_record: no moves carried out yet"];
  const kinds = rec.byKind.map((k) => `${k.moves} ${DID[k.kind]}${k.moves === 1 ? "" : "s"}${k.measured ? `, followed an hour later by market cap ${signed(k.avgCapPct as number, "%")} on average (up ${k.timesUp} of ${k.measured} times)${k.avgHolders === null ? "" : ` and holders ${signed(k.avgHolders)}`}` : ", none measured yet"}`);
  const moves = outcomesOf(token, 3);
  return [
    `your_track_record: ${kinds.join("; ")}`,
    "your_last_moves (newest first):",
    ...moves.map((o) => `  #${o.actionId} ${DID[o.kind]} with ${eth(o.eth)} ETH, ${ago(o.at, now)}: ${followedBy(o)}. ${o.lesson ? `Your lesson: "${o.lesson}"` : o.capPct !== null || o.holdersDelta !== null ? "No lesson yet: write one in this answer." : ""}`.trimEnd()),
  ];
}

function sentence(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let text = v.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").replace(/–/g, "-").replace(/"/g, "'").trim();
  if (text.length > LESSON_CHARS) { const cut = text.slice(0, LESSON_CHARS); text = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), LESSON_CHARS - 20))}…`; }
  return text.length < 8 || validateAgentText(text) ? null : text;
}

/**
 * Take the lessons a mind wrote in an answer. A lesson is kept for a move of its own that has been measured and has
 * none yet: a lesson is written once, after the numbers are in, and stands. Returns how many were kept.
 */
export function saveLessons(token: string, raw: unknown, thoughtId: number | null): number {
  if (!Array.isArray(raw)) return 0;
  const db = getDb(), t = token.toLowerCase();
  let kept = 0;
  for (const one of raw.slice(0, 5)) {
    if (!one || typeof one !== "object") continue;
    const r = one as Record<string, unknown>, id = Number(r.move ?? r.action ?? r.id), text = sentence(r.lesson);
    if (!Number.isInteger(id) || !text) continue;
    kept += db.prepare("UPDATE mind_outcomes SET lesson = ?, lesson_thought_id = ? WHERE action_id = ? AND token = ? AND lesson IS NULL AND measured_at IS NOT NULL AND (mcap_after IS NOT NULL OR holders_after IS NOT NULL)").run(text, thoughtId, id, t).changes;
  }
  return kept;
}
