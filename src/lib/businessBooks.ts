// Agents that run their own business: its P&L, its daily report, and what each reader may see.
//
// The P&L is read from the ledger and nothing else: per UTC day and in total, what it earned (jobs and sales), what it
// spent (hires, material, and model costs), and the difference, under the column "profit".
//
// The daily report is written by the agent in plain words about one finished UTC day, from that day's figures only.
// The figures go to the model as they are; what comes back is read sentence by sentence, and any sentence with a number
// that is not one of those figures is thrown out, as is any sentence that promises what is to come. With nothing left,
// the report is the figures in plain sentences, written here. The report keeps the figures it was written from.
//
// Two readers. The owner's dashboard shows everything. The agent's public page shows what is safe for anyone: that it
// runs a business, its goal, since when, how many jobs it did and how many products it sold, with the receipts of the
// jobs (which are public anyway). Never an amount, a limit, a reason it declined something, or the decision log.

import { getDb } from "./db";
import { logger } from "./logger";
import { getAgentById } from "./agents";
import { formatEth, weiToDecimalString } from "./money";
import { getAvailableBalanceWei } from "./payments";
import { claudeModel } from "./providers";
import { captureModelStep } from "./modelUsage";
import { estimateCostUsd } from "./traceEvents";
import { listApprovals, BUSINESS_APP } from "./appPermissions";
import { BUSINESS, SPEND_WORDS, businessCaps, type BusinessCaps } from "./businessPolicy";
import { dayOf, decide, decisionsOf, latestBusinessOfAgent, type Business, type Decision } from "./business";
import { entriesOf, type LedgerEntry } from "./businessLedger";
import { roomLeft } from "./businessLimits";
import { recordModelCost } from "./businessWork";

// ── The P&L ──────────────────────────────────────────────────────────────────

export interface PnlDay { day: string; earned: bigint; jobs: bigint; sales: bigint; hires: bigint; material: bigint; model: bigint; spent: bigint; profit: bigint }

const zero = (day: string): PnlDay => ({ day, earned: 0n, jobs: 0n, sales: 0n, hires: 0n, material: 0n, model: 0n, spent: 0n, profit: 0n });

function add(d: PnlDay, e: LedgerEntry): void {
  if (e.voided || e.kind === "event") return;
  if (e.kind === "job") d.jobs += e.amountWei;
  else if (e.kind === "sale") d.sales += e.amountWei;
  else if (e.kind === "hire") d.hires += e.amountWei;
  else if (e.kind === "material") d.material += e.amountWei;
  else if (e.kind === "model") d.model += e.amountWei;
  d.earned = d.jobs + d.sales;
  d.spent = d.hires + d.material + d.model;
  d.profit = d.earned - d.spent;
}

/** Every day from the start (the last BUSINESS.shownDays of them), oldest first, and the total. */
export function pnl(b: Business, nowMs = Date.now()): { days: PnlDay[]; total: PnlDay; modelUsd: number } {
  const first = Math.max(Date.parse(b.createdAt), nowMs - (BUSINESS.shownDays - 1) * 86_400_000);
  const last = b.stoppedAt ? Math.min(nowMs, Date.parse(b.stoppedAt)) : nowMs;
  const days = new Map<string, PnlDay>();
  for (let t = Date.parse(`${dayOf(first)}T00:00:00Z`); t <= last; t += 86_400_000) days.set(dayOf(t), zero(dayOf(t)));
  const total = zero("total");
  let modelUsd = 0;
  for (const e of entriesOf(b.businessId, { limit: 20_000 })) {
    add(total, e);
    if (!e.voided && e.kind === "model") modelUsd += e.costUsd ?? 0;
    const d = days.get(e.day);
    if (d) add(d, e);
  }
  return { days: [...days.values()], total, modelUsd: Math.round(modelUsd * 10_000) / 10_000 };
}

// ── The daily report ─────────────────────────────────────────────────────────

export interface DayFigures {
  day: string;
  earned: string; fromJobs: string; fromSales: string;
  spent: string; onHires: string; onMaterial: string; onModel: string;
  profit: string;
  jobsDone: number; productsSold: number; bids: number; declined: number; hires: number;
}

