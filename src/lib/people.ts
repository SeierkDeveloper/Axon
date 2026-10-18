// Agents that hire people: the store, and every step a task for people goes through.
//
// An agent (or its owner for it) posts a task only a person can do. It is checked against the rules (./peoplePolicy and
// ./peopleCheck) before anyone sees it, and its payment is locked: from what the agent earned, or from a payment its
// owner sent first. Then:
//
//   open       on the board; anyone signed in with a wallet may take it
//   taken      one person has it, for the hours the task gives
//   delivered  they handed in proof; the agent's check is looking at it
//   rejected   the check said it does not meet one of the task's checks, and named it; the person may hand in again
//              while tries and time last, ask the owner for a second look, or give it up
//   review     the check could not tell, or the person asked for a second look: the owner decides, and if they do not
//              answer in time the person is paid
//   accepted   the payout is on its way; paid once it left with a hash
//
// A task nobody finished goes back on the board for someone else; at its deadline an unused payment comes back.
// What holds it is written next to each step below. Money leaves only through ./peoplePay.

import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { getAgentById } from "./agents";
import { normalizeAddress, sameAddress, shortAddress } from "./address";
import { isOwnerVerified } from "./ownerVerification";
import { validateAgentText } from "./agentContent";
import { checkIncomingPayment, decimalToWei, formatEth, parsePaymentAmount, toWei, weiToDecimalString } from "./money";
import { getAvailableBalanceWei } from "./payments";
import { safeAppendTraceEvent, traceIdForTask } from "./traceEvents";
import { PEOPLE, holdLimit, isProofKind, peopleCaps, peopleEnabled, screenTask, type PeopleCaps, type ProofKind } from "./peoplePolicy";

export type PeopleStatus = "approval" | "open" | "taken" | "delivered" | "rejected" | "review" | "accepted" | "paid" | "cancelled" | "expired";
export type LockState = "none" | "held" | "paid" | "returned";
export type Funding = "earnings" | "wallet";
export type Verdict = "accept" | "reject" | "unsure";

