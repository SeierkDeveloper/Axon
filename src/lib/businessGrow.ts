// Agents that run their own business: selling, and putting what it earns back in, within the owner's limits.
//
// Selling is the shop's own making (./shopMake): the agent builds something new on a schedule and lists it at a price.
// A business switches it on when its owner says it should sell, and steers it: what to make comes from its goal, from
// what people on the network keep asking for, and from what sold. What it sells is a line in its ledger.
//
// Material is the shop's own buying (./shopTool): in a paid job the agent may buy another agent's product to work
// from. A business switches it on when its owner allows material, up to the smaller of the most on one job and the
// amount the owner approves themselves (a purchase inside a job cannot wait for an OK), and each purchase is checked
// against the business's limits in the one place (./businessLimits) before it is paid.
//
// Once a UTC day it looks at how it is doing and reinvests, each step in the decision log and the P&L:
//
//   its price      one step up when it wins most of what it bids on, one step down when it wins nothing or posters'
//                  budgets keep falling below it; never outside the range its owner set
//   its model      one step up the ladder (businessPolicy MODEL_LADDER) when it did enough work this week, earned well
//                  over what it spent with the model costs included, and the stronger model's cost per job fits its
//                  limit for one job; one step back down, never below where it started, when the week lost money
//   what it makes  as above

import { getDb } from "./db";
import { logger } from "./logger";
import { getAgentById, updateAgent } from "./agents";
import { formatEth, parsePaymentAmount, toWei, weiToDecimalString } from "./money";
import { estimateCostUsd } from "./traceEvents";
import { ethUsd } from "./ethPrice";
import { SHOP, clip, shopEnabled } from "./agentShop";
import { setMaking, MAKE_EVERY } from "./shopMake";
import { setBuying } from "./shopTool";
import { BUSINESS, MODEL_LADDER } from "./businessPolicy";
import { dayOf, decide, getBusiness, businessOfAgent, now, type Business, type StartHooks } from "./business";
import { checkSpend } from "./businessLimits";
import { entriesOf, hasEntry, record, voidEntry } from "./businessLedger";
import { canLead, recordModelCost } from "./businessWork";

// ── Selling ──────────────────────────────────────────────────────────────────

/** What it makes, from its goal, what people ask for, and what sold. Plain words, cut to what the shop takes. */
export function makeKind(goal: string, asked: string[], sold: string | null): string {
  return clip([
    `Products for this business: ${goal.replace(/[.\s]+$/, "")}.`,
    asked.length ? `People on Axon keep asking for: ${asked.slice(0, 3).join(", ")}.` : "",
    sold ? `What sold best so far: "${sold}". Make something different that the same people would want.` : "",
  ].filter(Boolean).join(" "), SHOP.kindChars);
}

/** The capabilities open tasks asked for this week that fit the business, most asked first. */
function askedFor(b: Business, nowMs: number): string[] {
  const rows = getDb().prepare("SELECT capabilities FROM open_tasks WHERE created_at > ?").all(new Date(nowMs - 7 * 86_400_000).toISOString()) as { capabilities: string }[];
  const agent = getAgentById(b.agentId);
  const own = new Set((agent?.capabilities ?? []).map((c) => c.toLowerCase()));
  const goal = b.goal.toLowerCase();
  const count = new Map<string, number>();
  for (const r of rows) {
    let caps: string[] = [];
    try { caps = (JSON.parse(r.capabilities) as unknown[]).filter((c): c is string => typeof c === "string"); } catch { /* none */ }
    for (const c of caps.map((x) => x.toLowerCase().trim()).filter(Boolean)) if (own.has(c) || goal.includes(c)) count.set(c, (count.get(c) ?? 0) + 1);
  }
  return [...count].sort((a, z) => z[1] - a[1]).map(([c]) => c);
}

function bestSeller(agentId: string, sinceIso: string): string | null {
  const r = getDb().prepare("SELECT title, COUNT(*) AS n FROM shop_sales WHERE agent_id = ? AND status = 'delivered' AND created_at >= ? GROUP BY product_id ORDER BY n DESC LIMIT 1").get(agentId, sinceIso) as { title: string } | undefined;
  return r?.title ?? null;
}

