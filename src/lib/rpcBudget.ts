// What the paid node may cost in a day.
//
// A dedicated node (Alchemy) is billed in compute units against a monthly allowance, and that allowance is not
// Axon's alone. So the paid node is only ever a second choice (the public node is asked first and the paid one
// steps in when it refuses), and it has a daily allowance of its own: once today's units are counted out, the paid
// node is left alone until midnight UTC and the public node carries on by itself, exactly as before there was a
// paid node at all. The count lives in the database, so the site and the worker share it and a restart does not
// hand out a second allowance.

import { RPC_URL } from "./chain";
import { logger } from "./logger";

/**
 * What a call costs, by method. Where the provider's price list has changed over time the higher figure is used,
 * so Axon's count runs ahead of the bill and never behind it.
 */
const UNITS: Record<string, number> = {
  eth_chainId: 0,
  net_version: 0,
  eth_blockNumber: 10,
  eth_feeHistory: 10,
  eth_maxPriorityFeePerGas: 10,
  eth_getBalance: 20,
  eth_getCode: 20,
  eth_gasPrice: 20,
  eth_getBlockByNumber: 20,
  eth_getBlockByHash: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionReceipt: 20,
  eth_getStorageAt: 20,
  eth_call: 26,
  eth_getTransactionCount: 26,
  eth_getLogs: 75,
  eth_estimateGas: 87,
  eth_sendRawTransaction: 250,
};
/** A method not in the list is counted as a dear one. */
const OTHER_UNITS = 100;

/** About 12 million units over a 31-day month when every day is spent to the end. */
export const DEFAULT_DAILY_UNITS = 400_000;

/** Today's allowance for the paid node. AXON_RPC_DAILY_UNITS=0 turns the paid node off without removing its address. */
export function dailyUnits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AXON_RPC_DAILY_UNITS?.trim();
  if (!raw) return DEFAULT_DAILY_UNITS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_UNITS;
}

/** Every node but the chain's own public one is somebody's bill. */
export function isPaidNode(url: string): boolean {
  return url !== RPC_URL;
}

export function unitsFor(method: string): number {
  return UNITS[method] ?? OTHER_UNITS;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Kept beside the database count for the one case the database cannot be reached (a script, a broken volume): the
// allowance still holds for this process.
const mem = { day: "", units: 0, calls: 0 };
let saidSpentFor = "";

async function db() {
  const { getDb } = await import("./db");
  return getDb();
}

export interface PaidNodeSpend {
  day: string;
  units: number;
  calls: number;
  allowance: number;
}

/** What has been counted against the paid node today. */
export async function spentToday(nowMs = Date.now()): Promise<PaidNodeSpend> {
  const day = dayOf(nowMs);
  const allowance = dailyUnits();
  try {
    const row = (await db()).prepare("SELECT units, calls FROM rpc_budget WHERE day = ?").get(day) as { units: number; calls: number } | undefined;
    return { day, units: row?.units ?? 0, calls: row?.calls ?? 0, allowance };
  } catch {
    return mem.day === day ? { day, units: mem.units, calls: mem.calls, allowance } : { day, units: 0, calls: 0, allowance };
  }
}

/** Is there room in today's allowance for one more call of this kind? */
export async function mayUsePaidNode(method: string, nowMs = Date.now()): Promise<boolean> {
  const spend = await spentToday(nowMs);
  if (spend.units + unitsFor(method) <= spend.allowance) return true;
  if (saidSpentFor !== spend.day) {
    saidSpentFor = spend.day;
    logger.warn("rpc.paid_allowance_spent", "The paid chain node's allowance for today is spent: the public node carries on alone until midnight UTC", { units: spend.units, allowance: spend.allowance, calls: spend.calls });
  }
  return false;
}

/** Count one call against today, before it is sent: a call that fails at the provider is still billed. */
export async function countPaidCall(method: string, nowMs = Date.now()): Promise<void> {
  const day = dayOf(nowMs);
  const units = unitsFor(method);
  if (mem.day !== day) Object.assign(mem, { day, units: 0, calls: 0 });
  mem.units += units;
  mem.calls += 1;
  try {
    (await db())
      .prepare("INSERT INTO rpc_budget (day, units, calls) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units, calls = calls + 1")
      .run(day, units);
  } catch {
    // the count in memory stands in
  }
}

/** For the tests: today starts again. */
export async function resetRpcBudget(): Promise<void> {
  Object.assign(mem, { day: "", units: 0, calls: 0 });
  saidSpentFor = "";
  try {
    (await db()).prepare("DELETE FROM rpc_budget").run();
  } catch {
    // nothing kept
  }
}
