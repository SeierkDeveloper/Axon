// Retainers: creating them, reading them, and the owner's controls.
//
// The runner that actually hires on schedule is separate (retainerRunner.ts). Everything here is the
// record: what the owner asked for, whether it is running, and when it runs next. Every change is
// owner-only: a retainer id alone never lets anyone touch someone else's schedule.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { normalizeAddress, sameAddress } from "./address";
import { getAgentById } from "./agents";
import { parsePaymentAmount } from "./money";
import { getTier } from "./holderTier";
import {
  retainerInputError,
  scheduleError,
  type RetainerInput,
  type RetainerStatus,
  type PauseReason,
  type PayIn,
  type Schedule,
} from "./retainerPolicy";
import { nextSlot } from "./retainerSchedule";
import { SKIP_REASON_TEXT, retainerPriceWei, type SkipReason, type RunOutcome } from "./retainerPolicy";
import type { Agent } from "@/sdk/types";

export interface Retainer {
  retainerId: string;
  ownerWallet: string;
  agentId: string;
  instructions: string;
  schedule: Schedule;
  payIn: PayIn;
  maxPriceWei: bigint;
  endsAt: string | null;
  maxRuns: number | null;
  status: RetainerStatus;
  pauseReason: PauseReason | null;
  consecutiveFailures: number;
  runsDone: number;
  anchorAt: string;
  nextRunAt: string | null;
  apiKeyId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RetainerRow {
  retainer_id: string;
  owner_wallet: string;
  agent_id: string;
  instructions: string;
  schedule: string;
  pay_in: string;
  max_price_wei: string;
  ends_at: string | null;
  max_runs: number | null;
  status: string;
  pause_reason: string | null;
  consecutive_failures: number;
  runs_done: number;
  anchor_at: string;
  next_run_at: string | null;
  api_key_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRetainer(r: RetainerRow): Retainer {
  return {
    retainerId: r.retainer_id,
    ownerWallet: r.owner_wallet,
    agentId: r.agent_id,
    instructions: r.instructions,
    schedule: JSON.parse(r.schedule) as Schedule,
    payIn: r.pay_in as PayIn,
    maxPriceWei: BigInt(r.max_price_wei),
    endsAt: r.ends_at,
    maxRuns: r.max_runs,
    status: r.status as RetainerStatus,
    pauseReason: r.pause_reason as PauseReason | null,
    consecutiveFailures: r.consecutive_failures,
    runsDone: r.runs_done,
    anchorAt: r.anchor_at,
    nextRunAt: r.next_run_at,
    apiKeyId: r.api_key_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A retainer as the API returns it: amounts as strings, since JSON has no bigint. */
export function retainerJson(r: Retainer) {
  return { ...r, maxPriceWei: r.maxPriceWei.toString() };
}

export class RetainerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Only the fields a schedule may carry, so stray keys in a request never reach the database. */
function cleanSchedule(s: Schedule): Schedule {
  if (s.kind === "interval") return { kind: "interval", everyHours: s.everyHours };
  if (s.kind === "daily") return { kind: "daily", time: s.time, timeZone: s.timeZone };
  return { kind: "weekly", day: s.day, time: s.time, timeZone: s.timeZone };
}

/** An agent that was removed, or whose endpoint the health check says stopped answering. */
export function agentUnavailable(agentId: string): boolean {
  const agent = getAgentById(agentId);
  return !agent || agent.verificationStatus === "unreachable";
}

export function countActiveRetainers(wallet: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM retainers WHERE owner_wallet = ? AND status IN ('active', 'paused')`)
    .get(normalizeAddress(wallet) ?? wallet.toLowerCase()) as { n: number };
  return row.n;
}

/** What one run of this agent costs on a retainer now: its price less its retainer discount. */
export function runPriceWei(agent: Pick<Agent, "price" | "retainerDiscountBps">): bigint | null {
  const list = agent.price ? parsePaymentAmount(agent.price)?.wei ?? null : null;
  return list === null ? null : retainerPriceWei(list, agent.retainerDiscountBps ?? 0);
}

/**
 * Create a retainer for a wallet. Validated against the policy with the agent's price and the wallet's
 * holder tier as they are right now. Paused retainers count toward the tier's limit: pausing is not a
 * way around it.
 */
export async function createRetainer(
  ownerWallet: string,
  input: RetainerInput,
  opts: { apiKeyId?: string | null; nowMs?: number } = {},
): Promise<Retainer> {
  const owner = normalizeAddress(ownerWallet);
  if (!owner) throw new RetainerError("A wallet is needed");
  const nowMs = opts.nowMs ?? Date.now();

  const agent = getAgentById(input.agentId);
  if (!agent) throw new RetainerError("That agent does not exist", 404);
  if (agentUnavailable(agent.agentId)) throw new RetainerError("That agent is not answering right now");

  const priceWei = runPriceWei(agent);
  const tier = (await getTier(owner)).tier.name;
  const problem = retainerInputError(input, {
    agentPriceWei: priceWei,
    agentAcceptsAxon: Boolean(agent.acceptsAxon),
    tier,
    activeRetainers: countActiveRetainers(owner),
    nowMs,
  });
  if (problem) throw new RetainerError(problem);

  const schedule = cleanSchedule(input.schedule);
  const now = iso(nowMs);
  const retainerId = `ret_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  getDb()
    .prepare(
      `INSERT INTO retainers (retainer_id, owner_wallet, agent_id, instructions, schedule, pay_in, max_price_wei,
         ends_at, max_runs, status, anchor_at, next_run_at, api_key_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .run(
      retainerId,
      owner,
      agent.agentId,
      input.instructions.trim(),
      JSON.stringify(schedule),
      input.payIn,
      input.maxPriceWei.toString(),
      input.endsAt != null ? iso(input.endsAt) : null,
      input.maxRuns ?? null,
      now,
      iso(nextSlot(schedule, nowMs, nowMs)),
      opts.apiKeyId ?? null,
      now,
      now,
    );
  void syncToTurso();
  return getRetainer(retainerId)!;
}

export function getRetainer(retainerId: string): Retainer | null {
  const row = getDb().prepare(`SELECT * FROM retainers WHERE retainer_id = ?`).get(retainerId) as RetainerRow | undefined;
  return row ? toRetainer(row) : null;
}

/** A wallet's retainers, newest first. Ended and cancelled ones stay listed for their history. */
export function listRetainers(ownerWallet: string): Retainer[] {
  const owner = normalizeAddress(ownerWallet) ?? ownerWallet.toLowerCase();
  const rows = getDb()
    .prepare(`SELECT * FROM retainers WHERE owner_wallet = ? ORDER BY created_at DESC`)
    .all(owner) as RetainerRow[];
  return rows.map(toRetainer);
}

/** The retainer, if this wallet owns it. Someone else's id reads as not found, never as forbidden. */
function owned(retainerId: string, wallet: string): Retainer {
  const r = getRetainer(retainerId);
  if (!r || !sameAddress(r.ownerWallet, wallet)) throw new RetainerError("Retainer not found", 404);
  return r;
}

function update(retainerId: string, fields: Record<string, string | number | null>, nowMs: number) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE retainers SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE retainer_id = ?`)
    .run(...keys.map((k) => fields[k]), iso(nowMs), retainerId);
  void syncToTurso();
}

export function pauseRetainer(retainerId: string, wallet: string, nowMs = Date.now()): Retainer {
  const r = owned(retainerId, wallet);
  if (r.status !== "active") throw new RetainerError(`This retainer is ${r.status}`);
  update(retainerId, { status: "paused", pause_reason: "owner" }, nowMs);
  return getRetainer(retainerId)!;
}

/**
 * Resume from any pause, including one the retainer put itself in. The failure count starts over, and
 * the next run is the next slot from now: nothing that fell due while paused is made up.
 */
export function resumeRetainer(retainerId: string, wallet: string, nowMs = Date.now()): Retainer {
  const r = owned(retainerId, wallet);
  if (r.status !== "paused") throw new RetainerError(`This retainer is ${r.status}`);
  if (agentUnavailable(r.agentId)) throw new RetainerError("The agent is still not answering");
  if (r.endsAt && Date.parse(r.endsAt) <= nowMs) throw new RetainerError("This retainer's end date has passed");
  update(
    retainerId,
    {
      status: "active",
      pause_reason: null,
      consecutive_failures: 0,
      next_run_at: iso(nextSlot(r.schedule, Date.parse(r.anchorAt), nowMs)),
      // Resuming after its key was revoked is the owner choosing to carry on without that key: from
      // here the runs answer to the allowance's own limits, as any retainer the owner made directly.
      // The key is gone or expired: from here the retainer runs on the owner's own allowance.
      ...(r.pauseReason === "key_revoked" || r.pauseReason === "key_expired" ? { api_key_id: null } : {}),
    },
    nowMs,
  );
  return getRetainer(retainerId)!;
}

/** Final. A cancelled retainer never runs again; its history stays readable. */
export function cancelRetainer(retainerId: string, wallet: string, nowMs = Date.now()): Retainer {
  const r = owned(retainerId, wallet);
  if (r.status === "cancelled" || r.status === "ended") throw new RetainerError(`This retainer is already ${r.status}`);
  update(retainerId, { status: "cancelled", pause_reason: null, next_run_at: null }, nowMs);
  return getRetainer(retainerId)!;
}

/**
 * Change what a retainer does or when, without losing its history. The same checks as creating one,
 * except the count: it is already one of the owner's retainers.
 */
export async function editRetainer(
  retainerId: string,
  wallet: string,
  changes: Partial<Pick<RetainerInput, "instructions" | "schedule" | "maxPriceWei" | "endsAt" | "maxRuns" | "payIn">>,
  nowMs = Date.now(),
): Promise<Retainer> {
  const r = owned(retainerId, wallet);
  if (r.status === "cancelled" || r.status === "ended") throw new RetainerError(`This retainer is ${r.status}`);
  if (changes.schedule && scheduleError(changes.schedule)) throw new RetainerError(scheduleError(changes.schedule)!);
  const agent = getAgentById(r.agentId);
  const next: RetainerInput = {
    agentId: r.agentId,
    instructions: changes.instructions ?? r.instructions,
    schedule: changes.schedule ? cleanSchedule(changes.schedule) : r.schedule,
    payIn: changes.payIn ?? r.payIn,
    maxPriceWei: changes.maxPriceWei ?? r.maxPriceWei,
    endsAt: changes.endsAt !== undefined ? changes.endsAt : r.endsAt ? Date.parse(r.endsAt) : null,
    maxRuns: changes.maxRuns !== undefined ? changes.maxRuns : r.maxRuns,
  };
  const problem = retainerInputError(next, {
    agentPriceWei: agent ? runPriceWei(agent) : null,
    agentAcceptsAxon: Boolean(agent?.acceptsAxon),
    tier: (await getTier(r.ownerWallet)).tier.name,
    activeRetainers: 0,
    nowMs,
  });
  if (problem) throw new RetainerError(problem);

  const scheduleChanged = changes.schedule !== undefined;
  update(
    retainerId,
    {
      instructions: next.instructions.trim(),
      schedule: JSON.stringify(next.schedule),
      pay_in: next.payIn,
      max_price_wei: next.maxPriceWei.toString(),
      ends_at: next.endsAt != null ? iso(next.endsAt) : null,
      max_runs: next.maxRuns ?? null,
      // A new schedule starts its rhythm now; anything else keeps the slot it had.
      ...(scheduleChanged && r.status === "active"
        ? { anchor_at: iso(nowMs), next_run_at: iso(nextSlot(next.schedule, nowMs, nowMs + 60_000)) }
        : {}),
    },
    nowMs,
  );
  return getRetainer(retainerId)!;
}

// ── Runs ──────────────────────────────────────────────────────────────────────

const SITE = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://axon-agents.com").replace(/\/$/, "");
/** Where a run's receipt can be read: the same receipt every hire gets. */
export const receiptUrl = (taskId: string) => `${SITE}/api/receipts/${taskId}`;

export interface RetainerRun {
  runId: string;
  scheduledFor: string;
  /** pending and running are in flight; the rest are final. */
  status: "pending" | "running" | RunOutcome;
  skipReason: SkipReason | null;
  /** What happened, in the words the dashboard shows, when it did not complete. */
  message: string | null;
  taskId: string | null;
  priceWei: string | null;
  /** The agent's answer, once the run completed. */
  output: string | null;
  receiptUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}

interface RunRow {
  run_id: string;
  scheduled_for: string;
  status: string;
  skip_reason: string | null;
  error: string | null;
  task_id: string | null;
  price_wei: string | null;
  created_at: string;
  finished_at: string | null;
  output: string | null;
}

function toRun(row: RunRow): RetainerRun {
  const skip = row.skip_reason as SkipReason | null;
  return {
    runId: row.run_id,
    scheduledFor: row.scheduled_for,
    status: row.status as RetainerRun["status"],
    skipReason: skip,
    message: row.error ?? (skip ? SKIP_REASON_TEXT[skip] : null),
    taskId: row.task_id,
    priceWei: row.price_wei,
    output: row.status === "completed" ? row.output : null,
    receiptUrl: row.task_id ? receiptUrl(row.task_id) : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

const RUN_SELECT = `
  SELECT r.run_id, r.scheduled_for, r.status, r.skip_reason, r.error, r.task_id, r.price_wei, r.created_at,
         r.finished_at, t.output
  FROM retainer_runs r LEFT JOIN tasks t ON t.task_id = r.task_id`;

/**
 * A retainer's runs, newest first, with each completed run's output. Owner-only. `before` pages back
 * through older runs by their scheduled time.
 */
export function listRetainerRuns(retainerId: string, wallet: string, opts: { limit?: number; before?: string } = {}): RetainerRun[] {
  owned(retainerId, wallet);
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
  const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? new Date(opts.before).toISOString() : null;
  const rows = getDb()
    .prepare(`${RUN_SELECT} WHERE r.retainer_id = ? ${before ? "AND r.scheduled_for < ?" : ""} ORDER BY r.scheduled_for DESC LIMIT ?`)
    .all(...(before ? [retainerId, before, limit] : [retainerId, limit])) as RunRow[];
  return rows.map(toRun);
}

/** The newest completed run, the answer an owner opens a retainer to read. Owner-only. */
export function latestRetainerResult(retainerId: string, wallet: string): RetainerRun | null {
  owned(retainerId, wallet);
  const row = getDb()
    .prepare(`${RUN_SELECT} WHERE r.retainer_id = ? AND r.status = 'completed' ORDER BY r.scheduled_for DESC LIMIT 1`)
    .get(retainerId) as RunRow | undefined;
  return row ? toRun(row) : null;
}