export interface PeopleTask {
  taskId: string;
  agentId: string;
  ownerWallet: string;
  postedBy: "owner" | "agent";
  parentTaskId: string | null;
  businessId: string | null;
  title: string;
  details: string;
  place: string | null;
  proofKind: ProofKind;
  checks: string[];
  priceWei: bigint;
  funding: Funding;
  fundingTx: string | null;
  lockState: LockState;
  status: PeopleStatus;
  approvalId: string | null;
  minDone: number;
  takeHours: number;
  deadlineAt: string;
  takerWallet: string | null;
  takenAt: string | null;
  takeUntil: string | null;
  tries: number;
  secondLook: boolean;
  reviewUntil: string | null;
  hiddenAt: string | null;
  hiddenReason: string | null;
  closeReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Delivery {
  deliveryId: string;
  taskId: string;
  wallet: string;
  tryNo: number;
  answer: string | null;
  fileId: string | null;
  fileSha256: string | null;
  fileMime: string | null;
  verdict: Verdict | null;
  verdictReason: string | null;
  failedCheck: number | null;
  verdictBy: string | null;
  checkModel: string | null;
  checkCostUsd: number | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface PeopleEvent { kind: string; wallet: string | null; text: string; at: string }

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const big = (v: unknown): bigint => (v !== null && v !== undefined && /^\d+$/.test(String(v)) ? BigInt(String(v)) : 0n);
export const now = (): string => new Date().toISOString();
const iso = (ms: number): string => new Date(ms).toISOString();
const dayStart = (ms: number): string => `${iso(ms).slice(0, 10)}T00:00:00.000Z`;
const HOUR = 3_600_000;

const toTask = (r: Row): PeopleTask => {
  let checks: string[] = [];
  try {
    const parsed = JSON.parse(String(r.checks ?? "[]"));
    if (Array.isArray(parsed)) checks = parsed.filter((c): c is string => typeof c === "string");
  } catch { /* a malformed row has no checks */ }
  return {
    taskId: String(r.task_id), agentId: String(r.agent_id), ownerWallet: String(r.owner_wallet), postedBy: r.posted_by === "agent" ? "agent" : "owner",
    parentTaskId: str(r.parent_task_id), businessId: str(r.business_id), title: String(r.title), details: String(r.details), place: str(r.place),
    proofKind: isProofKind(r.proof_kind) ? r.proof_kind : "answer", checks, priceWei: big(r.price_wei), funding: r.funding === "wallet" ? "wallet" : "earnings",
    fundingTx: str(r.funding_tx), lockState: String(r.lock_state) as LockState, status: String(r.status) as PeopleStatus, approvalId: str(r.approval_id),
    minDone: Number(r.min_done ?? 0), takeHours: Number(r.take_hours ?? 24), deadlineAt: String(r.deadline_at), takerWallet: str(r.taker_wallet),
    takenAt: str(r.taken_at), takeUntil: str(r.take_until), tries: Number(r.tries ?? 0), secondLook: Number(r.second_look) === 1, reviewUntil: str(r.review_until),
    hiddenAt: str(r.hidden_at), hiddenReason: str(r.hidden_reason), closeReason: str(r.close_reason), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    closedAt: str(r.closed_at),
  };
};

const toDelivery = (r: Row): Delivery => ({
  deliveryId: String(r.delivery_id), taskId: String(r.task_id), wallet: String(r.wallet), tryNo: Number(r.try_no), answer: str(r.answer), fileId: str(r.file_id),
  fileSha256: str(r.file_sha256), fileMime: str(r.file_mime), verdict: (str(r.verdict) as Verdict | null), verdictReason: str(r.verdict_reason),
  failedCheck: r.failed_check === null || r.failed_check === undefined ? null : Number(r.failed_check), verdictBy: str(r.verdict_by), checkModel: str(r.check_model),
  checkCostUsd: r.check_cost_usd === null || r.check_cost_usd === undefined ? null : Number(r.check_cost_usd), createdAt: String(r.created_at), decidedAt: str(r.decided_at),
});

export function getPeopleTask(taskId: string): PeopleTask | null {
  if (typeof taskId !== "string" || !/^pt_[A-Za-z0-9_-]{8,40}$/.test(taskId)) return null;
  const r = getDb().prepare("SELECT * FROM people_tasks WHERE task_id = ?").get(taskId) as Row | undefined;
  return r ? toTask(r) : null;
}

export function deliveriesOf(taskId: string): Delivery[] {
  return (getDb().prepare("SELECT * FROM people_deliveries WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[]).map(toDelivery);
}

export function latestDelivery(taskId: string): Delivery | null {
  const r = getDb().prepare("SELECT * FROM people_deliveries WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId) as Row | undefined;
  return r ? toDelivery(r) : null;
}

export function eventsOf(taskId: string): PeopleEvent[] {
  return (getDb().prepare("SELECT kind, wallet, text, created_at FROM people_events WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as Row[])
    .map((r) => ({ kind: String(r.kind), wallet: str(r.wallet), text: String(r.text), at: String(r.created_at) }));
}

/** A line in the task's own log. */
export function logEvent(taskId: string, kind: string, text: string, wallet: string | null = null, at = now()): void {
  getDb().prepare("INSERT INTO people_events (event_id, task_id, kind, wallet, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`pe_${randomUUID().replace(/-/g, "").slice(0, 20)}`, taskId, kind, wallet, text.slice(0, 400), at);
}

/** The job a task was posted from shows it on its receipt: when it was posted and how it ended. Content stays off it. */
function onReceipt(t: PeopleTask, status: string, extra: Record<string, unknown> = {}, outputHash: string | null = null): void {
  if (!t.parentTaskId) return;
  safeAppendTraceEvent({
    traceId: traceIdForTask(t.parentTaskId), taskId: t.parentTaskId, kind: "people.task", fromAgent: t.agentId, toAgent: null, outputHash,
    meta: { peopleTask: t.taskId, status, amount: Number(weiToDecimalString(t.priceWei)), currency: "ETH", ...extra },
  });
}

// ── Money held for tasks ─────────────────────────────────────────────────────

/** Hand an unused lock back: to the agent's balance at once, or queued to go back to the owner's wallet on-chain. */
function releaseLock(t: PeopleTask): void {
  if (t.lockState !== "held") return;
  if (t.funding === "earnings") {
    getDb().prepare("UPDATE people_tasks SET lock_state = 'returned', updated_at = ? WHERE task_id = ? AND lock_state = 'held'").run(now(), t.taskId);
    logEvent(t.taskId, "returned", `${formatEth(t.priceWei)} went back to the agent's earnings`);
  } else {
    // the owner paid it in from their wallet: it goes back there, through the payout queue (./peoplePay)
    const at = now();
    getDb().prepare("INSERT INTO people_payouts (payout_id, task_id, kind, wallet, amount_wei, status, created_at, updated_at) VALUES (?, ?, 'return', ?, ?, 'queued', ?, ?) ON CONFLICT (task_id, kind) DO NOTHING")
      .run(`pp_${randomUUID().replace(/-/g, "").slice(0, 20)}`, t.taskId, t.ownerWallet, t.priceWei.toString(), at, at);
    logEvent(t.taskId, "returning", `${formatEth(t.priceWei)} is on its way back to the owner's wallet`);
  }
}

// ── Posting ──────────────────────────────────────────────────────────────────

/** What a rules check said about a task's words: fine, against a rule (with which and why), or it could not tell. */
export type RulesAnswer = { ok: true } | { ok: false; rule: string; why: string } | null;
export interface RulesJudge { (t: { title: string; details: string; place: string | null; checks: string[]; proofKind: ProofKind }): Promise<RulesAnswer> }

export interface PostInput {
  agentId?: unknown;
  title?: unknown;
  details?: unknown;
  place?: unknown;
  proof?: unknown;
  checks?: unknown;
  priceEth?: unknown;
  takeHours?: unknown;
  days?: unknown;
  minDone?: unknown;
  funding?: unknown;
  paymentTx?: unknown;
}

export interface PostContext {
  /** the wallet asking: the agent's owner, or (for an agent posting during a job) its owner as well */
  wallet: string;
  postedBy?: "owner" | "agent";
  parentTaskId?: string | null;
  businessId?: string | null;
  /** an agent asked above its owner's amount: the task waits for this OK before it is locked and opened */
  approvalId?: string | null;
}

export type PostResult = { ok: true; task: PeopleTask } | { ok: false; why: string; code: "off" | "forbidden" | "invalid" | "rules" | "limit" | "payment" | "unavailable" };

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max) : "");
const intIn = (v: unknown, fallback: number, min: number, max: number): number | null => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export interface ReadTask { title: string; details: string; place: string | null; proofKind: ProofKind; checks: string[]; priceWei: bigint; takeHours: number; days: number; minDone: number }

/** Read what a task says, every field within its bounds, or the first thing wrong with it in words. */
export function readTask(input: PostInput, caps: PeopleCaps = peopleCaps()): { ok: true; value: ReadTask } | { ok: false; why: string } {
  const title = clean(input.title, PEOPLE.titleChars + 1);
  if (title.length < PEOPLE.titleMinChars || title.length > PEOPLE.titleChars) return { ok: false, why: `Say what the task is in a title of ${PEOPLE.titleMinChars} to ${PEOPLE.titleChars} characters.` };
  const details = typeof input.details === "string" ? input.details.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
  if (details.length < 20 || details.length > PEOPLE.detailsChars) return { ok: false, why: `Say what to do in 20 to ${PEOPLE.detailsChars} characters.` };
  const place = clean(input.place, PEOPLE.placeChars + 1);
  if (place.length > PEOPLE.placeChars) return { ok: false, why: `Name the place in at most ${PEOPLE.placeChars} characters: an area or a public place.` };
  if (!isProofKind(input.proof)) return { ok: false, why: "Say what proof to hand in: photo, file or answer." };
  const rawChecks = Array.isArray(input.checks) ? input.checks : typeof input.checks === "string" ? input.checks.split("\n") : [];
  const checks = rawChecks.map((c) => clean(c, PEOPLE.checkChars + 1)).filter(Boolean);
  if (checks.length < 1 || checks.length > PEOPLE.checksMax) return { ok: false, why: `List what the proof must show: 1 to ${PEOPLE.checksMax} lines. Only these can be a reason to reject it.` };
  if (checks.some((c) => c.length > PEOPLE.checkChars)) return { ok: false, why: `Each line of what the proof must show is at most ${PEOPLE.checkChars} characters.` };
  const priceRaw = typeof input.priceEth === "number" ? String(input.priceEth) : typeof input.priceEth === "string" ? input.priceEth.replace(/\s*eth$/i, "").trim() : "";
  const priceWei = /^\d+(\.\d+)?$/.test(priceRaw) ? decimalToWei(priceRaw) : null;
  if (priceWei === null || priceWei <= 0n) return { ok: false, why: "Give the pay in ETH, for example 0.001." };
  if (priceWei > caps.maxPriceWei) return { ok: false, why: `A task pays at most ${formatEth(caps.maxPriceWei)}.` };
  if (priceWei < caps.minPriceWei) return { ok: false, why: `A task pays at least ${formatEth(caps.minPriceWei)}.` };
  const takeHours = intIn(input.takeHours, 24, PEOPLE.takeHoursMin, PEOPLE.takeHoursMax);
  if (takeHours === null) return { ok: false, why: `Give the person ${PEOPLE.takeHoursMin} to ${PEOPLE.takeHoursMax} hours to do it.` };
  const days = intIn(input.days, Math.min(3, caps.maxDays), 1, caps.maxDays);
  if (days === null) return { ok: false, why: `A task stays on the board 1 to ${caps.maxDays} days.` };
  const minDone = intIn(input.minDone, 0, 0, 100);
  if (minDone === null) return { ok: false, why: "The record a person needs is a number of accepted tasks, 0 to 100." };
  return { ok: true, value: { title, details, place: place || null, proofKind: input.proof, checks, priceWei, takeHours, days, minDone } };
}

/** Whether this wallet may post for this agent at all: the reason it may not, or null. */
export function mayPost(agentId: string, wallet: string): string | null {
  const agent = getAgentById(agentId);
  if (!agent) return "There is no such agent.";
  if (!agent.walletAddress || !sameAddress(agent.walletAddress, wallet)) return "Only the agent's owner can do that.";
  if (!isOwnerVerified(agentId)) return "The agent's owner has to sign in with their wallet first.";
  if (blocked(`agent:${agentId}`)) return "This agent may not post tasks for people.";
  return null;
}

export function blocked(subject: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM people_blocks WHERE subject = ?").get(subject.toLowerCase().startsWith("agent:") ? subject : subject.toLowerCase()));
}

const newId = (): string => `pt_${randomBytes(12).toString("base64url")}`;

/** Post a task for people. Every rule is checked here, whoever posts: a page, the API, Mylo, an assistant or an agent. */
export async function postPeopleTask(input: PostInput, ctx: PostContext, judge: RulesJudge, o: { caps?: PeopleCaps; nowMs?: number; verify?: typeof checkIncomingPayment } = {}): Promise<PostResult> {
  if (!peopleEnabled()) return { ok: false, why: "Tasks for people are not open on this network.", code: "off" };
  const caps = o.caps ?? peopleCaps();
  const nowMs = o.nowMs ?? Date.now();
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  const wallet = normalizeAddress(ctx.wallet);
  if (!wallet) return { ok: false, why: "Sign in with your wallet first.", code: "forbidden" };
  const refused = mayPost(agentId, wallet);
  if (refused) return { ok: false, why: refused, code: refused.startsWith("There is") ? "invalid" : "forbidden" };
  const read = readTask(input, caps);
  if (!read.ok) return { ok: false, why: read.why, code: "invalid" };
  const t = read.value;
  const words = [t.title, t.details, t.place ?? "", ...t.checks].join("\n");
  const rude = validateAgentText(words);
  if (rude) return { ok: false, why: rude, code: "rules" };
  const broke = screenTask(words);
  if (broke) return { ok: false, why: `This task breaks the rule "${broke}". See the rules for tasks for people.`, code: "rules" };

  const db = getDb();
  const posted = (db.prepare("SELECT COUNT(*) n FROM people_tasks WHERE agent_id = ? AND created_at >= ?").get(agentId, dayStart(nowMs)) as { n: number }).n;
  if (posted >= caps.postsPerAgentDay) return { ok: false, why: `An agent posts at most ${caps.postsPerAgentDay} tasks for people a day.`, code: "limit" };
  const live = (db.prepare("SELECT COUNT(*) n FROM people_tasks WHERE owner_wallet = ? AND status IN ('approval','open','taken','delivered','rejected','review','accepted')").get(wallet) as { n: number }).n;
  if (live >= caps.openPerOwner) return { ok: false, why: `You can have at most ${caps.openPerOwner} tasks for people going at once.`, code: "limit" };

  const funding: Funding = input.funding === "wallet" ? "wallet" : "earnings";
  if (funding === "wallet" && ctx.approvalId) return { ok: false, why: "A task waiting for your OK is paid from the agent's earnings.", code: "invalid" };
  if (funding === "earnings" && !ctx.approvalId && getAvailableBalanceWei(agentId) < t.priceWei) {
    return { ok: false, why: `The agent's earnings do not cover ${formatEth(t.priceWei)}. Pay it from your wallet instead, or post a smaller task.`, code: "payment" };
  }

  // the model's check against the rules: a task that cannot be checked does not go up
  const verdict = await judge({ title: t.title, details: t.details, place: t.place, checks: t.checks, proofKind: t.proofKind });
  if (verdict === null) return { ok: false, why: "The rules check is not available just now. Try again in a few minutes.", code: "unavailable" };
  if (!verdict.ok) return { ok: false, why: `This task breaks the rule "${verdict.rule}": ${verdict.why}`, code: "rules" };

  let fundingTx: string | null = null;
  if (funding === "wallet") {
    const tx = typeof input.paymentTx === "string" ? input.paymentTx.trim() : "";
    if (!/^(0x[0-9a-fA-F]{64}|mockpay:[^\s]{1,300})$/.test(tx)) return { ok: false, why: `Send ${formatEth(t.priceWei)} to Axon's receiving wallet first and give the transaction hash.`, code: "payment" };
    if (db.prepare("SELECT 1 FROM people_tasks WHERE funding_tx = ?").get(tx) || db.prepare("SELECT 1 FROM transactions WHERE incoming_signature = ?").get(tx)) {
      return { ok: false, why: "That payment was already used.", code: "payment" };
    }
    const expected = parsePaymentAmount(`${weiToDecimalString(t.priceWei)} ETH`)!;
    let checked: { ok: boolean; reason: string };
    try {
      checked = await (o.verify ?? checkIncomingPayment)(tx, expected, wallet);
    } catch {
      return { ok: false, why: "The payment could not be read on-chain just now. Try again with the same hash; do not pay again.", code: "unavailable" };
    }
    if (!checked.ok) return { ok: false, why: `The payment did not check out: ${formatEth(t.priceWei)} from your wallet to Axon's (${checked.reason}).`, code: "payment" };
    fundingTx = tx;
  }

  const id = newId(), at = iso(nowMs);
  const deadline = iso(nowMs + t.days * 24 * HOUR);
  const waiting = Boolean(ctx.approvalId);
  // checked and written as one step, so two tasks posted at once cannot both be paid from the same earnings
  const done = db.transaction((): string | null => {
    if (funding === "earnings" && !waiting && getAvailableBalanceWei(agentId) < t.priceWei) return `The agent's earnings do not cover ${formatEth(t.priceWei)}.`;
    db.prepare(
      `INSERT INTO people_tasks (task_id, agent_id, owner_wallet, posted_by, parent_task_id, business_id, title, details, place, proof_kind, checks, price_wei, funding, funding_tx,
         lock_state, status, approval_id, min_done, take_hours, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, agentId, wallet, ctx.postedBy ?? "owner", ctx.parentTaskId ?? null, ctx.businessId ?? null, t.title, t.details, t.place, t.proofKind, JSON.stringify(t.checks),
      t.priceWei.toString(), funding, fundingTx, waiting ? "none" : "held", waiting ? "approval" : "open", ctx.approvalId ?? null, t.minDone, t.takeHours, deadline, at, at);
    return null;
  })();
  if (done) return { ok: false, why: done, code: "payment" };
  const task = getPeopleTask(id)!;
  logEvent(id, "posted", `Posted by ${ctx.postedBy === "agent" ? "the agent during a job" : "the agent's owner"}, paying ${formatEth(t.priceWei)}${waiting ? "" : `, locked from ${funding === "earnings" ? "the agent's earnings" : "the owner's payment"}`}`, null, at);
  if (waiting) logEvent(id, "asked_ok", "Waiting for the owner's OK before it goes on the board", null, at);
  onReceipt(task, waiting ? "waiting for the owner's OK" : "posted");
  logger.info("people.posted", "A task for people was posted", { taskId: id, agentId, postedBy: ctx.postedBy ?? "owner", funding, waiting });
  void syncToTurso();
  return { ok: true, task };
}

/** The owner said yes to a task an agent asked for: its payment is locked now and it opens. False when it cannot be. */
export function openApproved(taskId: string, nowMs = Date.now()): { ok: true } | { ok: false; why: string } {
  const t = getPeopleTask(taskId);
  if (!t || t.status !== "approval") return { ok: false, why: "It is not waiting for an OK." };
  const db = getDb();
  const why = db.transaction((): string | null => {
    if (getAvailableBalanceWei(t.agentId) < t.priceWei) return `the agent's earnings no longer cover ${formatEth(t.priceWei)}`;
    db.prepare("UPDATE people_tasks SET status = 'open', lock_state = 'held', updated_at = ? WHERE task_id = ? AND status = 'approval'").run(iso(nowMs), taskId);
    return null;
  })();
  if (why) {
    closeTask(t, "cancelled", `The owner said yes, but ${why}`);
    return { ok: false, why };
  }
  logEvent(taskId, "approved", `The owner said yes; ${formatEth(t.priceWei)} is locked from the agent's earnings and it is on the board`);
  onReceipt(getPeopleTask(taskId)!, "posted");
  return { ok: true };
}

/** Close a task for good: cancelled or expired. Its lock comes back. */
export function closeTask(t: PeopleTask, status: "cancelled" | "expired", reason: string, nowMs = Date.now()): PeopleTask {
  const at = iso(nowMs);
  const changed = getDb().prepare("UPDATE people_tasks SET status = ?, close_reason = ?, closed_at = ?, updated_at = ?, taker_wallet = NULL, taken_at = NULL, take_until = NULL WHERE task_id = ? AND status IN ('approval', 'open')")
    .run(status, reason.slice(0, 300), at, at, t.taskId).changes;
  if (changed) {
    logEvent(t.taskId, status, reason, null, at);
    releaseLock(t);
    onReceipt(t, status);
    void syncToTurso();
  }
  return getPeopleTask(t.taskId) ?? t;
}

/** The owner takes a task back before anyone has it. */
export function cancelPeopleTask(taskId: string, wallet: string): { ok: true; task: PeopleTask } | { ok: false; why: string } {
  const t = getPeopleTask(taskId);
  if (!t || !sameAddress(t.ownerWallet, wallet)) return { ok: false, why: "There is no such task of yours." };
  if (t.status !== "open" && t.status !== "approval") return { ok: false, why: t.takerWallet ? "Someone is doing this task. It can be cancelled only while nobody has it." : `The task is ${t.status}.` };
  return { ok: true, task: closeTask(t, "cancelled", "The owner cancelled it") };
}

// ── A person's record ────────────────────────────────────────────────────────

export interface PeopleRecord { wallet: string; short: string; done: number; rejected: number; gaveUp: number; earnedWei: bigint; earned: string; since: string | null; last: string | null }

/** What a person has done on the board: tasks accepted, rejected for good, given up or run out of time on, and earned. */
export function recordOf(wallet: string): PeopleRecord {
  const w = wallet.toLowerCase(), db = getDb();
  const done = (db.prepare("SELECT COUNT(*) n FROM people_deliveries WHERE wallet = ? AND verdict = 'accept'").get(w) as { n: number }).n;
  const rejected = (db.prepare("SELECT COUNT(*) n FROM people_events WHERE wallet = ? AND kind = 'rejected_final'").get(w) as { n: number }).n;
  const gaveUp = (db.prepare("SELECT COUNT(*) n FROM people_events WHERE wallet = ? AND kind IN ('gave_up', 'time_up')").get(w) as { n: number }).n;
  const earnedWei = (db.prepare("SELECT amount_wei FROM people_payouts WHERE wallet = ? AND kind = 'pay' AND status = 'sent'").all(w) as { amount_wei: string }[]).reduce((n, r) => n + big(r.amount_wei), 0n);
  const span = db.prepare("SELECT MIN(created_at) a, MAX(created_at) b FROM people_events WHERE wallet = ? AND kind = 'taken'").get(w) as { a: string | null; b: string | null };
  return { wallet: w, short: shortAddress(w) ?? w, done, rejected, gaveUp, earnedWei, earned: formatEth(earnedWei), since: span.a, last: span.b };
}

/** The people with the most accepted tasks: the public record. */
export function topPeople(limit: number = PEOPLE.shownInRecord): PeopleRecord[] {
  const rows = getDb().prepare("SELECT wallet, COUNT(*) n, MAX(decided_at) last FROM people_deliveries WHERE verdict = 'accept' GROUP BY wallet ORDER BY n DESC, last DESC LIMIT ?").all(limit) as { wallet: string }[];
  return rows.map((r) => recordOf(r.wallet));
}

/** Tasks this person holds right now (taken, handed in, rejected but still theirs, or in review). */
export function holding(wallet: string): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM people_tasks WHERE taker_wallet = ? AND status IN ('taken', 'delivered', 'rejected', 'review')").get(wallet.toLowerCase()) as { n: number }).n;
}

// ── Taking, giving up ────────────────────────────────────────────────────────

export type StepResult = { ok: true; task: PeopleTask } | { ok: false; why: string };

/** A person takes a task off the board. */
export function takePeopleTask(taskId: string, wallet: string, o: { caps?: PeopleCaps; nowMs?: number } = {}): StepResult {
  if (!peopleEnabled()) return { ok: false, why: "Tasks for people are not open on this network." };
  const caps = o.caps ?? peopleCaps(), nowMs = o.nowMs ?? Date.now();
  const w = normalizeAddress(wallet);
  if (!w) return { ok: false, why: "Sign in with your wallet first." };
  const t = getPeopleTask(taskId);
  if (!t || t.hiddenAt) return { ok: false, why: "There is no such task on the board." };
  if (t.status !== "open") return { ok: false, why: "Someone else has this task, or it is closed." };
  if (Date.parse(t.deadlineAt) <= nowMs) return { ok: false, why: "This task's time on the board is over." };
  if (blocked(w)) return { ok: false, why: "This wallet may not take tasks for people." };
  const agent = getAgentById(t.agentId);
  if (sameAddress(t.ownerWallet, w) || sameAddress(agent?.walletAddress, w)) return { ok: false, why: "You cannot take a task your own agent posted." };
  const db = getDb();
  if (db.prepare("SELECT 1 FROM people_events WHERE task_id = ? AND wallet = ? AND kind IN ('gave_up', 'time_up', 'rejected_final') LIMIT 1").get(taskId, w)) {
    return { ok: false, why: "You already had this task. It is someone else's turn." };
  }
  const rec = recordOf(w);
  if (rec.done < t.minDone) return { ok: false, why: `This task is for people with at least ${t.minDone} accepted ${t.minDone === 1 ? "task" : "tasks"} on their record.` };
  const limit = holdLimit(rec.done);
  if (holding(w) >= limit) return { ok: false, why: `You can hold ${limit} ${limit === 1 ? "task" : "tasks"} at once with your record. Finish one first.` };
  const today = (db.prepare("SELECT COUNT(*) n FROM people_events WHERE wallet = ? AND kind = 'taken' AND created_at >= ?").get(w, dayStart(nowMs)) as { n: number }).n;
  if (today >= caps.takesPerDay) return { ok: false, why: `You can take at most ${caps.takesPerDay} tasks a day.` };
  const at = iso(nowMs), until = iso(nowMs + t.takeHours * HOUR);
  const changed = db.prepare("UPDATE people_tasks SET status = 'taken', taker_wallet = ?, taken_at = ?, take_until = ?, tries = 0, second_look = 0, review_until = NULL, updated_at = ? WHERE task_id = ? AND status = 'open' AND hidden_at IS NULL")
    .run(w, at, until, at, taskId).changes;
  if (!changed) return { ok: false, why: "Someone else took this task first." };
  logEvent(taskId, "taken", `Taken by ${shortAddress(w)}, who has ${t.takeHours} ${t.takeHours === 1 ? "hour" : "hours"} to do it`, w, at);
  void syncToTurso();
  return { ok: true, task: getPeopleTask(taskId)! };
}

/** The task goes back on the board for someone else, or closes if its time on the board is over. */
function reopen(t: PeopleTask, nowMs: number): PeopleTask {
  const at = iso(nowMs);
  const next = Date.parse(t.deadlineAt) > nowMs && !t.hiddenAt ? "open" : "expired";
  getDb().prepare(`UPDATE people_tasks SET status = ?, taker_wallet = NULL, taken_at = NULL, take_until = NULL, tries = 0, second_look = 0, review_until = NULL, updated_at = ?${next === "expired" ? ", closed_at = ?, close_reason = 'Its time on the board ran out'" : ""} WHERE task_id = ?`)
    .run(...(next === "expired" ? [next, at, at, t.taskId] : [next, at, t.taskId]));
  if (next === "open") logEvent(t.taskId, "reopened", "Back on the board for someone else", null, at);
  else {
    logEvent(t.taskId, "expired", "Its time on the board ran out", null, at);
    releaseLock(t);
    onReceipt(t, "expired");
  }
  void syncToTurso();
  return getPeopleTask(t.taskId)!;
}

/** The person gives the task up. It goes on their record and back on the board. */
export function giveUpPeopleTask(taskId: string, wallet: string, nowMs = Date.now()): StepResult {
  const t = getPeopleTask(taskId);
  if (!t || !sameAddress(t.takerWallet, wallet)) return { ok: false, why: "You do not have this task." };
  if (!["taken", "rejected"].includes(t.status)) return { ok: false, why: t.status === "delivered" || t.status === "review" ? "Your proof is being looked at. Wait for the answer." : `The task is ${t.status}.` };
  logEvent(taskId, t.status === "rejected" ? "rejected_final" : "gave_up", t.status === "rejected" ? "The person left it after a rejection" : "The person gave it up", t.takerWallet, iso(nowMs));
  return { ok: true, task: reopen(t, nowMs) };
}

// ── Handing in, and the verdict ──────────────────────────────────────────────

export interface Handed { answer?: string | null; file?: { id: string; sha256: string; mime: string; kind: string } | null }

/** The person hands in proof. The check runs next (./peopleCheck); until then the task is "delivered". */
export function deliverPeopleTask(taskId: string, wallet: string, proof: Handed, nowMs = Date.now()): { ok: true; task: PeopleTask; delivery: Delivery } | { ok: false; why: string } {
  const t = getPeopleTask(taskId);
  if (!t || !sameAddress(t.takerWallet, wallet)) return { ok: false, why: "You do not have this task." };
  if (t.status !== "taken" && t.status !== "rejected") return { ok: false, why: t.status === "delivered" || t.status === "review" ? "Your proof is already being looked at." : `The task is ${t.status}.` };
  if (t.takeUntil && Date.parse(t.takeUntil) <= nowMs) return { ok: false, why: "Your time for this task is over." };
  if (t.tries >= PEOPLE.triesPerTaker) return { ok: false, why: `You have handed in ${PEOPLE.triesPerTaker} times. Ask the owner for a second look, or leave it.` };
  if (t.status === "rejected" && t.secondLook) return { ok: false, why: "You asked for a second look. Wait for the owner." };
  const answer = typeof proof.answer === "string" ? proof.answer.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, PEOPLE.answerChars) : "";
  const file = proof.file ?? null;
  if (t.proofKind === "photo" && (!file || file.kind !== "image")) return { ok: false, why: "This task needs a photo: a PNG, JPEG, GIF or WebP picture." };
  if (t.proofKind === "file" && !file) return { ok: false, why: "This task needs a file: a PDF, a picture or a text file." };
  if (t.proofKind === "answer" && answer.length < 2) return { ok: false, why: "This task needs your answer in words." };
  const rude = answer ? validateAgentText(answer) : null;
  if (rude) return { ok: false, why: rude };
  const id = `pd_${randomUUID().replace(/-/g, "").slice(0, 20)}`, at = iso(nowMs), w = t.takerWallet!;
  const db = getDb();
  const changed = db.transaction((): boolean => {
    const c = db.prepare("UPDATE people_tasks SET status = 'delivered', tries = tries + 1, updated_at = ? WHERE task_id = ? AND status IN ('taken', 'rejected') AND taker_wallet = ?").run(at, taskId, w).changes;
    if (!c) return false;
    db.prepare("INSERT INTO people_deliveries (delivery_id, task_id, wallet, try_no, answer, file_id, file_sha256, file_mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, w, t.tries + 1, answer || null, file?.id ?? null, file?.sha256 ?? null, file?.mime ?? null, at);
    return true;
  })();
  if (!changed) return { ok: false, why: "The task changed. Look again." };
  logEvent(taskId, "handed_in", `Proof handed in (try ${t.tries + 1} of ${PEOPLE.triesPerTaker})${file ? `, fingerprint ${file.sha256.slice(0, 12)}` : ""}`, w, at);
  void syncToTurso();
  return { ok: true, task: getPeopleTask(taskId)!, delivery: deliveriesOf(taskId).at(-1)! };
}

export interface VerdictInput { verdict: Verdict; reason: string; failedCheck?: number | null; by: "check" | "owner" | "silence" | "moderator"; model?: string | null; costUsd?: number | null }

/**
 * What was decided about the latest proof. The only door to "accepted": the payout follows from it (./peoplePay).
 * A rejection must name one of the task's checks; one that does not is turned into "unsure" and goes to the owner.
 */
export function applyVerdict(taskId: string, v: VerdictInput, o: { caps?: PeopleCaps; nowMs?: number } = {}): StepResult {
  const caps = o.caps ?? peopleCaps(), nowMs = o.nowMs ?? Date.now(), at = iso(nowMs);
  const t = getPeopleTask(taskId);
  if (!t) return { ok: false, why: "There is no such task." };
  const d = latestDelivery(taskId);
  if (!d || !t.takerWallet || d.wallet !== t.takerWallet) return { ok: false, why: "There is no proof to decide on." };
  const db = getDb();
  let verdict = v.verdict;
  let reason = v.reason.replace(/\s+/g, " ").trim().slice(0, 400);
  const failed = typeof v.failedCheck === "number" && Number.isInteger(v.failedCheck) && v.failedCheck >= 0 && v.failedCheck < t.checks.length ? v.failedCheck : null;
  if (verdict === "reject" && (failed === null || reason.length < 5)) {
    verdict = "unsure";
    reason = `The check would not accept it but did not name which line it failed${reason ? `: ${reason}` : ""}`;
  }

  if (verdict === "accept") {
    // from a proof waiting to be checked, one rejected (the owner may overrule the check), or one in review
    if (!["delivered", "rejected", "review"].includes(t.status)) return { ok: false, why: `The task is ${t.status}.` };
    const c = db.prepare("UPDATE people_tasks SET status = 'accepted', review_until = NULL, updated_at = ? WHERE task_id = ? AND status IN ('delivered', 'rejected', 'review')").run(at, taskId).changes;
    if (!c) return { ok: false, why: "The task changed. Look again." };
    db.prepare("UPDATE people_deliveries SET verdict = 'accept', verdict_reason = ?, failed_check = NULL, verdict_by = ?, check_model = COALESCE(?, check_model), check_cost_usd = COALESCE(?, check_cost_usd), decided_at = ? WHERE delivery_id = ?")
      .run(reason || "It meets every check", v.by, v.model ?? null, v.costUsd ?? null, at, d.deliveryId);
    logEvent(taskId, "accepted", v.by === "silence" ? "Accepted: the owner did not answer in time, so the person is paid" : v.by === "owner" ? "Accepted by the owner" : v.by === "moderator" ? "Accepted by a moderator" : `Accepted by the agent's check: ${reason || "it meets every check"}`, t.takerWallet, at);
    void syncToTurso();
    return { ok: true, task: getPeopleTask(taskId)! };
  }

  if (verdict === "unsure") {
    if (t.status !== "delivered") return { ok: false, why: `The task is ${t.status}.` };
    const until = iso(nowMs + caps.reviewHours * HOUR);
    db.prepare("UPDATE people_tasks SET status = 'review', review_until = ?, updated_at = ? WHERE task_id = ? AND status = 'delivered'").run(until, at, taskId);
    db.prepare("UPDATE people_deliveries SET verdict = 'unsure', verdict_reason = ?, verdict_by = ?, check_model = ?, check_cost_usd = ?, decided_at = ? WHERE delivery_id = ?")
      .run(reason, v.by, v.model ?? null, v.costUsd ?? null, at, d.deliveryId);
    logEvent(taskId, "review", `The check could not tell, so the owner decides within ${caps.reviewHours} hours. If they do not, the person is paid.`, t.takerWallet, at);
    void syncToTurso();
    return { ok: true, task: getPeopleTask(taskId)! };
  }

  // a rejection, naming the line it failed
  const line = t.checks[failed!];
  if (t.status === "review") {
    // the owner's own answer, after the check could not tell or after the person asked them to look: final for this person
    if (v.by !== "owner" && v.by !== "moderator") return { ok: false, why: "Only the owner decides a task in review." };
    db.prepare("UPDATE people_deliveries SET verdict = 'reject', verdict_reason = ?, failed_check = ?, verdict_by = ?, decided_at = ? WHERE delivery_id = ?").run(reason, failed, v.by, at, d.deliveryId);
    logEvent(taskId, "rejected_final", `Rejected by the ${v.by}: it does not meet "${line}". ${reason}`, t.takerWallet, at);
    return { ok: true, task: reopen(t, nowMs) };
  }
  if (t.status !== "delivered") return { ok: false, why: `The task is ${t.status}.` };
  // the person always has at least an hour after a rejection to hand in again or ask for a second look
  const until = Math.max(Date.parse(t.takeUntil ?? at), nowMs + HOUR);
  db.prepare("UPDATE people_tasks SET status = 'rejected', take_until = ?, updated_at = ? WHERE task_id = ? AND status = 'delivered'").run(iso(until), at, taskId);
  db.prepare("UPDATE people_deliveries SET verdict = 'reject', verdict_reason = ?, failed_check = ?, verdict_by = ?, check_model = ?, check_cost_usd = ?, decided_at = ? WHERE delivery_id = ?")
    .run(reason, failed, v.by, v.model ?? null, v.costUsd ?? null, at, d.deliveryId);
  const left = PEOPLE.triesPerTaker - t.tries;
  logEvent(taskId, "rejected", `Not accepted: it does not meet "${line}". ${reason} ${left > 0 ? `${left} more ${left === 1 ? "try" : "tries"} left.` : "No tries left."} The person can ask the owner for a second look.`, t.takerWallet, at);
  void syncToTurso();
  return { ok: true, task: getPeopleTask(taskId)! };
}

/** After a rejection, the person asks the owner to look at it themselves. Once per person per task. */
export function askSecondLook(taskId: string, wallet: string, o: { caps?: PeopleCaps; nowMs?: number } = {}): StepResult {
  const caps = o.caps ?? peopleCaps(), nowMs = o.nowMs ?? Date.now(), at = iso(nowMs);
  const t = getPeopleTask(taskId);
  if (!t || !sameAddress(t.takerWallet, wallet)) return { ok: false, why: "You do not have this task." };
  if (t.status !== "rejected") return { ok: false, why: "A second look is for a rejected proof." };
  if (t.secondLook) return { ok: false, why: "You already asked for a second look." };
  const until = iso(nowMs + caps.reviewHours * HOUR);
  const c = getDb().prepare("UPDATE people_tasks SET status = 'review', second_look = 1, review_until = ?, updated_at = ? WHERE task_id = ? AND status = 'rejected' AND second_look = 0").run(until, at, taskId).changes;
  if (!c) return { ok: false, why: "The task changed. Look again." };
  logEvent(taskId, "second_look", `The person asked the owner for a second look. The owner answers within ${caps.reviewHours} hours, or the person is paid.`, t.takerWallet, at);
  void syncToTurso();
  return { ok: true, task: getPeopleTask(taskId)! };
}

/** The owner decides: accept a proof at any point after it is handed in, or reject one that waits for them in review. */
export function ownerDecides(taskId: string, wallet: string, input: { decision?: unknown; failedCheck?: unknown; reason?: unknown }, o: { caps?: PeopleCaps; nowMs?: number } = {}): StepResult {
  const t = getPeopleTask(taskId);
  if (!t || !sameAddress(t.ownerWallet, wallet)) return { ok: false, why: "There is no such task of yours." };
  if (input.decision === "accept") return applyVerdict(taskId, { verdict: "accept", reason: typeof input.reason === "string" ? input.reason : "Accepted by the owner", by: "owner" }, o);
  if (input.decision !== "reject") return { ok: false, why: "Say accept or reject." };
  if (t.status !== "review") return { ok: false, why: "You can reject a proof only when it waits for you. The agent's check rejects the others with a reason." };
  const failed = Number(input.failedCheck);
  if (!Number.isInteger(failed) || failed < 0 || failed >= t.checks.length) return { ok: false, why: "Pick which of the task's checks the proof does not meet." };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) return { ok: false, why: "Say why, in a few words. The person reads it." };
  return applyVerdict(taskId, { verdict: "reject", failedCheck: failed, reason, by: "owner" }, o);
}

// ── The clock ────────────────────────────────────────────────────────────────

/**
 * What time moves on: a person whose time ran out is let go (on their record) and the task goes back up; a task whose
 * time on the board ran out closes and its lock comes back; a review the owner left unanswered pays the person.
 */
export function moveClock(nowMs = Date.now(), o: { caps?: PeopleCaps } = {}): { timedOut: number; expired: number; paidOnSilence: number } {
  const at = iso(nowMs), db = getDb(), out = { timedOut: 0, expired: 0, paidOnSilence: 0 };
  for (const r of db.prepare("SELECT * FROM people_tasks WHERE status IN ('taken', 'rejected') AND take_until <= ? LIMIT 200").all(at) as Row[]) {
    const t = toTask(r);
    logEvent(t.taskId, t.status === "rejected" ? "rejected_final" : "time_up", t.status === "rejected" ? "The person's time ran out after a rejection" : "The person's time ran out before they handed anything in", t.takerWallet, at);
    reopen(t, nowMs);
    out.timedOut++;
  }
  for (const r of db.prepare("SELECT * FROM people_tasks WHERE status IN ('open', 'approval') AND deadline_at <= ? LIMIT 200").all(at) as Row[]) {
    closeTask(toTask(r), "expired", "Its time on the board ran out", nowMs);
    out.expired++;
  }
  for (const r of db.prepare("SELECT task_id FROM people_tasks WHERE status = 'review' AND review_until <= ? LIMIT 200").all(at) as Row[]) {
    if (applyVerdict(String(r.task_id), { verdict: "accept", reason: "The owner did not answer in time", by: "silence" }, { ...o, nowMs }).ok) out.paidOnSilence++;
  }
  return out;
}

// ── Moderation ───────────────────────────────────────────────────────────────

/** Anyone reports a task. Enough different people take it off the board until a moderator looks. */
export function reportPeopleTask(taskId: string, reporter: string, reason: string, note: string | null, o: { caps?: PeopleCaps; nowMs?: number } = {}): { ok: true; hidden: boolean } | { ok: false; why: string } {
  const caps = o.caps ?? peopleCaps(), at = iso(o.nowMs ?? Date.now());
  const t = getPeopleTask(taskId);
  if (!t) return { ok: false, why: "There is no such task." };
  const db = getDb();
  const added = db.prepare("INSERT INTO people_reports (report_id, task_id, reporter, reason, note, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (task_id, reporter) DO NOTHING")
    .run(`pr_${randomUUID().replace(/-/g, "").slice(0, 20)}`, taskId, reporter, reason, note?.slice(0, PEOPLE.reportNoteChars) ?? null, at).changes;
  if (!added) return { ok: false, why: "You already reported this task." };
  const n = (db.prepare("SELECT COUNT(*) n FROM people_reports WHERE task_id = ? AND status = 'open'").get(taskId) as { n: number }).n;
  if (n >= caps.reportsToHide && !t.hiddenAt) {
    hideTask(t, `Reported by ${n} people; waiting for a moderator`, o.nowMs);
    return { ok: true, hidden: true };
  }
  return { ok: true, hidden: false };
}

/** Off the board. A task nobody has closes and its lock comes back; one somebody holds stays theirs to finish. */
export function hideTask(t: PeopleTask, reason: string, nowMs = Date.now()): PeopleTask {
  const at = iso(nowMs);
  getDb().prepare("UPDATE people_tasks SET hidden_at = ?, hidden_reason = ?, updated_at = ? WHERE task_id = ?").run(at, reason.slice(0, 300), at, t.taskId);
  logEvent(t.taskId, "hidden", `Taken off the board: ${reason}`, null, at);
  if (t.status === "open" || t.status === "approval") return closeTask(getPeopleTask(t.taskId)!, "cancelled", "Taken off the board by moderation", nowMs);
  return getPeopleTask(t.taskId)!;
}

/** A moderator's answer to a task's reports: take it down (and optionally stop the agent posting), or put it back. */
export function moderate(taskId: string, action: "hide" | "show" | "block_agent" | "block_taker", reason: string): StepResult {
  const t = getPeopleTask(taskId);
  if (!t) return { ok: false, why: "There is no such task." };
  const db = getDb(), at = now();
  if (action === "show") {
    db.prepare("UPDATE people_tasks SET hidden_at = NULL, hidden_reason = NULL, updated_at = ? WHERE task_id = ?").run(at, taskId);
    db.prepare("UPDATE people_reports SET status = 'dismissed' WHERE task_id = ? AND status = 'open'").run(taskId);
    logEvent(taskId, "shown", "A moderator looked and it stays");
    return { ok: true, task: getPeopleTask(taskId)! };
  }
  db.prepare("UPDATE people_reports SET status = 'upheld' WHERE task_id = ? AND status = 'open'").run(taskId);
  if (action === "block_agent") db.prepare("INSERT INTO people_blocks (subject, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (subject) DO NOTHING").run(`agent:${t.agentId}`, reason.slice(0, 300), at);
  if (action === "block_taker" && t.takerWallet) db.prepare("INSERT INTO people_blocks (subject, reason, created_at) VALUES (?, ?, ?) ON CONFLICT (subject) DO NOTHING").run(t.takerWallet, reason.slice(0, 300), at);
  return { ok: true, task: t.hiddenAt ? t : hideTask(t, reason || "A moderator took it down") };
}

// ── Lists and views ──────────────────────────────────────────────────────────

/** The board: open tasks first, newest first, nothing hidden. */
export function boardTasks(limit: number = PEOPLE.shownOnBoard, nowMs = Date.now()): PeopleTask[] {
  return (getDb().prepare("SELECT * FROM people_tasks WHERE status = 'open' AND hidden_at IS NULL AND deadline_at > ? ORDER BY created_at DESC LIMIT ?").all(iso(nowMs), limit) as Row[]).map(toTask);
}

/** Tasks done lately, for the board's record of what people did (no proof, no owner). */
export function recentlyDone(limit = 10): PeopleTask[] {
  return (getDb().prepare("SELECT * FROM people_tasks WHERE status IN ('accepted', 'paid') AND hidden_at IS NULL ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map(toTask);
}

export function tasksOfOwner(wallet: string, limit = 50): PeopleTask[] {
  return (getDb().prepare("SELECT * FROM people_tasks WHERE owner_wallet = ? ORDER BY (status IN ('cancelled','expired','paid')) ASC, created_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as Row[]).map(toTask);
}

/** What a person holds now and what they did before, newest first. */
export function tasksOfTaker(wallet: string, limit = 30): PeopleTask[] {
  const w = wallet.toLowerCase();
  return (getDb().prepare(
    `SELECT * FROM people_tasks WHERE taker_wallet = ? OR task_id IN (SELECT DISTINCT task_id FROM people_deliveries WHERE wallet = ?)
     ORDER BY (taker_wallet = ? AND status IN ('taken','delivered','rejected','review','accepted')) DESC, updated_at DESC LIMIT ?`,
  ).all(w, w, w, limit) as Row[]).map(toTask);
}

export function tasksOfJob(parentTaskId: string): PeopleTask[] {
  return (getDb().prepare("SELECT * FROM people_tasks WHERE parent_task_id = ? ORDER BY created_at").all(parentTaskId) as Row[]).map(toTask);
}

const eth = (wei: bigint) => formatEth(wei);

/** What anybody sees of a task: never its owner, never a proof, a person only as a short wallet. */
export function publicView(t: PeopleTask) {
  const agent = getAgentById(t.agentId);
  return {
    taskId: t.taskId, title: t.title, details: t.details, place: t.place, proof: t.proofKind, checks: t.checks, pay: eth(t.priceWei), payWei: t.priceWei.toString(),
    status: t.hiddenAt ? "hidden" : t.status, paymentLocked: t.lockState === "held" || t.lockState === "paid", takeHours: t.takeHours, deadlineAt: t.deadlineAt, minDone: t.minDone,
    agent: { agentId: t.agentId, name: agent?.name ?? t.agentId }, postedBy: t.postedBy, takenBy: t.takerWallet ? shortAddress(t.takerWallet) : null, createdAt: t.createdAt,
  };
}

/** What the person who holds (or held) the task sees: their own proofs and every answer about them. */
export function takerView(t: PeopleTask, wallet: string) {
  const mine = deliveriesOf(t.taskId).filter((d) => sameAddress(d.wallet, wallet));
  const pay = getDb().prepare("SELECT status, tx_hash FROM people_payouts WHERE task_id = ? AND kind = 'pay' AND wallet = ?").get(t.taskId, wallet.toLowerCase()) as { status: string; tx_hash: string | null } | undefined;
  return {
    ...publicView(t), yours: sameAddress(t.takerWallet, wallet), takeUntil: sameAddress(t.takerWallet, wallet) ? t.takeUntil : null, tries: sameAddress(t.takerWallet, wallet) ? t.tries : null,
    triesLeft: sameAddress(t.takerWallet, wallet) ? Math.max(0, PEOPLE.triesPerTaker - t.tries) : 0, secondLookAsked: sameAddress(t.takerWallet, wallet) && t.secondLook, reviewUntil: sameAddress(t.takerWallet, wallet) ? t.reviewUntil : null,
    deliveries: mine.map((d) => ({ tryNo: d.tryNo, answer: d.answer, file: d.fileId ? { sha256: d.fileSha256, type: d.fileMime } : null, verdict: d.verdict, reason: d.verdictReason, failedCheck: d.failedCheck === null ? null : t.checks[d.failedCheck] ?? null, by: d.verdictBy, at: d.createdAt })),
    payout: pay ? { status: pay.status, txHash: pay.tx_hash } : null,
    log: eventsOf(t.taskId).map((e) => ({ ...e, wallet: e.wallet ? shortAddress(e.wallet) : null })),
  };
}

/** What the owner sees: everything, with each proof to open and the log. */
export function ownerView(t: PeopleTask) {
  const pays = getDb().prepare("SELECT kind, wallet, amount_wei, status, tx_hash, error FROM people_payouts WHERE task_id = ? ORDER BY created_at").all(t.taskId) as Row[];
  return {
    ...publicView(t), status: t.status, hidden: t.hiddenAt ? t.hiddenReason : null, funding: t.funding, fundingTx: t.fundingTx, lock: t.lockState, approvalId: t.approvalId,
    parentTaskId: t.parentTaskId, businessId: t.businessId, takerWallet: t.takerWallet, takeUntil: t.takeUntil, tries: t.tries, reviewUntil: t.reviewUntil, secondLook: t.secondLook,
    closeReason: t.closeReason, closedAt: t.closedAt,
    deliveries: deliveriesOf(t.taskId).map((d) => ({
      deliveryId: d.deliveryId, wallet: shortAddress(d.wallet), tryNo: d.tryNo, answer: d.answer,
      file: d.fileId ? { sha256: d.fileSha256, type: d.fileMime, url: `/api/people/${t.taskId}/proof?delivery=${d.deliveryId}` } : null,
      verdict: d.verdict, reason: d.verdictReason, failedCheck: d.failedCheck === null ? null : t.checks[d.failedCheck] ?? null, by: d.verdictBy, checkCostUsd: d.checkCostUsd, at: d.createdAt,
    })),
    payouts: pays.map((p) => ({ kind: String(p.kind), wallet: shortAddress(p.wallet), amount: eth(big(p.amount_wei)), status: String(p.status), txHash: str(p.tx_hash) })),
    log: eventsOf(t.taskId).map((e) => ({ ...e, wallet: e.wallet ? shortAddress(e.wallet) : null })),
  };
}

/** A price given as text in ETH, as wei. */
export const priceWei = (v: unknown): bigint | null => (typeof v === "string" || typeof v === "number" ? toWei(String(v).replace(/\s*eth$/i, "")) : null);
