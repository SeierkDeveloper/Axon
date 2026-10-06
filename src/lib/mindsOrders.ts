// Agent Minds 2: standing orders.
//
// A mind that only acts when it thinks is always a step behind: it wakes on an event, at most once every ten minutes,
// and a move it would have wanted to answer may be over by then. A standing order is its answer set ahead of time:
// WHEN a condition holds, THEN one action. The mind arms it in the same answer as a thought, in its own words, and
// holders can read it on the token's page before anything happens.
//
// When the condition is met the order fires at once, with no model called and nothing to pay for. Firing gives it no
// special standing: it becomes an ordinary proposal, written into the mind's journal, and goes through the same rule
// check, the same second look before sending and the same limits in the treasury's contract as any other. An order
// fires once. One that is not met in time lapses. Off with MINDS_ORDERS=off: then none fires and none is armed.
//
// A promise is a standing order the mind makes in public and binds itself to. Three things set it apart: it must say
// what it promises in a sentence holders can read, the mind cannot take it back, and its amount is held in the
// treasury from the moment it is made, so that nothing else the mind does can spend it. When its condition is met it
// is kept or missed, and the count of both is shown. One whose condition never came was not called on.

import { getDb } from "./db";
import { agentMindsEnabled } from "./mindsPolicy";
import { mindsChain, type MindsChain } from "./mindsChain";
import { thinkingMode } from "./mindsThinker";
import { checkProposal, MIN_ACTION_ETH, type Proposal, type ProposalKind } from "./mindsRules";
import { CAN } from "./mindsLaunch";
import { reserveOf } from "./mindsPlan";
import { addEvent } from "./mindsStats";
import { mindsHalted } from "./mindsAdmin";
import { validateAgentText } from "./agentContent";
import { plain } from "./mindsText";
import { logger } from "./logger";

export type WhenKind = "market_cap_below" | "market_cap_above" | "market_cap_drops_pct" | "market_cap_rises_pct" | "holders_reach" | "treasury_reaches" | "graduates";
export type OrderStatus = "armed" | "fired" | "kept" | "missed" | "lapsed" | "cancelled";
export interface Order {
  id: number; token: string; thoughtId: number | null;
  when: { kind: WhenKind; value: number; base: number | null };
  then: Proposal;
  promise: boolean; said: string | null; status: OrderStatus;
  expiresAt: string | null; createdAt: string; firedAt: string | null; firedThoughtId: number | null; note: string | null;
}

/** A mind keeps at most this many orders armed at once. */
export const MAX_ARMED = 3;
export const ORDER_HOURS = { least: 1, usual: 24, most: 168 } as const;
/** The model a fired order's journal entry is written under: no model wrote it. */
export const ORDER_MODEL = "order";
const SAID_CHARS = 200;
const WHENS: readonly WhenKind[] = ["market_cap_below", "market_cap_above", "market_cap_drops_pct", "market_cap_rises_pct", "holders_reach", "treasury_reaches", "graduates"];
const FLAG: Record<ProposalKind, number> = { buyback: CAN.buyback, reward: CAN.reward, burn_axon: CAN.burnAxon };
const DOES: Record<ProposalKind, string> = { buyback: "buy back and burn", reward: "reward holders", burn_axon: "burn $AXON" };

/** What an order's condition is measured against: the token's numbers as Axon last read them from the chain. */
export interface Measures { mcapEth: number | null; holders: number; treasuryEth: number; phase: number }

interface Row { id: number; token: string; thought_id: number | null; when_kind: string; when_value: number; when_base: number | null; then_kind: string; then_eth: number; promise: number; said: string | null; status: string; expires_at: string | null; created_at: string; fired_at: string | null; fired_thought_id: number | null; note: string | null }
const toOrder = (r: Row): Order => ({
  id: r.id, token: r.token, thoughtId: r.thought_id, when: { kind: r.when_kind as WhenKind, value: r.when_value, base: r.when_base }, then: { kind: r.then_kind as ProposalKind, eth: r.then_eth },
  promise: r.promise === 1, said: r.said, status: r.status as OrderStatus, expiresAt: r.expires_at, createdAt: r.created_at, firedAt: r.fired_at, firedThoughtId: r.fired_thought_id, note: r.note,
});

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);
const trim = (v: number, digits = 4) => plain(v, digits);

