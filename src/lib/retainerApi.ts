// What the retainer routes share: reading a request body into a retainer, and writing one back out.
//
// Amounts cross the API as ETH decimal strings ("0.0002"), never as wei numbers, the same way the
// allowance routes take them: JSON numbers lose precision, and a person reads ETH, not wei.
//
// Who may do what:
//   a full key       everything, on every retainer its wallet owns
//   an allowance key create, and read or control only the retainers it created itself; its limits
//                    apply to every run of those. It cannot set a webhook: a leaked assistant key
//                    must not be able to send results somewhere else.

import { NextResponse } from "next/server";
import { apiError } from "./apiError";
import type { AuthenticatedUser } from "./identity";
import { decimalToWei, weiToDecimalString, parsePaymentAmount } from "./money";
import { getAgentById } from "./agents";
import { getKeyLimits } from "./allowanceKeys";
import { getRetainer, latestRetainerResult, countActiveRetainers, runPriceWei, RetainerError, type Retainer, type RetainerRun } from "./retainers";
import { getDb } from "./db";
import { getTier, tiers } from "./holderTier";
import { describeSchedule } from "./retainerSchedule";
import { retainerWebhookStatus } from "./retainerWebhooks";
import {
  defaultMaxPriceWei,
  maxDailySpendWei,
  PAUSE_REASON_TEXT,
  RETAINERS_BY_TIER,
  type RetainerInput,
  type Schedule,
  type PayIn,
} from "./retainerPolicy";

type Parsed<T> = { ok: true; value: T } | { ok: false; response: NextResponse };
const bad = (message: string): { ok: false; response: NextResponse } => ({ ok: false, response: apiError("VALIDATION_ERROR", message, 400) });

const eth = (wei: bigint) => weiToDecimalString(wei);

function readEth(raw: unknown, field: string): Parsed<bigint> {
  const wei = typeof raw === "string" ? decimalToWei(raw) : null;
  if (wei === null || wei <= 0n) return bad(`${field} must be an ETH amount like "0.0002"`);
  return { ok: true, value: wei };
}

function readEndsAt(raw: unknown): Parsed<number | null> {
  if (raw === null) return { ok: true, value: null };
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) return bad("endsAt must be a date like 2026-12-31T00:00:00Z");
  return { ok: true, value: ms };
}

/** The schedule as sent. Shape only; the policy checks the values. */
function readSchedule(raw: unknown): Parsed<Schedule> {
  if (!raw || typeof raw !== "object") return bad("schedule is required");
  const s = raw as Record<string, unknown>;
  if (s.kind === "interval") return { ok: true, value: { kind: "interval", everyHours: Number(s.everyHours) } };
  if (s.kind === "daily") return { ok: true, value: { kind: "daily", time: String(s.time ?? ""), timeZone: String(s.timeZone ?? "UTC") } };
  if (s.kind === "weekly") return { ok: true, value: { kind: "weekly", day: Number(s.day), time: String(s.time ?? ""), timeZone: String(s.timeZone ?? "UTC") } };
  return bad("schedule.kind must be interval, daily or weekly");
}

/** A create request. maxPrice defaults to a quarter above the agent's current price. */
export function readCreate(raw: Record<string, unknown>): Parsed<RetainerInput> {
  if (typeof raw.agentId !== "string" || !raw.agentId) return bad("agentId is required");
  if (typeof raw.instructions !== "string") return bad("instructions is required");
  const schedule = readSchedule(raw.schedule);
  if (!schedule.ok) return schedule;
  const payIn = (raw.payIn ?? "ETH") as PayIn;
  if (payIn !== "ETH" && payIn !== "AXON") return bad('payIn must be "ETH" or "AXON"');

  let maxPriceWei: bigint;
  if (raw.maxPrice !== undefined) {
    const p = readEth(raw.maxPrice, "maxPrice");
    if (!p.ok) return p;
    maxPriceWei = p.value;
  } else {
    const agent = getAgentById(raw.agentId);
    const price = agent?.price ? parsePaymentAmount(agent.price)?.wei ?? null : null;
    // Unpriced or missing agents are refused by the policy with a clearer reason than any here.
    maxPriceWei = price ? defaultMaxPriceWei(price) : 1n;
  }

  let endsAt: number | null = null;
  if (raw.endsAt !== undefined) {
    const e = readEndsAt(raw.endsAt);
    if (!e.ok) return e;
    endsAt = e.value;
  }
  if (raw.maxRuns !== undefined && raw.maxRuns !== null && typeof raw.maxRuns !== "number") return bad("maxRuns must be a number");
  return {
    ok: true,
    value: { agentId: raw.agentId, instructions: raw.instructions, schedule: schedule.value, payIn, maxPriceWei, endsAt, maxRuns: (raw.maxRuns as number | null | undefined) ?? null },
  };
}