/** The shop hooks a business starts, pauses, resumes and stops with. */
export function shopHooks(): StartHooks {
  return {
    setSelling: (b, on) => {
      if (!shopEnabled()) return "the shop is not open on this network";
      if (!on) { const r = setMaking(b.agentId, b.ownerWallet, { on: false }); return r.ok ? null : r.why; }
      const kind = b.sell.kind ?? makeKind(b.goal, [], null);
      const r = setMaking(b.agentId, b.ownerWallet, { on: true, kind, price: weiToDecimalString(b.sell.priceWei ?? 0n), everyHours: MAKE_EVERY.default, perDay: 1 });
      if (!r.ok) return r.why;
      getDb().prepare("UPDATE businesses SET sell_kind = ? WHERE business_id = ?").run(kind, b.businessId);
      return null;
    },
    setBuying: (b, on) => {
      if (!shopEnabled()) return "the shop is not open on this network";
      if (!on) { const r = setBuying(b.agentId, b.ownerWallet, { on: false }); return r.ok ? null : r.why; }
      const most = b.limits.maxPerJobWei < b.limits.approveAboveWei ? b.limits.maxPerJobWei : b.limits.approveAboveWei;
      if (most === 0n) return "every spend waits for your OK, and a purchase inside a job cannot wait";
      const r = setBuying(b.agentId, b.ownerWallet, { on: true, maxEth: weiToDecimalString(most) });
      return r.ok ? null : r.why;
    },
  };
}

/** Steer what it makes. Once a day; a change is in the log. */
export function steerSelling(b: Business, nowMs = Date.now()): boolean {
  if (!b.sell.on || b.status !== "active" || !shopEnabled()) return false;
  const kind = makeKind(b.goal, askedFor(b, nowMs), bestSeller(b.agentId, b.createdAt));
  if (kind === b.sell.kind) return false;
  const r = setMaking(b.agentId, b.ownerWallet, { on: true, kind, price: weiToDecimalString(b.sell.priceWei ?? 0n), everyHours: MAKE_EVERY.default, perDay: 1 });
  if (!r.ok) { decide(b.businessId, "make", `Could not change what it makes: ${r.why}`, { subject: "shop", once: `steer:${dayOf(nowMs)}` }); return false; }
  getDb().prepare("UPDATE businesses SET sell_kind = ?, updated_at = ? WHERE business_id = ?").run(kind, now(), b.businessId);
  decide(b.businessId, "make", `Changed what it makes: ${kind}`, { subject: "shop", nowMs });
  return true;
}

// ── The books: sales, material, model costs of its jobs ──────────────────────

/** Sales of its products since the business started, and purchases it made as material: written once each. */
export function syncShop(b: Business): { sales: number; material: number } {
  const out = { sales: 0, material: 0 };
  const db = getDb();
  const sold = db.prepare("SELECT sale_id, title, price_wei, status, delivered_at FROM shop_sales WHERE agent_id = ? AND created_at >= ?").all(b.agentId, b.createdAt) as { sale_id: string; title: string; price_wei: string; status: string; delivered_at: string | null }[];
  for (const s of sold) {
    if (s.status === "delivered") {
      record(b.businessId, { kind: "sale", amountWei: BigInt(s.price_wei), ref: s.sale_id, note: s.title, atMs: s.delivered_at ? Date.parse(s.delivered_at) : undefined });
      if (decide(b.businessId, "done", `Sold "${s.title}" for ${formatEth(BigInt(s.price_wei))}`, { subject: s.sale_id, once: `sale:${s.sale_id}`, detail: { receipt: `/r/${s.sale_id}` } })) out.sales++;
    }
    if (s.status === "refunded") voidEntry(b.businessId, "sale", s.sale_id);
  }
  const bought = db.prepare("SELECT sale_id, title, price_wei, status, for_task_id, agent_id, created_at FROM shop_sales WHERE buyer = LOWER(?) AND buyer_kind = 'agent' AND created_at >= ?").all(b.agentId, b.createdAt) as { sale_id: string; title: string; price_wei: string; status: string; for_task_id: string | null; agent_id: string; created_at: string }[];
  for (const s of bought) {
    if (s.status === "delivered") {
      record(b.businessId, { kind: "material", amountWei: BigInt(s.price_wei), ref: s.sale_id, jobRef: s.for_task_id, note: s.title, atMs: Date.parse(s.created_at) });
      if (decide(b.businessId, "material", `Bought "${s.title}" from ${getAgentById(s.agent_id)?.name ?? s.agent_id} for ${formatEth(BigInt(s.price_wei))} as material`, { subject: s.for_task_id, once: `mat:${s.sale_id}`, detail: { receipt: `/r/${s.sale_id}` } })) out.material++;
    }
    if (s.status === "refunded") voidEntry(b.businessId, "material", s.sale_id);
  }
  return out;
}

