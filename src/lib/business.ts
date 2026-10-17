// Agents that run their own business: the store, and starting, pausing and stopping one.
//
// An owner picks one of their agents and gives it a goal in a sentence ("run a logo studio"), a budget, and limits: the
// most it may spend in a day and on one job, the amount above which a spend waits for their OK, and what it may spend
// on at all (hiring other agents, buying other agents' products, a stronger model). They also give it a price range;
// it moves its own price inside it by demand. From then on the worker looks after it (./businessRun).
//
// Where the money comes from is what already exists: the agent's own earnings (its balance, which every paid job and
// sale adds to), and, when the owner picks one, the owner's allowance key, which pays a hire through the allowance
// contract exactly as it pays one for Claude or Cursor, within that key's own limits. There is no new custody: this
// store never holds or moves money.
//
// What holds it:
//
//   Only the agent's owner, and only an agent whose owner has signed in with their wallet (a verified owner). An agent
//   that changes hands pauses its business: the new owner starts one of their own.
//
//   One open business per agent, and a few per wallet (businessCaps().perWallet).
//
//   Every limit is checked in one place before anything is spent (./businessLimits).
//
// Every change an owner makes, and every decision the business makes, is a line in its decision log.

import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { getAgentById, updateAgent } from "./agents";
import { sameAddress } from "./address";
import { isOwnerVerified } from "./ownerVerification";
import { validateAgentText } from "./agentContent";
import { decimalToWei, formatEth, parsePaymentAmount } from "./money";
import { listAllowanceKeys } from "./allowanceKeys";
import { BUSINESS, businessCaps, businessEnabled, isSpendKind, type BusinessCaps, type SpendKind } from "./businessPolicy";

export type BusinessStatus = "active" | "paused" | "stopped";

export interface BusinessLimits {
  budgetWei: bigint;
  maxPerDayWei: bigint;
  maxPerJobWei: bigint;
  approveAboveWei: bigint;
  kinds: SpendKind[];
  allowanceKeyId: string | null;
}

export interface Business {
  businessId: string;
  agentId: string;
  ownerWallet: string;
  goal: string;
  status: BusinessStatus;
  pausedReason: string | null;
  limits: BusinessLimits;
  price: { minWei: bigint; maxWei: bigint };
  bidsPerHour: number;
  sell: { on: boolean; priceWei: bigint | null; kind: string | null };
  startModel: string | null;
  nextScanAt: string | null;
  lastScanAt: string | null;
  lastReinvestDay: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
}

type Row = Record<string, unknown>;
const big = (v: unknown): bigint => (v !== null && v !== undefined && /^\d+$/.test(String(v)) ? BigInt(String(v)) : 0n);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const toBusiness = (r: Row): Business => ({
  businessId: String(r.business_id),
  agentId: String(r.agent_id),
  ownerWallet: String(r.owner_wallet),
  goal: String(r.goal),
  status: (["active", "paused", "stopped"].includes(String(r.status)) ? r.status : "paused") as BusinessStatus,
  pausedReason: str(r.paused_reason),
  limits: {
    budgetWei: big(r.budget_wei),
    maxPerDayWei: big(r.max_per_day_wei),
    maxPerJobWei: big(r.max_per_job_wei),
    approveAboveWei: big(r.approve_above_wei),
    kinds: String(r.spend_kinds ?? "").split(",").map((s) => s.trim()).filter(isSpendKind),
    allowanceKeyId: str(r.allowance_key_id),
  },
  price: { minWei: big(r.price_min_wei), maxWei: big(r.price_max_wei) },
  bidsPerHour: Number(r.bids_per_hour ?? 3),
  sell: { on: Number(r.sell_on) === 1, priceWei: r.sell_price_wei === null || r.sell_price_wei === undefined ? null : big(r.sell_price_wei), kind: str(r.sell_kind) },
  startModel: str(r.start_model),
  nextScanAt: str(r.next_scan_at),
  lastScanAt: str(r.last_scan_at),
  lastReinvestDay: str(r.last_reinvest_day),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  stoppedAt: str(r.stopped_at),
});

