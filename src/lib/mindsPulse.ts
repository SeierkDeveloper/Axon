// Agent Minds 2: the pulse.
//
// A mind used to wake only when something happened to its token: a fee payout, a burn, a holder milestone. A market
// cap that slid for nine hours with no trade big enough to pay out fees woke nobody. The pulse is the mind checking in
// on its own: when nothing has woken it for a while it looks at how its numbers have moved, at its plan and at its
// orders, and says what it sees. And when its radar flags something unusual (a sharp move in the hour, holders
// leaving) it looks at once instead of waiting for the next check-in.
//
// A check-in is a thought like any other and the mind pays for it from its own treasury, so its pace is set by what
// the mind can afford: never more often than hourly, at least daily, and in between by two things. Check-ins may use
// at most half of the thinking limit its creator locked at launch (the other half is kept for when something really
// happens), and a day of them may cost at most a fiftieth of what the treasury holds. A treasury too small for one
// check-in a day at that rate does not check in at all: it still wakes when something happens. A mind that keeps
// finding nothing new slows down, and picks its pace up again as soon as its numbers move.
//
// Off with MINDS_PULSE=off; on otherwise, wherever minds think.

import { getDb } from "./db";
import { mindModel, estimateThoughtUsd, OWN_MIND } from "./mindsModels";
import { sensesOf } from "./mindsSenses";

/** A mind never checks in more often than this. */
export const PULSE_MIN_MS = 3_600_000;
/** A mind that can afford to check in at all does so at least this often. */
export const PULSE_MAX_MS = 24 * 3_600_000;
/** A mind on its creator's own server costs nothing to wake, so it has one fixed pace. */
export const PULSE_OWN_MS = 3 * 3_600_000;
/** The share of a mind's daily thinking limit its check-ins may use. */
export const PULSE_SHARE = 0.5;
/** A day of check-ins costs at most this share of what the treasury holds. */
export const PULSE_TREASURY_SHARE = 0.02;
/** The share of the budget all minds share on Axon's keys that may be used before check-ins wait: what happens to a token comes first. */
export const PULSE_BUDGET_SHARE = 0.7;
/** The radar wakes a mind at most this often. */
export const RADAR_GAP_MS = 3_600_000;
/** A change this large since its last look counts as its numbers having moved. */
const MOVED_PCT = 5;
// what a mind's thinking may cost in a day when its own limit is not at hand (the ceiling no mind may pass)
const CEILING_ETH = 0.01;

export function pulseEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MINDS_PULSE ?? "on").trim().toLowerCase() !== "off";
}

/**
 * How often a mind checks in when nothing wakes it, or null when its treasury is too small to. `estimateEth` is what
 * one thought costs it, `ceilingEth` what its thinking may cost in a day, `treasuryEth` what it holds.
 */
export function pulseEveryMs(c: { estimateEth: number; ceilingEth: number; treasuryEth: number; own?: boolean }): number | null {
  if (c.own) return PULSE_OWN_MS;
  if (!(c.estimateEth > 0)) return PULSE_MIN_MS;
  const perDay = Math.min((c.ceilingEth * PULSE_SHARE) / c.estimateEth, (Math.max(0, c.treasuryEth) * PULSE_TREASURY_SHARE) / c.estimateEth);
  if (perDay < 1) return null;
  return Math.min(PULSE_MAX_MS, Math.max(PULSE_MIN_MS, Math.round(86_400_000 / perDay)));
}

export interface Pulse {
  /** its pace right now, slowed by how often it has found nothing new; null when it does not check in */
  everyMs: number | null;
  /** when its next check-in is due; null when it does not check in or has never thought */
  nextAt: number | null;
  due: boolean;
  /** why it is waking, in the words the mind is told; null when it is not due */
  reason: string | null;
  kind: "radar" | "timer" | null;
}
const NONE: Pulse = { everyMs: null, nextAt: null, due: false, reason: null, kind: null };

const span = (ms: number): string => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${Math.floor(m / 1440)} days`; };
/** A length of time in words: "40 min", "2 h 5 min", "3 days". */
export const pulseSpan = span;

interface TokenRow { model: string | null; tax_bps: number | null; mcap_eth: number | null; holders: number; treasury_eth: number }

/**
 * Whether a mind should check in now, and when it will next. Reads Axon's own records only, so it can be asked for
 * every quiet mind on every pass. `treasuryEth` and `ceilingEth` are the chain's own figures when the caller has
 * them; without them the last figure Axon read and the ceiling no mind may pass are used.
 */
export function pulseState(token: string, now: number, c: { usdPerEth: number | null; treasuryEth?: number; ceilingEth?: number }): Pulse {
  const db = getDb(), t = token.toLowerCase();
  const m = db.prepare("SELECT t.model, t.tax_bps, s.mcap_eth, COALESCE(s.holders, 0) holders, COALESCE(s.treasury_eth, 0) treasury_eth FROM mind_tokens t JOIN mind_stats s ON s.token = t.token WHERE t.token = ?").get(t) as TokenRow | undefined;
  // its own last look: a standing order firing is not one
  const last = db.prepare("SELECT at, mcap_eth, holders FROM mind_thoughts WHERE token = ? AND source != 'order' ORDER BY id DESC LIMIT 1").get(t) as { at: string; mcap_eth: number | null; holders: number | null } | undefined;
  // a mind that has never thought has nothing to check in on: its first thought is woken by its launch
  if (!m || !last) return NONE;

  const own = m.model === OWN_MIND;
  if (!own && !c.usdPerEth) return NONE;
  const base = pulseEveryMs({ own, estimateEth: own ? 0 : estimateThoughtUsd(mindModel(m.model)) / (c.usdPerEth as number), ceilingEth: c.ceilingEth ?? CEILING_ETH, treasuryEth: c.treasuryEth ?? m.treasury_eth });
  if (base === null) return NONE;

  // how many check-ins in a row found nothing to do; anything else in between (an event, an action, an order firing) starts the count again
  const recent = db.prepare("SELECT source, action FROM mind_thoughts WHERE token = ? AND status = 'thought' ORDER BY id DESC LIMIT 12").all(t) as { source: string; action: string | null }[];
  let quiet = 0;
  for (const r of recent) { if (r.source === "pulse" && !r.action) quiet++; else break; }
  const cap = last.mcap_eth && m.mcap_eth ? Math.abs(((m.mcap_eth - last.mcap_eth) / last.mcap_eth) * 100) : 0;
  const moved = cap >= MOVED_PCT || (last.holders !== null && last.holders !== m.holders);
  const everyMs = moved ? base : Math.min(PULSE_MAX_MS, base * (1 + quiet));
  const lastAt = Date.parse(last.at), nextAt = lastAt + everyMs;

  // the radar: something unusual right now, and it has not already been woken for it within the hour
  const radar = sensesOf(t, m.tax_bps, now).radar;
  if (radar.length) {
    const woken = (db.prepare("SELECT MAX(at) v FROM mind_thoughts WHERE token = ? AND source = 'pulse' AND reasons LIKE '%its radar:%'").get(t) as { v: string | null }).v;
    if (!woken || now - Date.parse(woken) >= RADAR_GAP_MS) return { everyMs, nextAt, due: true, reason: `its radar: ${radar.join("; ")}`, kind: "radar" };
  }
  if (now >= nextAt) return { everyMs, nextAt, due: true, reason: `a check-in of its own: nothing has woken it for ${span(now - lastAt)}`, kind: "timer" };
  return { everyMs, nextAt, due: false, reason: null, kind: null };
}