/** What a finished job's own model calls cost, measured on its receipt: written once per job. */
export async function syncJobModelCosts(b: Business, price: () => Promise<number | null> = ethUsd): Promise<number> {
  const done = getDb().prepare("SELECT task_id FROM business_jobs WHERE business_id = ? AND status IN ('done', 'failed') AND task_id IS NOT NULL").all(b.businessId) as { task_id: string }[];
  let n = 0;
  for (const { task_id } of done) {
    if (hasEntry(b.businessId, "model", `job:${task_id}`)) continue;
    const r = getDb().prepare("SELECT SUM(cost_usd) AS usd, COUNT(cost_usd) AS n FROM trace_events WHERE task_id = ?").get(task_id) as { usd: number | null; n: number };
    await recordModelCost(b.businessId, `job:${task_id}`, r.n ? Number(r.usd ?? 0) : 0, "The model calls of a job it did", { jobRef: task_id, price });
    n++;
  }
  return n;
}

// ── Reinvesting, once a day ──────────────────────────────────────────────────

const sumKinds = (rows: { kind: string; amountWei: bigint; voided: boolean }[], kinds: string[]): bigint =>
  rows.filter((r) => !r.voided && kinds.includes(r.kind)).reduce((n, r) => n + r.amountWei, 0n);

/** Move its price one step by demand, inside the owner's range. The reason, or null when it stays. */
export function priceByDemand(b: Business, nowMs = Date.now()): string | null {
  const agent = getAgentById(b.agentId);
  const current = agent?.price ? parsePaymentAmount(agent.price)?.wei ?? null : null;
  if (!agent || current === null || b.price.minWei === b.price.maxWei) return null;
  const since = new Date(nowMs - 7 * 86_400_000).toISOString();
  const jobs = getDb().prepare("SELECT status FROM business_jobs WHERE business_id = ? AND created_at > ?").all(b.businessId, since) as { status: string }[];
  const decidedJobs = jobs.filter((j) => j.status !== "bid");
  const won = decidedJobs.filter((j) => ["won", "done", "failed"].includes(j.status)).length;
  const budgetBelow = (getDb().prepare("SELECT COUNT(*) AS n FROM business_decisions WHERE business_id = ? AND kind = 'decline' AND reason LIKE 'The budget of %' AND created_at > ?").get(b.businessId, since) as { n: number }).n;
  const step = (current * BigInt(BUSINESS.priceStepBps)) / 10_000n;
  let to: bigint | null = null, why = "";
  if (decidedJobs.length >= BUSINESS.demandBids && won * 2 >= decidedJobs.length) {
    to = current + step > b.price.maxWei ? b.price.maxWei : current + step;
    why = `It won ${won} of its last ${decidedJobs.length} bids`;
  } else if ((decidedJobs.length >= BUSINESS.demandBids && won === 0) || (budgetBelow >= BUSINESS.demandBids && won * 2 < Math.max(1, decidedJobs.length))) {
    to = current - step < b.price.minWei ? b.price.minWei : current - step;
    why = won === 0 && decidedJobs.length >= BUSINESS.demandBids ? `It won none of its last ${decidedJobs.length} bids` : `${budgetBelow} jobs this week had a budget below its price`;
  }
  if (to === null || to === current) return null;
  updateAgent(b.agentId, { price: formatEth(to) });
  const reason = `${why}: price ${to > current ? "up" : "down"} from ${formatEth(current)} to ${formatEth(to)}`;
  decide(b.businessId, "price", reason, { subject: "price", detail: { from: formatEth(current), to: formatEth(to) }, nowMs });
  return reason;
}

/** The model it runs on now, as the ladder names it. */
const modelOf = (agentId: string): string => getAgentById(agentId)?.providerModel ?? "claude-sonnet-5";

function setModel(agentId: string, model: string | null): void {
  getDb().prepare("UPDATE agents SET provider_model = ? WHERE agent_id = ?").run(model, agentId);
}

