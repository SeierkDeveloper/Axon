// Agents that run their own business: finding work, and following it to the money.
//
// Every few minutes (businessCaps().scanMinutes) a running business looks at the open tasks on the network: the jobs
// posters opened for any agent to bid on. For each one it has not decided on yet, clear rules come first and cost
// nothing:
//
//   its own owner posted it          taking it would only move the owner's money around, never revenue
//   an agent posted it whose owner never signed in   only verified agents
//   the bidding deadline has passed
//   it asks for skills this agent does not have, by its capabilities and its goal
//   its budget is below the agent's price
//
// What passes the rules goes to a cheap model check (businessCaps().checkModel): does this job fit the goal, and would
// it need help from other agents. Its cost is measured and goes in the ledger as a model cost. A job that fits gets a
// bid at the agent's price, through the open tasks' own bidding (./bidding), with a line about why it fits. The rest are
// declined. Every decision is in the log with its reason, once per open task.
//
// Caps: bids an hour per business (its owner's number, never above businessCaps().bidsPerHourMax), model checks a scan
// per business, and model checks a day for every business together. A cap reached waits for the next look.
//
// A bid is a claim on the job: when the poster accepts it, the open task becomes an ordinary job for the agent, paid as
// any accepted bid is, and the worker runs it with the agent's own tools, with its normal receipt. followWork keeps the
// books: a bid accepted is work won, and a job completed is a line in the ledger for exactly what its payment settled at.

import { getDb } from "./db";
import { logger } from "./logger";
import { getAgentById } from "./agents";
import { sameAddress, isWalletAddress } from "./address";
import { isOwnerVerified } from "./ownerVerification";
import { getOpenTaskById, listOpenTasks, submitBid, type OpenTask } from "./bidding";
import { getTaskById } from "./tasks";
import { parsePaymentAmount, formatEth, toWei } from "./money";
import { claudeModel } from "./providers";
import { captureModelStep } from "./modelUsage";
import { estimateCostUsd } from "./traceEvents";
import { ethUsd } from "./ethPrice";
import { validateAgentText } from "./agentContent";
import { BUSINESS, businessCaps, type BusinessCaps } from "./businessPolicy";
import { dayOf, decide, now, type Business } from "./business";
import { record } from "./businessLedger";
import type { Agent } from "@/sdk/types";

// ── The model check ──────────────────────────────────────────────────────────

export interface Fit { take: boolean; why: string; help: boolean }
export interface Checked { fit: Fit; costUsd: number | null; model: string }
/** The cheap check, swappable in tests so none of them calls a model. */
export type Judge = (b: Business, agent: Agent, t: OpenTask, caps: BusinessCaps) => Promise<Checked>;

const CHECK_SYSTEM =
  "You decide whether an AI agent that runs a small business should bid on a job. You answer with JSON only: " +
  '{"take": true or false, "why": "one short plain sentence", "help": true or false}. "take" is true only when the job clearly fits the ' +
  "business's goal and the agent's skills and the agent can do it well. \"help\" is true only when a part of the job needs a different " +
  "specialist. The \"why\" is shown to the poster when take is true, so write it to them, about the job, without dashes.";

export function checkPrompt(b: Business, agent: Agent, t: OpenTask): string {
  return [
    `The business: ${b.goal}`,
    `The agent: ${agent.name}. Skills: ${(agent.capabilities ?? []).join(", ") || "none listed"}.${agent.description ? ` ${agent.description.slice(0, 300)}` : ""}`,
    `The job asks for: ${t.capabilities.join(", ") || "nothing named"}.${t.maxBudget ? ` Budget: ${t.maxBudget}.` : ""}`,
    `The job, in the poster's words:\n${t.task.slice(0, 2_000)}`,
  ].join("\n\n");
}

/** The model's answer, read strictly: anything that is not a clear yes is a no. */
export function parseFit(raw: string): Fit {
  const m = raw.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : raw) as { take?: unknown; why?: unknown; help?: unknown };
    // no dashes between clauses, whatever the model wrote: a comma reads the same
    const why = typeof j.why === "string" ? j.why.replace(/\s*[—–]\s*|\s+-\s+/g, ", ").replace(/\s+/g, " ").trim().slice(0, BUSINESS.pitchChars) : "";
    return { take: j.take === true && why.length > 0, why: why || "The check gave no reason", help: j.help === true };
  } catch {
    return { take: false, why: "The check did not give a clear answer", help: false };
  }
}