/** Whether an order's condition holds for these numbers. A number that could not be read never meets a condition. */
export function met(w: Order["when"], n: Measures): boolean {
  switch (w.kind) {
    case "market_cap_below": return n.mcapEth !== null && n.mcapEth <= w.value;
    case "market_cap_above": return n.mcapEth !== null && n.mcapEth >= w.value;
    case "market_cap_drops_pct": return n.mcapEth !== null && w.base !== null && w.base > 0 && n.mcapEth <= w.base * (1 - w.value / 100);
    case "market_cap_rises_pct": return n.mcapEth !== null && w.base !== null && w.base > 0 && n.mcapEth >= w.base * (1 + w.value / 100);
    case "holders_reach": return n.holders >= w.value;
    case "treasury_reaches": return n.treasuryEth >= w.value;
    case "graduates": return n.phase >= 2;
  }
}

/** An order's condition in words, as it is shown and as its mind reads it back. */
export function whenText(w: Order["when"]): string {
  switch (w.kind) {
    case "market_cap_below": return `the market cap is at or below ${trim(w.value)} ETH`;
    case "market_cap_above": return `the market cap is at or above ${trim(w.value)} ETH`;
    case "market_cap_drops_pct": return `the market cap falls ${trim(w.value)}% from ${trim(w.base ?? 0)} ETH`;
    case "market_cap_rises_pct": return `the market cap rises ${trim(w.value)}% from ${trim(w.base ?? 0)} ETH`;
    case "holders_reach": return `holders reach ${Math.round(w.value)}`;
    case "treasury_reaches": return `the treasury holds ${trim(w.value)} ETH`;
    case "graduates": return "the token graduates to its pool";
  }
}
export const thenText = (p: Proposal): string => `${DOES[p.kind]} with ${trim(p.eth)} ETH`;

/** How far the numbers are from an order's condition, for the mind to read; empty when there is nothing useful to say. */
function distance(w: Order["when"], n: Measures): string {
  const pct = (now: number, from: number) => `${now >= from ? "+" : ""}${(((now - from) / from) * 100).toFixed(1)}%`;
  if ((w.kind === "market_cap_drops_pct" || w.kind === "market_cap_rises_pct") && n.mcapEth !== null && w.base) return ` (now ${pct(n.mcapEth, w.base)} from there)`;
  if ((w.kind === "market_cap_below" || w.kind === "market_cap_above") && n.mcapEth !== null) return ` (now ${trim(n.mcapEth)} ETH)`;
  if (w.kind === "holders_reach") return ` (now ${n.holders})`;
  if (w.kind === "treasury_reaches") return ` (now ${trim(n.treasuryEth)} ETH)`;
  return "";
}