type Edit = Partial<Pick<RetainerInput, "instructions" | "schedule" | "maxPriceWei" | "endsAt" | "maxRuns" | "payIn">>;

/** An edit request: only the fields present change. */
export function readEdit(raw: Record<string, unknown>): Parsed<Edit> {
  const out: Edit = {};
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions !== "string") return bad("instructions must be text");
    out.instructions = raw.instructions;
  }
  if (raw.schedule !== undefined) {
    const s = readSchedule(raw.schedule);
    if (!s.ok) return s;
    out.schedule = s.value;
  }
  if (raw.maxPrice !== undefined) {
    const p = readEth(raw.maxPrice, "maxPrice");
    if (!p.ok) return p;
    out.maxPriceWei = p.value;
  }
  if (raw.endsAt !== undefined) {
    const e = readEndsAt(raw.endsAt);
    if (!e.ok) return e;
    out.endsAt = e.value;
  }
  if (raw.maxRuns !== undefined) {
    if (raw.maxRuns !== null && typeof raw.maxRuns !== "number") return bad("maxRuns must be a number or null");
    out.maxRuns = raw.maxRuns as number | null;
  }
  if (raw.payIn !== undefined) {
    if (raw.payIn !== "ETH" && raw.payIn !== "AXON") return bad('payIn must be "ETH" or "AXON"');
    out.payIn = raw.payIn;
  }
  if (Object.keys(out).length === 0) return bad("Nothing to change");
  return { ok: true, value: out };
}

/**
 * An allowance key's own early checks, so an assistant hears "not on this key's list" when it sets a
 * retainer up rather than from its first refused run. The key's limits still apply to every run.
 */
export function keyCreateError(user: AuthenticatedUser, input: RetainerInput): string | null {
  if (user.scope !== "allowance") return null;
  const limits = getKeyLimits(user.keyId);
  if (!limits) return "This allowance key has no limits on record";
  if (limits.allowedAgents && !limits.allowedAgents.includes(input.agentId)) return "This agent is not on this key's allowed list";
  if (input.maxPriceWei > limits.maxPerTaskWei) {
    return `The maximum price is over this key's per-task limit of ${eth(limits.maxPerTaskWei)} ETH`;
  }
  return null;
}

/**
 * The retainer, if this caller may see it. A full key sees its wallet's; an allowance key sees only
 * those it created. Anything else reads as not found, never as forbidden.
 */
export function visibleRetainer(user: AuthenticatedUser, retainerId: string): Retainer | null {
  const r = getRetainer(retainerId);
  if (!r) return null;
  if (r.ownerWallet.toLowerCase() !== user.walletAddress.toLowerCase()) return null;
  if (user.scope === "allowance" && r.apiKeyId !== user.keyId) return null;
  return r;
}

export const notFound = () => apiError("NOT_FOUND", "Retainer not found", 404);