export const realJudge: Judge = async (b, agent, t, caps) => {
  const step = await captureModelStep(() => claudeModel(caps.checkModel).complete(CHECK_SYSTEM, checkPrompt(b, agent, t), 200, 0));
  return { fit: parseFit(step.result), costUsd: estimateCostUsd(step.model ?? caps.checkModel, step.inputTokens, step.outputTokens), model: step.model ?? caps.checkModel };
};

/**
 * Dollars as wei at a dollar price of ETH, in whole numbers: a model call costs fractions of a cent, and a float divided
 * down to that size has more decimals than wei, which the money helpers rightly refuse.
 */
export function usdToWei(usd: number, usdPerEth: number): bigint {
  if (!(usd > 0) || !(usdPerEth > 0)) return 0n;
  const pico = BigInt(Math.round(usd * 1e12)), micro = BigInt(Math.round(usdPerEth * 1e6));
  return micro > 0n ? (pico * 10n ** 18n) / (micro * 1_000_000n) : 0n;
}

/** A model cost in the ledger: as measured in dollars, and what that came to in ETH at this moment. */
export async function recordModelCost(businessId: string, ref: string, costUsd: number | null, note: string, o: { jobRef?: string | null; price?: () => Promise<number | null> } = {}): Promise<void> {
  if (costUsd === null) return;
  const usd = await (o.price ?? ethUsd)().catch(() => null);
  const wei = usd ? usdToWei(costUsd, usd) : 0n;
  record(businessId, { kind: "model", amountWei: wei, costUsd, ref, jobRef: o.jobRef ?? null, note });
}

/** Model costs written while the ETH price could not be read: given their ETH value once it can. */
export async function repriceModelCosts(businessId: string, price: () => Promise<number | null> = ethUsd): Promise<number> {
  const rows = getDb().prepare("SELECT entry_id, cost_usd FROM business_ledger WHERE business_id = ? AND kind = 'model' AND amount_wei = '0' AND cost_usd > 0 LIMIT 200").all(businessId) as { entry_id: string; cost_usd: number }[];
  if (!rows.length) return 0;
  const usd = await price().catch(() => null);
  if (!usd) return 0;
  const set = getDb().prepare("UPDATE business_ledger SET amount_wei = ? WHERE entry_id = ?");
  for (const r of rows) set.run(usdToWei(r.cost_usd, usd).toString(), r.entry_id);
  return rows.length;
}

// ── The rules ────────────────────────────────────────────────────────────────

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Whether the job asks for something this agent does: its capabilities, or the words of its goal. */
export function skillsFit(agent: Agent, goal: string, asked: string[]): boolean {
  if (!asked.length) return true;
  const own = (agent.capabilities ?? []).map((c) => c.toLowerCase());
  const goalWords = new Set(words(goal));
  return asked.some((cap) => {
    const c = cap.toLowerCase().trim();
    return own.some((o) => o === c || o.includes(c) || c.includes(o)) || words(c).some((w) => goalWords.has(w));
  });
}

/** Why the rules say no to this open task, or null when it goes on to the check. */
export function ruledOut(b: Business, agent: Agent, t: OpenTask, nowMs: number): string | null {
  const poster = t.fromAgent;
  if (sameAddress(poster, b.ownerWallet)) return "Its own owner posted this: taking it would only move your money around";
  if (!isWalletAddress(poster)) {
    const by = getAgentById(poster);
    if (by?.walletAddress && sameAddress(by.walletAddress, b.ownerWallet)) return "One of its owner's own agents posted this: taking it would only move your money around";
    if (!by || !isOwnerVerified(poster)) return "The poster is not a verified agent";
  }
  if (t.deadline && Date.parse(t.deadline) < nowMs) return "The bidding deadline has passed";
  if (!skillsFit(agent, b.goal, t.capabilities)) return `Outside its skills: it asks for ${t.capabilities.slice(0, 4).join(", ")}`;
  const price = agent.price ? parsePaymentAmount(agent.price) : null;
  if (!price) return "It has no price to bid with";
  const budget = t.maxBudget ? parsePaymentAmount(t.maxBudget) : null;
  if (budget && budget.wei < price.wei) return `The budget of ${formatEth(budget.wei)} is below its price of ${formatEth(price.wei)}`;
  return null;
}

// ── Looking for work ─────────────────────────────────────────────────────────

const bidsSince = (businessId: string, sinceMs: number): number =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM business_jobs WHERE business_id = ? AND created_at > ?").get(businessId, new Date(sinceMs).toISOString()) as { n: number }).n;

/** Model checks made today by every business together. */
export const checksToday = (nowMs: number): number =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM business_ledger WHERE kind = 'model' AND ref LIKE 'check:%' AND day = ?").get(dayOf(nowMs)) as { n: number }).n;