function said(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let text = v.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").replace(/–/g, "-").replace(/"/g, "'").trim();
  if (text.length > SAID_CHARS) { const cut = text.slice(0, SAID_CHARS); text = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), SAID_CHARS - 20))}…`; }
  return text.length < 8 || validateAgentText(text) ? null : text;
}

export interface Wanted { when: Order["when"]; then: Proposal; hours: number; said: string | null; promise: boolean }
export interface ArmContext {
  allowed: number; attached?: boolean; maxPerActionEth: number; numbers: Measures;
  /** what the treasury has free to promise right now: above its thinking costs, its reserve, what is already held and what it is spending in this answer. A promise it cannot cover is not made. */
  freeEth?: number;
}

/**
 * Read one order out of a mind's answer. Returns the order, or the plain reason it cannot be armed. An order is only
 * armed for something the mind may do, inside what one action may spend, on a condition that is not already true: a
 * standing order is for something that has not happened yet, never a second action dressed up as one.
 */
export function readOrder(raw: unknown, c: ArmContext): Wanted | { refused: string } {
  if (!raw || typeof raw !== "object") return { refused: "It could not be read." };
  const r = raw as Record<string, unknown>;
  const w = (r.when && typeof r.when === "object" ? r.when : {}) as Record<string, unknown>;
  const t = (r.then && typeof r.then === "object" ? r.then : {}) as Record<string, unknown>;
  const kind = String(w.kind ?? "").toLowerCase().replace(/[\s-]+/g, "_") as WhenKind;
  if (!WHENS.includes(kind)) return { refused: "Its condition is not one that can be measured." };
  const then = String(t.kind ?? "").toLowerCase().replace(/[\s-]+/g, "_") as ProposalKind;
  if (!(then in FLAG)) return { refused: "Its action is not one a mind can take." };
  const eth = num(t.eth);
  if (!Number.isFinite(eth) || eth <= 0) return { refused: "Its amount is not a number above zero." };
  if (!(c.allowed & FLAG[then]) || (then === "reward" && c.attached)) return { refused: `This mind was never allowed to ${DOES[then]}.` };
  if (eth < MIN_ACTION_ETH) return { refused: `Too small to be worth sending: the least is ${MIN_ACTION_ETH} ETH.` };
  if (eth > c.maxPerActionEth) return { refused: `More than one action may spend (${c.maxPerActionEth} ETH).` };

  const n = c.numbers;
  let value = kind === "graduates" ? 0 : num(w.value), base: number | null = null;
  if (kind !== "graduates" && (!Number.isFinite(value) || value <= 0)) return { refused: "Its condition has no number above zero." };
  if (kind === "market_cap_drops_pct" || kind === "market_cap_rises_pct") {
    if (n.mcapEth === null || n.mcapEth <= 0) return { refused: "The market cap is not known right now, so there is nothing to measure a change from." };
    if (value < 1 || value > (kind === "market_cap_drops_pct" ? 95 : 1000)) return { refused: "The change it waits for is out of range." };
    base = n.mcapEth;
  }
  if (kind === "holders_reach") value = Math.round(value);
  const when = { kind, value, base };
  if (met(when, n)) return { refused: "Its condition is already true, so there is nothing to wait for." };

  const h = num(r.hours);
  const hours = Number.isFinite(h) ? Math.min(ORDER_HOURS.most, Math.max(ORDER_HOURS.least, Math.round(h))) : ORDER_HOURS.usual;
  const promise = r.promise === true || r.promise === "true" || r.promise === 1, words = said(r.say ?? r.said);
  if (promise && !words) return { refused: "A promise has to say what it promises, in a sentence holders can read." };
  return { when, then: { kind: then, eth: Math.floor(eth * 1e9) / 1e9 }, hours, said: words, promise };
}

/** A token's orders: those armed, oldest first, then the most recent that are not. */
export function ordersOf(token: string, recent = 10): Order[] {
  const db = getDb(), t = token.toLowerCase();
  const armed = db.prepare("SELECT * FROM mind_orders WHERE token = ? AND status = 'armed' ORDER BY id ASC").all(t) as Row[];
  const rest = db.prepare("SELECT * FROM mind_orders WHERE token = ? AND status != 'armed' ORDER BY id DESC LIMIT ?").all(t, Math.max(0, recent)) as Row[];
  return [...armed, ...rest].map(toOrder);
}
/** ETH held for a token's standing promises. `except` leaves one out: the promise that is being kept right now. */
export const heldFor = (token: string, except = 0): number => (getDb().prepare("SELECT COALESCE(SUM(then_eth), 0) v FROM mind_orders WHERE token = ? AND status = 'armed' AND promise = 1 AND id != ?").get(token.toLowerCase(), except) as { v: number }).v;

export interface PromiseRecord { made: number; standing: number; kept: number; missed: number; notCalled: number; beingKept: number; heldEth: number }
/**
 * A mind's record with its promises. Kept: its condition came and the action was carried out on chain. Missed: its
 * condition came and the action was not carried out. Not called: its time ran out before the condition came, which
 * is neither. Being kept: the condition came and the action is on its way.
 */
export function promiseRecord(token: string): PromiseRecord {
  const t = token.toLowerCase();
  const rows = getDb().prepare("SELECT status, COUNT(*) n FROM mind_orders WHERE token = ? AND promise = 1 GROUP BY status").all(t) as { status: string; n: number }[];
  const of = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { made: rows.reduce((s, r) => s + r.n, 0), standing: of("armed"), kept: of("kept"), missed: of("missed"), notCalled: of("lapsed"), beingKept: of("fired"), heldEth: heldFor(t) };
}

export const armedCount = (token: string): number => (getDb().prepare("SELECT COUNT(*) n FROM mind_orders WHERE token = ? AND status = 'armed'").get(token.toLowerCase()) as { n: number }).n;

/**
 * Take the orders a mind wrote in an answer: cancel the ones it named, then arm the new ones while there is room.
 * Returns what was armed and what was not, with the reason, so the answer's record can say so.
 */
export function saveOrders(token: string, raw: { orders?: unknown; cancel?: unknown }, thoughtId: number | null, c: ArmContext, now = Date.now()): { armed: Order[]; refused: string[]; cancelled: number } {
  const db = getDb(), t = token.toLowerCase(), at = new Date(now).toISOString();
  let cancelled = 0;
  for (const v of Array.isArray(raw.cancel) ? raw.cancel.slice(0, 10) : []) {
    const id = num(v);
    // a promise is not taken back by cancelling it: it stands until it is kept, missed or its time runs out
    if (Number.isInteger(id)) cancelled += db.prepare("UPDATE mind_orders SET status = 'cancelled', note = 'Cancelled by the mind.' WHERE id = ? AND token = ? AND status = 'armed' AND promise = 0").run(id, t).changes;
  }
  const armed: Order[] = [], refused: string[] = [];
  let free = c.freeEth ?? 0;
  for (const one of Array.isArray(raw.orders) ? raw.orders.slice(0, 6) : []) {
    const o = readOrder(one, c);
    if ("refused" in o) { refused.push(o.refused); continue; }
    if (armedCount(t) >= MAX_ARMED) { refused.push(`It already has ${MAX_ARMED} orders armed, which is the most a mind keeps at once.`); continue; }
    // a promise is only made with the ETH to keep it in the treasury now, and that ETH is held from here on
    if (o.promise) {
      if (o.then.eth > free + 1e-12) { refused.push(`The treasury cannot cover this promise now: ${Math.max(0, free).toFixed(6)} ETH is free to promise.`); continue; }
      free -= o.then.eth;
    }
    const r = db.prepare("INSERT INTO mind_orders (token, thought_id, when_kind, when_value, when_base, then_kind, then_eth, promise, said, status, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,'armed',?,?)")
      .run(t, thoughtId, o.when.kind, o.when.value, o.when.base, o.then.kind, o.then.eth, o.promise ? 1 : 0, o.said, new Date(now + o.hours * 3_600_000).toISOString(), at);
    armed.push(toOrder(db.prepare("SELECT * FROM mind_orders WHERE id = ?").get(r.lastInsertRowid) as Row));
  }
  return { armed, refused, cancelled };
}

const left = (iso: string | null, now: number): string => {
  if (!iso) return "no end";
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60_000));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} days`;
};
const ago = (iso: string, now: number): string => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`; };
const ENDED: Record<Exclude<OrderStatus, "armed">, string> = { fired: "its condition was met and it was put to the rule check", kept: "its condition was met and it was carried out", missed: "its condition was met but it was not carried out", lapsed: "its time ran out unmet", cancelled: "you cancelled it" };

/** A mind's orders as the lines it reads. Short on purpose: every word of this is paid for by its treasury. */
export function ordersLines(token: string, n: Measures, now = Date.now()): string[] {
  const all = ordersOf(token, 3), armed = all.filter((o) => o.status === "armed"), rest = all.filter((o) => o.status !== "armed");
  const recently = rest.length ? [`  earlier: ${rest.map((o) => `#${o.id} (when ${whenText(o.when)}, ${thenText(o.then)}): ${ENDED[o.status as Exclude<OrderStatus, "armed">]}${o.status === "missed" && o.note ? ` (${o.note})` : ""}, ${ago(o.firedAt ?? o.expiresAt ?? o.createdAt, now)}`).join("; ")}`] : [];
  const p = promiseRecord(token);
  const promises = p.made === 0 ? "your_promises: none made yet"
    : `your_promises: ${p.standing} standing${p.heldEth > 0 ? ` (${trim(p.heldEth)} ETH held for them, which nothing else may spend)` : ""}, ${p.kept} kept, ${p.missed} missed${p.notCalled ? `, ${p.notCalled} never called on` : ""}${p.beingKept ? `, ${p.beingKept} being kept now` : ""}`;
  if (!armed.length) return [`your_standing_orders: none armed. You may arm up to ${MAX_ARMED} (see "orders" below).`, ...recently, promises];
  return [
    `your_standing_orders (${armed.length} of ${MAX_ARMED} armed):`,
    ...armed.map((o) => `  #${o.id}${o.promise ? " (a promise, it cannot be cancelled)" : ""}: when ${whenText(o.when)}${distance(o.when, n)}, ${thenText(o.then)}; ${o.promise ? "stands for another" : "lapses in"} ${left(o.expiresAt, now)}`),
    ...recently,
    promises,
  ];
}