export function retainerErrorResponse(err: unknown): NextResponse {
  if (err instanceof RetainerError) {
    return apiError(err.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", err.message, err.status);
  }
  throw err;
}

/** A retainer as the API returns it: in ETH and in words, never the webhook secret. */
export function retainerView(r: Retainer, opts: { withLatest?: boolean } = {}) {
  const view = {
    retainerId: r.retainerId,
    agentId: r.agentId,
    instructions: r.instructions,
    schedule: r.schedule,
    scheduleText: describeSchedule(r.schedule),
    payIn: r.payIn,
    maxPrice: eth(r.maxPriceWei),
    // What a run costs at the agent's price today, after any retainer discount it offers.
    pricePerRun: (() => {
      const agent = getAgentById(r.agentId);
      const wei = agent ? runPriceWei(agent) : null;
      return wei === null ? null : eth(wei);
    })(),
    // The most this schedule can spend in a day at its maximum price, to compare with the allowance.
    maxPerDay: eth(maxDailySpendWei(r.schedule, r.maxPriceWei)),
    status: r.status,
    pauseReason: r.pauseReason,
    pauseText: r.pauseReason ? PAUSE_REASON_TEXT[r.pauseReason] : null,
    consecutiveFailures: r.consecutiveFailures,
    runsDone: r.runsDone,
    maxRuns: r.maxRuns,
    endsAt: r.endsAt,
    nextRunAt: r.nextRunAt,
    createdByKey: r.apiKeyId !== null,
    // A retainer set up by an allowance key pays through that key, so it stops when the key expires.
    keyExpiresAt: r.apiKeyId ? getKeyLimits(r.apiKeyId)?.expiresAt ?? null : null,
    webhook: retainerWebhookStatus(r.retainerId),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  return opts.withLatest ? { ...view, latest: latestRetainerResult(r.retainerId, r.ownerWallet) } : view;
}

export function runView(run: RetainerRun) {
  return { ...run, price: run.priceWei ? eth(BigInt(run.priceWei)) : null, priceWei: undefined };
}

/**
 * What this wallet's tier allows, how much of it is in use, and what the next tier up would add. Paused
 * retainers count, as they do when creating one. `next` is null at the top, and when the next tier would
 * add nothing to retainers.
 */
export async function retainerLimits(wallet: string) {
  const { tier } = await getTier(wallet);
  const mine = RETAINERS_BY_TIER[tier.name];
  const up = tiers().find((t) => t.rank === tier.rank + 1) ?? null;
  const upLimits = up ? RETAINERS_BY_TIER[up.name] : null;
  return {
    tier: tier.name,
    active: mine.active,
    inUse: countActiveRetainers(wallet),
    fastestHours: mine.fastestHours,
    next: up && upLimits ? { tier: up.name, hold: up.minimum, active: upLimits.active, fastestHours: upLimits.fastestHours } : null,
  };
}

/**
 * The agent owner's side: who keeps this agent on a schedule, and what that has been worth. Only what
 * the owner already sees in its tasks (the client's wallet, and when and how often it hires), never a
 * client's instructions as a list or its webhook. Earned counts completed runs over the last 30 days,
 * in ETH at the time of each run, $AXON runs included at their ETH value.
 */
export function agentRetainersView(agentId: string, nowMs = Date.now()) {
  const rows = getDb()
    .prepare(`SELECT retainer_id FROM retainers WHERE agent_id = ? AND status IN ('active', 'paused') ORDER BY created_at`)
    .all(agentId) as { retainer_id: string }[];
  const list = rows.map((x) => getRetainer(x.retainer_id)).filter((r): r is Retainer => r !== null);

  const since = new Date(nowMs - 30 * 86_400_000).toISOString();
  const runs = getDb()
    .prepare(
      `SELECT rr.status, rr.price_wei FROM retainer_runs rr JOIN retainers r ON r.retainer_id = rr.retainer_id
       WHERE r.agent_id = ? AND rr.scheduled_for >= ? AND rr.task_id IS NOT NULL`,
    )
    .all(agentId, since) as { status: string; price_wei: string | null }[];
  const completed = runs.filter((x) => x.status === "completed");
  const earned = completed.reduce((sum, x) => sum + (x.price_wei ? BigInt(x.price_wei) : 0n), 0n);

  return {
    clients: new Set(list.map((r) => r.ownerWallet.toLowerCase())).size,
    active: list.filter((r) => r.status === "active").length,
    paused: list.filter((r) => r.status === "paused").length,
    last30Days: { runs: runs.length, completed: completed.length, earned: eth(earned) },
    retainers: list.map((r) => ({
      client: r.ownerWallet,
      scheduleText: describeSchedule(r.schedule),
      payIn: r.payIn,
      status: r.status,
      runsDone: r.runsDone,
      since: r.createdAt,
      nextRunAt: r.nextRunAt,
    })),
  };
}