const decidedOn = (businessId: string, openTaskId: string): boolean =>
  Boolean(getDb().prepare("SELECT 1 FROM business_decisions WHERE business_id = ? AND once_key = ?").get(businessId, `ot:${openTaskId}`))
  || Boolean(getDb().prepare("SELECT 1 FROM business_jobs WHERE business_id = ? AND open_task_id = ?").get(businessId, openTaskId));

/** The job a decision is about, in its poster's first words, for the owner's log. */
const jobLine = (t: OpenTask): string => { const f = t.task.replace(/\s+/g, " ").trim(); return f.length > 90 ? `${f.slice(0, 89).trimEnd()}…` : f; };

export interface ScanResult { looked: number; declined: number; checked: number; bid: number; capped: string | null }

/** Whether this agent can run a job as a team: Axon runs it on its own model, so the orchestrator path can. */
export const canLead = (agent: Agent): boolean => !agent.endpoint && (agent.provider ?? "anthropic") === "anthropic";

/** One look at the network for one business. Never throws into the worker. */
export async function findWork(b: Business, nowMs = Date.now(), judge: Judge = realJudge, caps: BusinessCaps = businessCaps()): Promise<ScanResult> {
  const out: ScanResult = { looked: 0, declined: 0, checked: 0, bid: 0, capped: null };
  const agent = getAgentById(b.agentId);
  if (!agent || b.status !== "active") return out;
  const open = listOpenTasks({ status: "open", limit: 100 }).filter((t) => !decidedOn(b.businessId, t.openTaskId));
  for (const t of open) {
    out.looked++;
    const no = ruledOut(b, agent, t, nowMs);
    if (no) {
      if (decide(b.businessId, "decline", no, { subject: t.openTaskId, once: `ot:${t.openTaskId}`, detail: { job: jobLine(t) }, nowMs })) out.declined++;
      continue;
    }
    const hour = Math.floor(nowMs / 3_600_000);
    if (bidsSince(b.businessId, nowMs - 3_600_000) >= Math.min(b.bidsPerHour, caps.bidsPerHourMax)) {
      out.capped = "hour";
      decide(b.businessId, "cap", `It bid on ${Math.min(b.bidsPerHour, caps.bidsPerHourMax)} jobs this hour, the most you allow: the rest wait`, { once: `cap:hour:${hour}`, nowMs });
      break;
    }
    if (out.checked >= caps.checksPerScan) { out.capped = "scan"; break; }
    if (checksToday(nowMs) >= caps.checksPerDay) {
      out.capped = "day";
      decide(b.businessId, "cap", "The network's model checks for today are used up: it looks again tomorrow", { once: `cap:day:${dayOf(nowMs)}`, nowMs });
      break;
    }
    let checked: Checked;
    try {
      checked = await judge(b, agent, t, caps);
    } catch (err) {
      logger.warn("business.check_failed", "A business could not check a job", { businessId: b.businessId, openTaskId: t.openTaskId, reason: err instanceof Error ? err.message : String(err) });
      break; // the model is not answering: try again on the next look, nothing decided
    }
    out.checked++;
    await recordModelCost(b.businessId, `check:${t.openTaskId}`, checked.costUsd, `Checked whether "${t.task.slice(0, 60)}" fits`, {});
    if (!checked.fit.take) {
      if (decide(b.businessId, "decline", `Does not fit the goal: ${checked.fit.why}`, { subject: t.openTaskId, once: `ot:${t.openTaskId}`, detail: { job: jobLine(t) }, nowMs })) out.declined++;
      continue;
    }
    const pitch = validateAgentText(checked.fit.why) ? `${agent.name} can do this job.` : checked.fit.why;
    const bid = submitBid({ openTaskId: t.openTaskId, agentId: agent.agentId, price: agent.price!, message: pitch });
    if (!bid.success) {
      decide(b.businessId, "decline", `Could not bid: ${bid.error}`, { subject: t.openTaskId, once: `ot:${t.openTaskId}`, detail: { job: jobLine(t) }, nowMs });
      out.declined++;
      continue;
    }
    const team = checked.fit.help && b.limits.kinds.includes("hire") && canLead(agent);
    getDb().prepare("INSERT INTO business_jobs (business_id, open_task_id, bid_id, status, team, price_wei, created_at, updated_at) VALUES (?, ?, ?, 'bid', ?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(b.businessId, t.openTaskId, bid.bid.bidId, team ? 1 : 0, parsePaymentAmount(agent.price!)!.wei.toString(), new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
    decide(b.businessId, "take", `Bid ${agent.price}: ${checked.fit.why}${team ? " It will bring in help for part of it." : ""}`, { subject: t.openTaskId, once: `ot:${t.openTaskId}`, detail: { bidId: bid.bid.bidId, price: agent.price, team, job: jobLine(t) }, nowMs });
    out.bid++;
  }
  return out;
}

// ── Following it to the money ────────────────────────────────────────────────

/** What a job's payment settled at for this agent: the completed lines paid to it for that job. Wei. */
export function settledTo(agentId: string, taskId: string): bigint | null {
  const rows = getDb().prepare("SELECT amount_eth, status FROM transactions WHERE task_id = ? AND to_agent = ?").all(taskId, agentId) as { amount_eth: number; status: string }[];
  if (!rows.length) return null;
  if (rows.some((r) => r.status === "escrow")) return null; // not settled yet
  return rows.filter((r) => r.status === "completed").reduce((n, r) => n + (toWei(r.amount_eth) ?? 0n), 0n);
}

export interface FollowResult { won: number; lost: number; done: number; failed: number }

/** Bids accepted or lost, and jobs finished, written to the log and the ledger. */
export function followWork(b: Business, nowMs = Date.now()): FollowResult {
  const out: FollowResult = { won: 0, lost: 0, done: 0, failed: 0 };
  const db = getDb();
  const set = (openTaskId: string, status: string, taskId?: string | null) =>
    db.prepare("UPDATE business_jobs SET status = ?, task_id = COALESCE(?, task_id), updated_at = ? WHERE business_id = ? AND open_task_id = ?").run(status, taskId ?? null, now(), b.businessId, openTaskId);
  const rows = db.prepare("SELECT open_task_id, bid_id, task_id, status FROM business_jobs WHERE business_id = ? AND status IN ('bid', 'won')").all(b.businessId) as { open_task_id: string; bid_id: string; task_id: string | null; status: string }[];
  for (const r of rows) {
    if (r.status === "bid") {
      const ot = getOpenTaskById(r.open_task_id);
      if (!ot || ot.status === "cancelled") { set(r.open_task_id, "lost"); decide(b.businessId, "lost", "The poster withdrew the job", { subject: r.open_task_id, once: `lost:${r.open_task_id}`, nowMs }); out.lost++; continue; }
      if (ot.status !== "accepted") continue;
      if (ot.acceptedBidId !== r.bid_id || !ot.acceptedTaskId) { set(r.open_task_id, "lost"); decide(b.businessId, "lost", "The poster chose another agent", { subject: r.open_task_id, once: `lost:${r.open_task_id}`, nowMs }); out.lost++; continue; }
      set(r.open_task_id, "won", ot.acceptedTaskId);
      decide(b.businessId, "won", "The poster accepted its bid: the job is its own now", { subject: ot.acceptedTaskId, once: `won:${r.open_task_id}`, detail: { receipt: `/r/${ot.acceptedTaskId}` }, nowMs });
      out.won++;
      r.task_id = ot.acceptedTaskId;
    }
    if (!r.task_id) continue;
    const task = getTaskById(r.task_id);
    if (!task) continue;
    if (task.status === "failed" || task.status === "cancelled") {
      set(r.open_task_id, "failed");
      decide(b.businessId, "failed", `The job ${task.status}${task.error ? `: ${task.error.slice(0, 160)}` : ""}. Its payment went back to the poster`, { subject: r.task_id, once: `end:${r.task_id}`, detail: { receipt: `/r/${r.task_id}` }, nowMs });
      out.failed++;
      continue;
    }
    if (task.status !== "completed") continue;
    const earned = settledTo(b.agentId, r.task_id);
    if (earned === null && task.payment) continue; // paid, settling: the next pass writes it
    set(r.open_task_id, "done");
    record(b.businessId, { kind: "job", amountWei: earned ?? 0n, ref: r.task_id, note: task.task.slice(0, 120), atMs: task.completedAt ? Date.parse(task.completedAt) : nowMs });
    decide(b.businessId, "done", `Did the job and earned ${formatEth(earned ?? 0n)}`, { subject: r.task_id, once: `end:${r.task_id}`, detail: { receipt: `/r/${r.task_id}` }, nowMs });
    out.done++;
  }
  return out;
}

/** The business job a task is, if it is one: what the worker asks before it runs a job. */
export function businessJobOf(taskId: string): { businessId: string; team: boolean } | null {
  const r = getDb().prepare("SELECT business_id, team FROM business_jobs WHERE task_id = ? LIMIT 1").get(taskId) as { business_id: string; team: number } | undefined;
  return r ? { businessId: r.business_id, team: r.team === 1 } : null;
}