/** Standing orders can be switched off on their own: none fires and none is armed, while everything else a mind does goes on. */
export function ordersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MINDS_ORDERS ?? "on").trim().toLowerCase() !== "off";
}

export interface FireOptions { chain?: MindsChain; env?: Record<string, string | undefined>; now?: number }

interface Armed extends Row { vault: string; attached: number; phase: number; mcap_eth: number | null; holders: number; treasury_eth: number }

/** What its journal says when an order fires: written by plain code from the order itself, in the mind's voice. */
function firedText(o: Order, n: Measures): string {
  const now = o.when.kind.startsWith("market_cap") && n.mcapEth !== null ? ` It stands at ${trim(n.mcapEth)} ETH.` : o.when.kind === "holders_reach" ? ` There are ${n.holders} now.` : "";
  if (o.promise) return `I made a promise: "${o.said ?? ""}" Its moment has come: ${whenText(o.when)}.${now} Keeping it means I ${thenText(o.then)}, from the ETH I held for it. That goes to the rule check now.`;
  return `My standing order was met: ${whenText(o.when)}.${now}${o.said ? ` When I set it I said: "${o.said}"` : ""} It calls for me to ${thenText(o.then)}, so that goes to the rule check now.`;
}

/**
 * Look at every armed order: let the ones whose time has run out lapse, and fire the ones whose condition is met.
 * Firing writes an entry in the mind's journal with the order's action as its proposal, checked by the rule check
 * against what the treasury holds now. No model is called and nothing is sent here: an approved proposal is carried
 * out by the same sender, after the same second look, as one a mind thought of. One order a token a pass.
 */