export const now = (): string => new Date().toISOString();
/** The UTC day a moment falls on, as YYYY-MM-DD. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const newId = (): string => `biz_${randomBytes(12).toString("base64url")}`;

export function getBusiness(businessId: string): Business | null {
  const r = getDb().prepare("SELECT * FROM businesses WHERE business_id = ?").get(businessId) as Row | undefined;
  return r ? toBusiness(r) : null;
}

/** The agent's business that is running or paused, if it has one. */
export function businessOfAgent(agentId: string): Business | null {
  const r = getDb().prepare("SELECT * FROM businesses WHERE agent_id = ? AND status != 'stopped' ORDER BY created_at DESC LIMIT 1").get(agentId) as Row | undefined;
  return r ? toBusiness(r) : null;
}

/** The agent's latest business, stopped ones included: what its page shows. */
export function latestBusinessOfAgent(agentId: string): Business | null {
  const r = getDb().prepare("SELECT * FROM businesses WHERE agent_id = ? ORDER BY (status = 'stopped') ASC, created_at DESC LIMIT 1").get(agentId) as Row | undefined;
  return r ? toBusiness(r) : null;
}

export function businessesOf(wallet: string, limit = 20): Business[] {
  return (getDb().prepare("SELECT * FROM businesses WHERE owner_wallet = ? ORDER BY (status = 'stopped') ASC, created_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as Row[]).map(toBusiness);
}

/** Running businesses whose next look at the network is due. */
export function dueBusinesses(nowMs = Date.now(), limit = 20): Business[] {
  return (getDb().prepare("SELECT * FROM businesses WHERE status = 'active' AND (next_scan_at IS NULL OR next_scan_at <= ?) ORDER BY next_scan_at LIMIT ?").all(new Date(nowMs).toISOString(), limit) as Row[]).map(toBusiness);
}

/** Every business that is not stopped: the worker settles their books even while one is paused. */
export function openBusinesses(limit = 200): Business[] {
  return (getDb().prepare("SELECT * FROM businesses WHERE status != 'stopped' ORDER BY created_at LIMIT ?").all(limit) as Row[]).map(toBusiness);
}

// ── The decision log ─────────────────────────────────────────────────────────

export type DecisionKind =
  | "start" | "change" | "pause" | "resume" | "stop"
  | "take" | "decline" | "cap" | "won" | "lost" | "done" | "failed"
  | "hire" | "refuse" | "ask" | "approved" | "declined"
  | "price" | "model" | "make" | "material" | "report";

export interface Decision { decisionId: string; kind: DecisionKind; subject: string | null; reason: string; detail: Record<string, unknown> | null; createdAt: string }

/**
 * Write a decision with its reason. With `once`, a decision about the same thing is written only the first time, and
 * the answer says whether this one was new.
 */
export function decide(businessId: string, kind: DecisionKind, reason: string, o: { subject?: string | null; detail?: Record<string, unknown>; once?: string; nowMs?: number } = {}): boolean {
  const r = getDb().prepare(
    "INSERT INTO business_decisions (decision_id, business_id, kind, subject, reason, detail, once_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(`dec_${randomUUID().replace(/-/g, "").slice(0, 20)}`, businessId, kind, o.subject ?? null, reason.slice(0, 500), o.detail ? JSON.stringify(o.detail) : null, o.once ?? null, new Date(o.nowMs ?? Date.now()).toISOString());
  return r.changes === 1;
}

export function decisionsOf(businessId: string, limit: number = BUSINESS.shownDecisions): Decision[] {
  return (getDb().prepare("SELECT * FROM business_decisions WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(businessId, limit) as Row[]).map((r) => ({
    decisionId: String(r.decision_id), kind: String(r.kind) as DecisionKind, subject: str(r.subject), reason: String(r.reason),
    detail: r.detail ? (JSON.parse(String(r.detail)) as Record<string, unknown>) : null, createdAt: String(r.created_at),
  }));
}

// ── Starting one ─────────────────────────────────────────────────────────────

export interface StartInput {
  agentId: unknown;
  goal: unknown;
  /** ETH amounts, as written: "0.01" */
  budgetEth: unknown;
  maxPerDayEth: unknown;
  maxPerJobEth: unknown;
  approveAboveEth: unknown;
  spendOn?: unknown;
  allowanceKeyId?: unknown;
  priceMinEth: unknown;
  priceMaxEth: unknown;
  bidsPerHour?: unknown;
  sell?: { on?: unknown; priceEth?: unknown } | null;
}

export type Started = { ok: true; business: Business } | { ok: false; why: string };

/** An ETH amount as written by a person, as wei; zero only where allowed. */
function eth(raw: unknown, what: string, o: { zero?: boolean } = {}): { ok: true; wei: bigint } | { ok: false; why: string } {
  const s = typeof raw === "number" ? String(raw) : String(raw ?? "").trim().replace(/\s*ETH$/i, "");
  const wei = s && /^\d+(\.\d+)?$/.test(s) ? decimalToWei(s) : null;
  if (wei === null || (wei === 0n && !o.zero)) return { ok: false, why: `${what} must be an amount in ETH, like 0.002.` };
  return { ok: true, wei };
}

/** Where a price may be set: what Studio allows an agent's price to be. */
const PRICE_FLOOR = decimalToWei("0.00001") as bigint;
const PRICE_CEILING = decimalToWei("1") as bigint;

export interface ReadLimits { limits: Omit<BusinessLimits, "allowanceKeyId">; price: { minWei: bigint; maxWei: bigint }; bidsPerHour: number }

/** The owner's limits, read and checked. Shared by starting and by changing them. */
export function readLimits(input: Pick<StartInput, "budgetEth" | "maxPerDayEth" | "maxPerJobEth" | "approveAboveEth" | "spendOn" | "priceMinEth" | "priceMaxEth" | "bidsPerHour">, caps: BusinessCaps = businessCaps()): { ok: true; value: ReadLimits } | { ok: false; why: string } {
  const budget = eth(input.budgetEth, "The budget");
  if (!budget.ok) return budget;
  const budgetMax = decimalToWei(String(caps.budgetMaxEth)) as bigint;
  if (budget.wei > budgetMax) return { ok: false, why: `The budget can be at most ${formatEth(budgetMax)}.` };
  const perDay = eth(input.maxPerDayEth, "The most a day");
  if (!perDay.ok) return perDay;
  const perJob = eth(input.maxPerJobEth, "The most on one job");
  if (!perJob.ok) return perJob;
  const ask = eth(input.approveAboveEth, "The amount that needs your OK", { zero: true });
  if (!ask.ok) return ask;
  if (perDay.wei > budget.wei) return { ok: false, why: "The most a day cannot be above the budget." };
  if (perJob.wei > perDay.wei) return { ok: false, why: "The most on one job cannot be above the most a day." };
  if (ask.wei > perJob.wei) return { ok: false, why: "The amount that needs your OK cannot be above the most on one job." };
  const kindsRaw = input.spendOn === undefined ? [] : input.spendOn;
  if (!Array.isArray(kindsRaw) || !kindsRaw.every(isSpendKind)) return { ok: false, why: "What it may spend on is a list of: hire, material, model." };
  const kinds = [...new Set(kindsRaw as SpendKind[])];
  const min = eth(input.priceMinEth, "The lowest price");
  if (!min.ok) return min;
  const max = eth(input.priceMaxEth, "The highest price");
  if (!max.ok) return max;
  if (min.wei < PRICE_FLOOR || max.wei > PRICE_CEILING) return { ok: false, why: `Its price can be from ${formatEth(PRICE_FLOOR)} to ${formatEth(PRICE_CEILING)} a job.` };
  if (min.wei > max.wei) return { ok: false, why: "The lowest price cannot be above the highest." };
  const bph = input.bidsPerHour === undefined ? Math.min(3, caps.bidsPerHourMax) : Number(input.bidsPerHour);
  if (!Number.isInteger(bph) || bph < 1 || bph > caps.bidsPerHourMax) return { ok: false, why: `It can bid on 1 to ${caps.bidsPerHourMax} jobs an hour.` };
  return { ok: true, value: { limits: { budgetWei: budget.wei, maxPerDayWei: perDay.wei, maxPerJobWei: perJob.wei, approveAboveWei: ask.wei, kinds }, price: { minWei: min.wei, maxWei: max.wei }, bidsPerHour: bph } };
}

/** Why this wallet may not run a business with this agent, or null. */
export function mayRun(agentId: string, wallet: string): string | null {
  const agent = getAgentById(agentId);
  if (!agent) return "There is no such agent.";
  if (!agent.walletAddress || !sameAddress(agent.walletAddress, wallet)) return "Only the agent's owner can do that.";
  if (!isOwnerVerified(agentId)) return "The agent's owner has to sign in with their wallet first.";
  return null;
}

/** Hooks a business uses on the shop and on the agent itself; swappable in tests. */
export interface StartHooks {
  /** switch the shop's own making on or off for the agent, steered by the business */
  setSelling?: (b: Business, on: boolean) => string | null;
  /** let the agent buy material in its jobs, or stop it */
  setBuying?: (b: Business, on: boolean) => string | null;
}

export function startBusiness(wallet: string, input: StartInput, hooks: StartHooks = {}, caps: BusinessCaps = businessCaps()): Started {
  if (!businessEnabled()) return { ok: false, why: "Businesses are not open on this network." };
  const agentId = String(input.agentId ?? "").trim();
  const owner = wallet.toLowerCase();
  const refused = mayRun(agentId, owner);
  if (refused) return { ok: false, why: refused };
  const goal = String(input.goal ?? "").replace(/\s+/g, " ").trim();
  if (goal.length < BUSINESS.goalMinChars) return { ok: false, why: "Say in a sentence what business it should run." };
  if (goal.length > BUSINESS.goalChars) return { ok: false, why: `Keep the goal under ${BUSINESS.goalChars} characters.` };
  const bad = validateAgentText(goal);
  if (bad) return { ok: false, why: bad };
  const read = readLimits(input, caps);
  if (!read.ok) return read;
  let keyId: string | null = null;
  if (input.allowanceKeyId !== undefined && input.allowanceKeyId !== null && input.allowanceKeyId !== "") {
    keyId = String(input.allowanceKeyId);
    if (!listAllowanceKeys(owner).some((k) => k.keyId === keyId)) return { ok: false, why: "That allowance key is not one of yours." };
  }
  let sellPriceWei: bigint | null = null;
  const sellOn = input.sell?.on === true;
  if (sellOn) {
    const p = eth(input.sell?.priceEth, "The price of what it sells");
    if (!p.ok) return p;
    sellPriceWei = p.wei;
  }
  const db = getDb();
  if (businessOfAgent(agentId)) return { ok: false, why: "This agent already runs a business. Stop it first to start another." };
  const open = (db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE owner_wallet = ? AND status != 'stopped'").get(owner) as { n: number }).n;
  if (open >= caps.perWallet) return { ok: false, why: `You can run ${caps.perWallet} businesses at once.` };

  const agent = getAgentById(agentId)!;
  const id = newId(), at = now();
  const { limits, price, bidsPerHour } = read.value;
  try {
    db.prepare(
      `INSERT INTO businesses (business_id, agent_id, owner_wallet, goal, status, budget_wei, max_per_day_wei, max_per_job_wei, approve_above_wei, spend_kinds,
         allowance_key_id, price_min_wei, price_max_wei, bids_per_hour, sell_on, sell_price_wei, start_model, next_scan_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, agentId, owner, goal, limits.budgetWei.toString(), limits.maxPerDayWei.toString(), limits.maxPerJobWei.toString(), limits.approveAboveWei.toString(),
      limits.kinds.join(","), keyId, price.minWei.toString(), price.maxWei.toString(), bidsPerHour, sellOn ? 1 : 0, sellPriceWei?.toString() ?? null, agent.providerModel ?? null, at, at, at);
  } catch (err) {
    if (String(err).includes("UNIQUE")) return { ok: false, why: "This agent already runs a business. Stop it first to start another." };
    throw err;
  }
  decide(id, "start", `Started with the goal: ${goal}`, { detail: { budget: formatEth(limits.budgetWei), perDay: formatEth(limits.maxPerDayWei), perJob: formatEth(limits.maxPerJobWei), askAbove: formatEth(limits.approveAboveWei), spendOn: limits.kinds } });

  priceIntoRange(id, agentId, price);
  const b = getBusiness(id)!;
  applyShop(b, true, hooks);
  void syncToTurso();
  logger.info("business.started", "An agent started running its own business", { businessId: id, agentId });
  return { ok: true, business: getBusiness(id)! };
}

/** Switch the shop's making and buying on or off as the business says, and log what the shop said back. */
function applyShop(b: Business, on: boolean, hooks: StartHooks): void {
  if (b.sell.on && hooks.setSelling) {
    const why = hooks.setSelling(b, on);
    if (why) decide(b.businessId, "make", `The shop did not ${on ? "start" : "stop"} making: ${why}`, { subject: "shop", once: `make-${on}-${why}` });
  }
  if (b.limits.kinds.includes("material") && hooks.setBuying) {
    const why = hooks.setBuying(b, on);
    if (why) decide(b.businessId, "material", `Buying material did not ${on ? "start" : "stop"}: ${why}`, { subject: "shop", once: `buy-${on}-${why}` });
  }
}

// ── Pause, resume, stop, change ──────────────────────────────────────────────

type Owned = { ok: true; business: Business } | { ok: false; why: string; status?: number };

function owned(businessId: string, wallet: string): Owned {
  const b = getBusiness(businessId);
  if (!b || !sameAddress(b.ownerWallet, wallet)) return { ok: false, why: "There is no such business of yours.", status: 404 };
  return { ok: true, business: b };
}

export function pauseBusiness(businessId: string, wallet: string, hooks: StartHooks = {}, reason?: string): Owned {
  const o = owned(businessId, wallet);
  if (!o.ok) return o;
  if (o.business.status !== "active") return { ok: false, why: o.business.status === "paused" ? "It is paused already." : "It has stopped." };
  return { ok: true, business: setStatus(o.business, "paused", reason ?? "You paused it", hooks) };
}

export function resumeBusiness(businessId: string, wallet: string, hooks: StartHooks = {}): Owned {
  const o = owned(businessId, wallet);
  if (!o.ok) return o;
  if (o.business.status !== "paused") return { ok: false, why: o.business.status === "active" ? "It is running already." : "It has stopped. Start a new one." };
  const refused = mayRun(o.business.agentId, wallet);
  if (refused) return { ok: false, why: refused };
  return { ok: true, business: setStatus(o.business, "active", "You resumed it", hooks) };
}

/** Stop for good. What it earned stays with the agent, to withdraw the usual way; the books stay readable. */
export function stopBusiness(businessId: string, wallet: string, hooks: StartHooks & { restoreModel?: (b: Business) => void; cancelAsks?: (b: Business) => void } = {}): Owned {
  const o = owned(businessId, wallet);
  if (!o.ok) return o;
  if (o.business.status === "stopped") return { ok: false, why: "It has stopped already." };
  const b = setStatus(o.business, "stopped", "You stopped it", hooks);
  hooks.restoreModel?.(b);
  hooks.cancelAsks?.(b);
  return { ok: true, business: b };
}

/** The business pauses itself (its agent changed hands, or its owner is no longer verified). */
export function pauseItself(b: Business, reason: string, hooks: StartHooks = {}): Business {
  return setStatus(b, "paused", reason, hooks);
}

function setStatus(b: Business, status: BusinessStatus, reason: string, hooks: StartHooks): Business {
  const at = now();
  getDb().prepare("UPDATE businesses SET status = ?, paused_reason = ?, next_scan_at = ?, updated_at = ?, stopped_at = ? WHERE business_id = ?")
    .run(status, status === "paused" ? reason : null, status === "active" ? at : null, at, status === "stopped" ? at : null, b.businessId);
  decide(b.businessId, status === "active" ? "resume" : status === "paused" ? "pause" : "stop", reason);
  applyShop(b, status === "active", hooks);
  void syncToTurso();
  logger.info(`business.${status === "active" ? "resumed" : status}`, "A business changed state", { businessId: b.businessId, status, reason });
  return getBusiness(b.businessId)!;
}

/** Its price inside the owner's range: an agent priced outside it is moved to the nearest end, with a line in the log. */
function priceIntoRange(businessId: string, agentId: string, range: { minWei: bigint; maxWei: bigint }): void {
  const agent = getAgentById(agentId);
  if (!agent) return;
  const current = agent.price ? parsePaymentAmount(agent.price)?.wei ?? null : null;
  const into = current === null || current < range.minWei ? range.minWei : current > range.maxWei ? range.maxWei : null;
  if (into === null) return;
  updateAgent(agentId, { price: formatEth(into) });
  decide(businessId, "price", `Set its price to ${formatEth(into)}, inside the range you gave`, { subject: "price", detail: { from: agent.price ?? null, to: formatEth(into) } });
}

/** The owner changes the limits, the price range or how often it bids. The goal stays: a new goal is a new business. */
export function changeLimits(businessId: string, wallet: string, input: Pick<StartInput, "budgetEth" | "maxPerDayEth" | "maxPerJobEth" | "approveAboveEth" | "spendOn" | "priceMinEth" | "priceMaxEth" | "bidsPerHour">, caps: BusinessCaps = businessCaps()): Owned {
  const o = owned(businessId, wallet);
  if (!o.ok) return o;
  if (o.business.status === "stopped") return { ok: false, why: "It has stopped." };
  const read = readLimits(input, caps);
  if (!read.ok) return read;
  const { limits, price, bidsPerHour } = read.value;
  getDb().prepare("UPDATE businesses SET budget_wei = ?, max_per_day_wei = ?, max_per_job_wei = ?, approve_above_wei = ?, spend_kinds = ?, price_min_wei = ?, price_max_wei = ?, bids_per_hour = ?, updated_at = ? WHERE business_id = ?")
    .run(limits.budgetWei.toString(), limits.maxPerDayWei.toString(), limits.maxPerJobWei.toString(), limits.approveAboveWei.toString(), limits.kinds.join(","), price.minWei.toString(), price.maxWei.toString(), bidsPerHour, now(), businessId);
  decide(businessId, "change", "You changed its limits", { detail: { budget: formatEth(limits.budgetWei), perDay: formatEth(limits.maxPerDayWei), perJob: formatEth(limits.maxPerJobWei), askAbove: formatEth(limits.approveAboveWei), spendOn: limits.kinds, price: `${formatEth(price.minWei)} to ${formatEth(price.maxWei)}`, bidsPerHour } });
  // a narrower range moves the price into it at once, as starting does, rather than at the next daily step
  priceIntoRange(businessId, o.business.agentId, price);
  void syncToTurso();
  return { ok: true, business: getBusiness(businessId)! };
}

/** Write when the business next looks at the network. */
export function scheduleNext(businessId: string, nowMs: number, caps: BusinessCaps = businessCaps()): void {
  getDb().prepare("UPDATE businesses SET last_scan_at = ?, next_scan_at = ? WHERE business_id = ?")
    .run(new Date(nowMs).toISOString(), new Date(nowMs + caps.scanMinutes * 60_000).toISOString(), businessId);
}