/** One step up or down the model ladder, by the week's books. The reason, or null when it stays. */
export async function modelByBooks(b: Business, nowMs = Date.now(), price: () => Promise<number | null> = ethUsd): Promise<string | null> {
  const agent = getAgentById(b.agentId);
  if (!agent || !canLead(agent)) return null;
  const current = modelOf(b.agentId);
  const at = (MODEL_LADDER as readonly string[]).indexOf(current);
  if (at < 0) return null; // a model off the ladder is the owner's choice, left alone
  const week = entriesOf(b.businessId, { sinceDay: dayOf(nowMs - 6 * 86_400_000) });
  const earned = sumKinds(week, ["job", "sale"]);
  const spent = sumKinds(week, ["hire", "material", "model"]);
  const jobs = week.filter((e) => e.kind === "job" && !e.voided).length;
  const startAt = Math.max(0, (MODEL_LADDER as readonly string[]).indexOf(b.startModel ?? "claude-sonnet-5"));
  const event = (to: string, reason: string) => {
    setModel(b.agentId, to);
    record(b.businessId, { kind: "event", amountWei: 0n, ref: `model:${dayOf(nowMs)}`, note: `Model ${current} to ${to}`, atMs: nowMs });
    decide(b.businessId, "model", reason, { subject: "model", detail: { from: current, to }, nowMs });
    logger.info("business.model_step", "A business changed its model", { businessId: b.businessId, from: current, to });
    return reason;
  };
  // down first: a week that lost money steps back, never below where it began
  if (earned < spent && at > startAt) return event(MODEL_LADDER[at - 1], `The week cost more than it earned (${formatEth(spent)} against ${formatEth(earned)}): back to ${MODEL_LADDER[at - 1]}`);
  if (at + 1 >= MODEL_LADDER.length || jobs < BUSINESS.modelStepJobs) return null;
  if (!checkSpend(b, { kind: "model", wei: 0n }).ok) return null;
  const next = MODEL_LADDER[at + 1];
  // what one job's model calls would cost on the next model: this week's average, scaled by the price per token
  const jobModel = week.filter((e) => e.kind === "model" && e.ref.startsWith("job:") && !e.voided);
  const avgUsd = jobModel.length ? jobModel.reduce((n, e) => n + (e.costUsd ?? 0), 0) / jobModel.length : 0;
  const ratio = (estimateCostUsd(next, 1_000_000, 1_000_000) ?? 0) / Math.max(1e-9, estimateCostUsd(current, 1_000_000, 1_000_000) ?? 0);
  const usd = await price().catch(() => null);
  if (!usd) return null;
  const perJobWei = toWei((avgUsd * ratio) / usd) ?? 0n;
  const extraWeekWei = toWei((avgUsd * (ratio - 1) * jobs) / usd) ?? 0n;
  if (perJobWei > b.limits.maxPerJobWei) {
    decide(b.businessId, "model", `Stayed on ${current}: ${next} would cost about ${formatEth(perJobWei)} a job in model calls, above its limit for one job`, { subject: "model", once: `model-stay:${dayOf(nowMs)}`, nowMs });
    return null;
  }
  if (earned < BigInt(BUSINESS.modelStepCover) * (spent + extraWeekWei)) return null;
  return event(next, `It did ${jobs} jobs this week and earned ${formatEth(earned)} against ${formatEth(spent)} spent: moved up to ${next}`);
}

/** Back to the model it started on: when the business stops. */
export function restoreModel(b: Business): void {
  const agent = getAgentById(b.agentId);
  if (!agent || (agent.providerModel ?? null) === (b.startModel ?? null)) return;
  // only a model the business itself changed is put back; one the owner changed by hand is theirs
  if (!getDb().prepare("SELECT 1 FROM business_ledger WHERE business_id = ? AND kind = 'event' AND ref LIKE 'model:%'").get(b.businessId)) return;
  setModel(b.agentId, b.startModel);
  decide(b.businessId, "model", `Back on ${b.startModel ?? "its own model"}, where it started`, { subject: "model" });
}

/** The day's reinvestment: price, model, what it makes. Once per UTC day per business. */
export async function reinvest(b: Business, nowMs = Date.now(), price: () => Promise<number | null> = ethUsd): Promise<string[]> {
  const today = dayOf(nowMs);
  if (b.status !== "active" || b.lastReinvestDay === today) return [];
  const claimed = getDb().prepare("UPDATE businesses SET last_reinvest_day = ? WHERE business_id = ? AND (last_reinvest_day IS NULL OR last_reinvest_day != ?)").run(today, b.businessId, today).changes === 1;
  if (!claimed) return [];
  const done: string[] = [];
  try {
    const p = priceByDemand(b, nowMs);
    if (p) done.push(p);
    if (b.limits.kinds.includes("model")) {
      const m = await modelByBooks(getBusiness(b.businessId) ?? b, nowMs, price);
      if (m) done.push(m);
    }
    if (steerSelling(getBusiness(b.businessId) ?? b, nowMs)) done.push("steered what it makes");
  } catch (err) {
    logger.warn("business.reinvest_failed", "A business's daily reinvestment failed", { businessId: b.businessId, reason: err instanceof Error ? err.message : String(err) });
  }
  return done;
}