export async function fireDue(o: FireOptions = {}): Promise<{ fired: number; lapsed: number } | null> {
  const env = o.env ?? process.env, now = o.now ?? Date.now(), chain = o.chain ?? mindsChain;
  if (!agentMindsEnabled(env) || thinkingMode(env) === "off" || mindsHalted() || !ordersEnabled(env)) return null;
  const db = getDb(), at = new Date(now).toISOString();
  const lapsed = db.prepare("UPDATE mind_orders SET status = 'lapsed' WHERE status = 'armed' AND expires_at IS NOT NULL AND expires_at <= ?").run(at).changes;
  const rows = db.prepare(
    `SELECT o.*, t.vault, t.attached, COALESCE(s.phase, 0) phase, s.mcap_eth, COALESCE(s.holders, 0) holders, COALESCE(s.treasury_eth, 0) treasury_eth
       FROM mind_orders o JOIN mind_tokens t ON t.token = o.token JOIN mind_stats s ON s.token = o.token
      WHERE o.status = 'armed' AND t.stopped_at IS NULL AND s.updated_at IS NOT NULL ORDER BY o.id ASC`,
  ).all() as Armed[];
  let fired = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.token)) continue;
    const order = toOrder(r), n: Measures = { mcapEth: r.mcap_eth, holders: r.holders, treasuryEth: r.treasury_eth, phase: r.phase };
    if (!met(order.when, n)) continue;
    seen.add(r.token);
    try {
      const treasury = await chain.treasury(r.vault);
      // a mind that is paused, frozen or stopped fires nothing; its orders wait as they are
      if (!treasury.active) continue;
      const day = await chain.vaultDay(r.vault).catch(() => null);
      const owed = owedThinking(r.token);
      const verdict = checkProposal(order.then, {
        allowed: treasury.limits.allowed, maxPerDayEth: treasury.limits.maxPerDayEth, maxPerActionEth: treasury.limits.maxPerActionEth, maxActionsPerDay: treasury.limits.maxActionsPerDay,
        availableEth: treasury.availableEth, owedThinkingEth: owed, spentTodayEth: day?.spentTodayEth ?? 0, actionsToday: day?.actionsToday ?? 0, active: treasury.active, phase: r.phase, holders: r.holders, attached: r.attached === 1,
        reserveEth: reserveOf(r.token),
        // what is held for its other promises stays held; a promise being kept spends its own
        heldEth: heldFor(r.token, order.promise ? r.id : 0),
      });
      db.transaction(() => {
        // it carries on from the newest event the mind has seen, so firing never hides news from its next thought
        const lastEvent = (db.prepare("SELECT COALESCE(MAX(last_event_id), 0) v FROM mind_thoughts WHERE token = ?").get(r.token) as { v: number }).v;
        const t = db.prepare(
          "INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, action, verdict, verdict_reason, input_tokens, output_tokens, cost_usd, cost_eth, last_event_id, error, source, mcap_eth, holders) VALUES (?,?,?,0,'thought',?,?,?,?,?,0,0,0,0,?,NULL,'order',?,?)",
        ).run(r.token, at, ORDER_MODEL, JSON.stringify([`${order.promise ? "a promise it made" : "a standing order it set"}: when ${whenText(order.when)}`]), firedText(order, n), JSON.stringify(order.then), verdict.ok ? "approved" : "refused", verdict.ok ? null : verdict.reason, lastEvent, r.mcap_eth, r.holders);
        db.prepare("UPDATE mind_orders SET status = ?, fired_at = ?, fired_thought_id = ?, note = ? WHERE id = ? AND status = 'armed'").run(verdict.ok ? "fired" : "missed", at, t.lastInsertRowid, verdict.ok ? null : verdict.reason, r.id);
        addEvent(r.token, "thought", { at });
      })();
      fired++;
      logger.info("minds.order_fired", "A mind's standing order fired", { token: r.token, order: r.id, when: whenText(order.when), then: order.then, approved: verdict.ok });
    } catch (err) {
      logger.warn("minds.order_error", "Firing a standing order went wrong", { err, token: r.token, order: r.id });
    }
  }
  return { fired, lapsed };
}