/** One day's figures, as the report may use them: amounts in ETH as written, counts as whole numbers. */
export function dayFigures(b: Business, day: string): DayFigures {
  const d = zero(day);
  const entries = entriesOf(b.businessId, { sinceDay: day, limit: 20_000 }).filter((e) => e.day === day);
  for (const e of entries) add(d, e);
  const count = (kind: string) => (getDb().prepare("SELECT COUNT(*) AS n FROM business_decisions WHERE business_id = ? AND kind = ? AND substr(created_at, 1, 10) = ?").get(b.businessId, kind, day) as { n: number }).n;
  const amt = (w: bigint) => (w < 0n ? `-${weiToDecimalString(-w)}` : weiToDecimalString(w));
  return {
    day, earned: amt(d.earned), fromJobs: amt(d.jobs), fromSales: amt(d.sales), spent: amt(d.spent), onHires: amt(d.hires), onMaterial: amt(d.material), onModel: amt(d.model), profit: amt(d.profit),
    jobsDone: entries.filter((e) => e.kind === "job" && !e.voided).length,
    productsSold: entries.filter((e) => e.kind === "sale" && !e.voided).length,
    bids: count("take"), declined: count("decline"), hires: entries.filter((e) => e.kind === "hire" && !e.voided).length,
  };
}

const PROMISES = /\b(guarantee\w*|passive income|returns?|will (?:earn|make|grow|double)|profit(?:s|able)? (?:ahead|to come)|going to (?:earn|make))\b/i;

/** The numbers a report may contain: the figures, in the forms people write them. */
function allowedNumbers(f: DayFigures): Set<string> {
  const out = new Set<string>();
  const put = (s: string) => {
    const n = s.replace(/^-/, "");
    out.add(n);
    if (n.includes(".")) out.add(n.replace(/0+$/, "").replace(/\.$/, ""));
  };
  for (const v of Object.values(f)) if (typeof v === "string" && /^-?\d/.test(v)) put(v); else if (typeof v === "number") put(String(v));
  return out;
}

/** Numbers written as words, which a model uses for counts: each read as its figure. "Twenty-one" reads as 20 and 1. */
const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1000", dozen: "12", twice: "2",
};
const wordNumbers = (s: string): string[] => (s.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w in NUMBER_WORDS).map((w) => NUMBER_WORDS[w]);

/** Keep the sentences whose every number is a figure, digits or words, and that promise nothing. */
export function guardReport(text: string, f: DayFigures): { text: string; dropped: number } {
  const allowed = allowedNumbers(f);
  // a sentence ends at a full stop, a question or an exclamation mark followed by a space: never inside 0.0029
  const sentences = text.replace(/[—–]/g, ",").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let dropped = 0;
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const nums = [...(s.match(/\d+(?:[.,]\d+)*/g) ?? []), ...wordNumbers(s)];
    const ok = nums.every((n) => allowed.has(n.replace(/,/g, ""))) && !PROMISES.test(s);
    if (ok) kept.push(s); else dropped++;
  }
  return { text: kept.join(" ").trim(), dropped };
}

/** The figures in plain sentences: the report when the model's has nothing left, or is not there. */
export function plainReport(f: DayFigures, agentName: string): string {
  const parts = [
    f.jobsDone || f.productsSold ? `${agentName} did ${f.jobsDone} ${f.jobsDone === 1 ? "job" : "jobs"} and sold ${f.productsSold} ${f.productsSold === 1 ? "product" : "products"}.` : `${agentName} did no paid work and sold nothing.`,
    `It bid on ${f.bids} ${f.bids === 1 ? "job" : "jobs"} and declined ${f.declined}.`,
    `It earned ${f.earned} ETH and spent ${f.spent} ETH, ${f.onModel} ETH of it on model costs. Earned less spent: ${f.profit} ETH.`,
  ];
  return parts.join(" ");
}

const REPORT_SYSTEM =
  "You are an AI agent that runs a small business on Axon. Write your owner a short report about one day, in the first person, in plain " +
  "words: three to five sentences. Use only the figures you are given, written exactly as given in digits (amounts are in ETH). Do not mention " +
  "dates or any other number. Do not predict or promise anything. No lists, no headings, no dashes.";

/** What each figure means, so the model cannot read "declined" as posters turning it down. */
const FIGURE_WORDS: Record<string, string> = {
  earned: "ETH earned in all", fromJobs: "ETH earned from jobs", fromSales: "ETH earned from shop sales",
  spent: "ETH spent in all", onHires: "ETH spent hiring other agents", onMaterial: "ETH spent on material", onModel: "ETH of model costs",
  profit: "earned less spent, in ETH", jobsDone: "paid jobs it finished", productsSold: "products it sold",
  bids: "jobs it chose to bid on", declined: "open jobs it looked at and chose not to bid on, by its own rules (not bids that were turned down)",
  hires: "other agents it hired",
};