// what a mind has thought for and not paid yet (the same sum the mind itself is held to; kept here so that this file
// does not have to import the thinking module, which imports this one)
function owedThinking(token: string): number {
  const db = getDb();
  const cost = (db.prepare("SELECT COALESCE(SUM(cost_eth), 0) v FROM mind_thoughts WHERE token = ? AND standin = 0").get(token) as { v: number }).v;
  const paid = (db.prepare("SELECT COALESCE(SUM(eth), 0) v FROM mind_actions WHERE token = ? AND kind = 'thinking' AND status IN ('pending', 'sent', 'done')").get(token) as { v: number }).v;
  return Math.max(0, cost - paid);
}

/**
 * Close the orders that fired: one whose proposal was carried out on chain was kept; one that was dropped on the
 * second look, or whose transaction failed, was missed, with the reason. Reads the database only.
 */
export function settleOrders(): number {
  const db = getDb();
  const rows = db.prepare(
    "SELECT o.id, a.status, a.error FROM mind_orders o JOIN mind_actions a ON a.thought_id = o.fired_thought_id WHERE o.status = 'fired' AND a.status IN ('done', 'failed', 'dropped')",
  ).all() as { id: number; status: string; error: string | null }[];
  for (const r of rows) db.prepare("UPDATE mind_orders SET status = ?, note = ? WHERE id = ? AND status = 'fired'").run(r.status === "done" ? "kept" : "missed", r.status === "done" ? null : r.error, r.id);
  return rows.length;
}