export function reportPrompt(goal: string, f: DayFigures): string {
  const lines = Object.entries(f).filter(([k]) => k !== "day").map(([k, v]) => `${k}: ${v} (${FIGURE_WORDS[k] ?? k})`);
  return `Your business: ${goal}\n\nThe day's figures, each with what it means:\n${lines.join("\n")}`;
}

export type Writer = (system: string, prompt: string, caps: BusinessCaps) => Promise<{ text: string; costUsd: number | null; model: string }>;

export const realWriter: Writer = async (system, prompt, caps) => {
  const step = await captureModelStep(() => claudeModel(caps.reportModel).complete(system, prompt, 400, 0.3));
  return { text: step.result, costUsd: estimateCostUsd(step.model ?? caps.reportModel, step.inputTokens, step.outputTokens), model: step.model ?? caps.reportModel };
};

export interface Report { day: string; text: string; figures: DayFigures; dropped: number; model: string | null; createdAt: string }

/** Write the report for one finished day, once. Null when it was written already or the day is not over. */
export async function writeReport(b: Business, day: string, nowMs = Date.now(), writer: Writer = realWriter, caps: BusinessCaps = businessCaps(), price?: () => Promise<number | null>): Promise<Report | null> {
  if (day >= dayOf(nowMs) || day < b.createdAt.slice(0, 10)) return null;
  const db = getDb();
  if (db.prepare("SELECT 1 FROM business_reports WHERE business_id = ? AND day = ?").get(b.businessId, day)) return null;
  const f = dayFigures(b, day);
  const name = getAgentById(b.agentId)?.name ?? "The agent";
  let text = "", dropped = 0, model: string | null = null;
  try {
    const w = await writer(REPORT_SYSTEM, reportPrompt(b.goal, f), caps);
    model = w.model;
    await recordModelCost(b.businessId, `report:${day}`, w.costUsd, `Wrote the report for ${day}`, { price });
    const g = guardReport(w.text, f);
    text = g.text;
    dropped = g.dropped;
  } catch (err) {
    logger.warn("business.report_failed", "A business's daily report could not be written by the model", { businessId: b.businessId, day, reason: err instanceof Error ? err.message : String(err) });
  }
  if (text.length < 20) text = plainReport(f, name);
  const at = new Date(nowMs).toISOString();
  const r = db.prepare("INSERT INTO business_reports (business_id, day, text, numbers, dropped, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(b.businessId, day, text, JSON.stringify(f), dropped, model, at);
  if (r.changes !== 1) return null;
  decide(b.businessId, "report", `Wrote the report for ${day}${dropped ? `; ${dropped} ${dropped === 1 ? "sentence was" : "sentences were"} left out for a number not in the books` : ""}`, { subject: day, once: `report:${day}`, nowMs });
  return { day, text, figures: f, dropped, model, createdAt: at };
}

export function reportsOf(businessId: string, limit = 14): Report[] {
  return (getDb().prepare("SELECT * FROM business_reports WHERE business_id = ? ORDER BY day DESC LIMIT ?").all(businessId, limit) as Record<string, unknown>[]).map((r) => ({
    day: String(r.day), text: String(r.text), figures: JSON.parse(String(r.numbers)) as DayFigures, dropped: Number(r.dropped), model: r.model ? String(r.model) : null, createdAt: String(r.created_at),
  }));
}

// ── What each reader sees ────────────────────────────────────────────────────

const eth = (w: bigint): string => (w < 0n ? `-${formatEth(-w)}` : formatEth(w));
const dayView = (d: PnlDay) => ({ day: d.day, earned: eth(d.earned), fromJobs: eth(d.jobs), fromSales: eth(d.sales), spent: eth(d.spent), onHires: eth(d.hires), onMaterial: eth(d.material), onModel: eth(d.model), profit: eth(d.profit), earnedWei: d.earned.toString(), spentWei: d.spent.toString(), profitWei: d.profit.toString() });

const counts = (businessId: string) => {
  const by = (status: string) => (getDb().prepare("SELECT COUNT(*) AS n FROM business_jobs WHERE business_id = ? AND status = ?").get(businessId, status) as { n: number }).n;
  const sold = (getDb().prepare("SELECT COUNT(*) AS n FROM business_ledger WHERE business_id = ? AND kind = 'sale' AND voided_at IS NULL").get(businessId) as { n: number }).n;
  return { bids: by("bid") + by("won") + by("lost") + by("done") + by("failed"), won: by("won") + by("done") + by("failed"), jobsDone: by("done"), productsSold: sold };
};

/** Everything, for the owner. */
export function ownerView(b: Business, nowMs = Date.now()) {
  const books = pnl(b, nowMs);
  const room = roomLeft(b, nowMs);
  const waiting = listApprovals(b.ownerWallet, nowMs).pending.filter((a) => a.appId === BUSINESS_APP && a.agentId === b.agentId);
  const agent = getAgentById(b.agentId);
  let available = 0n;
  try { available = getAvailableBalanceWei(b.agentId); } catch { /* before the payments tables */ }
  return {
    businessId: b.businessId,
    agent: { agentId: b.agentId, name: agent?.name ?? b.agentId, price: agent?.price ?? null, model: agent?.providerModel ?? null },
    goal: b.goal,
    status: b.status,
    pausedReason: b.pausedReason,
    since: b.createdAt,
    stoppedAt: b.stoppedAt,
    limits: {
      budget: formatEth(b.limits.budgetWei), maxPerDay: formatEth(b.limits.maxPerDayWei), maxPerJob: formatEth(b.limits.maxPerJobWei), approveAbove: formatEth(b.limits.approveAboveWei),
      spendOn: b.limits.kinds.map((k) => ({ kind: k, words: SPEND_WORDS[k] })), allowanceKey: b.limits.allowanceKeyId ? `${b.limits.allowanceKeyId.slice(0, 8)}…` : null,
      priceMin: formatEth(b.price.minWei), priceMax: formatEth(b.price.maxWei), bidsPerHour: b.bidsPerHour,
      left: { budget: formatEth(room.budget), today: formatEth(room.today) },
    },
    selling: { on: b.sell.on, price: b.sell.priceWei !== null ? formatEth(b.sell.priceWei) : null, makes: b.sell.kind },
    counts: counts(b.businessId),
    pnl: { days: books.days.map(dayView), total: dayView(books.total), modelUsd: books.modelUsd },
    earningsToWithdraw: formatEth(available > 0n ? available : 0n),
    decisions: decisionsOf(b.businessId),
    ledger: entriesOf(b.businessId, { limit: 50 }).map((e) => ({ day: e.day, at: e.createdAt, direction: e.direction, kind: e.kind, amount: e.kind === "event" ? null : eth(e.amountWei), costUsd: e.costUsd, ref: e.ref, receipt: e.ref.startsWith("pt_") ? "/dashboard#people" : e.kind === "job" || e.kind === "hire" || e.kind === "sale" || e.kind === "material" ? `/r/${e.ref}` : null, note: e.note, voided: e.voided })),
    reports: reportsOf(b.businessId),
    waiting: waiting.map((a) => ({ approvalId: a.approvalId, title: a.title, preview: a.preview, expiresAt: a.expiresAt, receiptUrl: a.receiptUrl })),
    nextLookAt: b.status === "active" ? b.nextScanAt : null,
    lastLookAt: b.lastScanAt,
  };
}

/** What anyone may see on the agent's page: no amounts, no limits, no reasons. Null when it never ran a business. */
export function publicView(agentId: string) {
  const b = latestBusinessOfAgent(agentId);
  if (!b) return null;
  const c = counts(b.businessId);
  const recent = (getDb().prepare("SELECT task_id, updated_at FROM business_jobs WHERE business_id = ? AND status = 'done' AND task_id IS NOT NULL ORDER BY updated_at DESC LIMIT 5").all(b.businessId) as { task_id: string; updated_at: string }[])
    .map((r) => ({ receipt: `/r/${r.task_id}`, at: r.updated_at }));
  return { goal: b.goal, status: b.status === "active" ? "running" : b.status, since: b.createdAt, jobsDone: c.jobsDone, productsSold: c.productsSold, recentJobs: recent };
}

export type OwnerView = ReturnType<typeof ownerView>;
export type PublicView = NonNullable<ReturnType<typeof publicView>>;
export type { Decision };
