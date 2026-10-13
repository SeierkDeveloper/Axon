// What the paid node may cost in a day.
//
// A dedicated node (Alchemy) is billed in compute units against a monthly allowance, and that allowance is not
// Axon's alone. So the paid node is only ever a second choice (the public node is asked first and the paid one
// steps in when it refuses), and it has a daily allowance of its own: once today's units are counted out, the paid
// node is left alone until midnight UTC and the public node carries on by itself, exactly as before there was a
// paid node at all. The count lives in the database, so the site and the worker share it and a restart does not
// hand out a second allowance.
//
// The allowance is also made to last the day. First come, first served, it was gone by the middle of the day and
// nothing was left when a payment had to be sent in the evening. So:
//
//   reads    are given the allowance by the hour: by the end of hour h (UTC) they may have used (h + 1) / 24 of
//            what is theirs. What an hour does not use is there for the next.
//   sending  a transaction (the send itself, and the few calls a send cannot be made without) has a part of the
//            allowance held back for it that reads never touch, and is never made to wait for its hour.

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

/** The calls a transaction cannot be sent without: its nonce, its gas and price, the send, and its receipt. */
const SENDING = new Set(["eth_sendRawTransaction", "eth_estimateGas", "eth_getTransactionCount", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_gasPrice", "eth_getTransactionReceipt"]);
export const isSending = (method: string): boolean => SENDING.has(method);

/** The part of the day's allowance held back for sending transactions, in percent. AXON_RPC_SEND_RESERVE_PCT, 25 when not set. */
export function sendReservePct(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AXON_RPC_SEND_RESERVE_PCT?.trim();
  const n = raw ? Number(raw) : 25;
  return Number.isFinite(n) && n >= 0 && n <= 90 ? Math.floor(n) : 25;
}

/** Whether reads are given the allowance by the hour. AXON_RPC_SPREAD=off: first come, first served, as it was. */
export function spreadOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AXON_RPC_SPREAD ?? "").trim().toLowerCase() !== "off";
}

/** What reads may have used of the paid node by this moment of the day. */
export function readsAllowedBy(nowMs: number, allowance: number, env: NodeJS.ProcessEnv = process.env): number {
  const forReads = allowance - Math.floor((allowance * sendReservePct(env)) / 100);
  if (!spreadOn(env)) return forReads;
  return Math.floor((forReads * (new Date(nowMs).getUTCHours() + 1)) / 24);
}

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
const mem = { day: "", units: 0, calls: 0, sendUnits: 0, methods: new Map<string, { units: number; calls: number }>() };
let saidSpentFor = "";
let saidWaitFor = "";

async function db() {
  const { getDb } = await import("./db");
  return getDb();
}

export interface PaidNodeSpend {
  day: string;
  units: number;
  calls: number;
  allowance: number;
  /** of `units`: what went on sending transactions, and what on reads */
  sendUnits: number;
  readUnits: number;
}

/** Today's count by the kind of call, dearest first. */
export async function spentByMethod(nowMs = Date.now()): Promise<{ method: string; units: number; calls: number }[]> {
  const day = dayOf(nowMs);
  try {
    return (await db()).prepare("SELECT method, units, calls FROM rpc_budget_methods WHERE day = ? ORDER BY units DESC").all(day) as { method: string; units: number; calls: number }[];
  } catch {
    return mem.day === day ? [...mem.methods].map(([method, m]) => ({ method, ...m })).sort((a, b) => b.units - a.units) : [];
  }
}

/** What has been counted against the paid node today. */
export async function spentToday(nowMs = Date.now()): Promise<PaidNodeSpend> {
  const day = dayOf(nowMs);
  const allowance = dailyUnits();
  try {
    const d = await db();
    const row = d.prepare("SELECT units, calls FROM rpc_budget WHERE day = ?").get(day) as { units: number; calls: number } | undefined;
    const units = row?.units ?? 0;
    // The split by method came later than the total. A day counted before it has all of its units as reads; and
    // were the split ever not to be read, the day's total above still stands and still stops the paid node.
    let sent = mem.day === day ? mem.sendUnits : 0;
    try {
      sent = (d.prepare(`SELECT COALESCE(SUM(units), 0) AS n FROM rpc_budget_methods WHERE day = ? AND method IN (${[...SENDING].map(() => "?").join(", ")})`).get(day, ...SENDING) as { n: number }).n;
    } catch {
      // the count in memory stands in for the split
    }
    const sendUnits = Math.min(units, sent);
    return { day, units, calls: row?.calls ?? 0, allowance, sendUnits, readUnits: units - sendUnits };
  } catch {
    return mem.day === day ? { day, units: mem.units, calls: mem.calls, allowance, sendUnits: mem.sendUnits, readUnits: mem.units - mem.sendUnits } : { day, units: 0, calls: 0, allowance, sendUnits: 0, readUnits: 0 };
  }
}

/** Is there room in today's allowance for one more call of this kind? */
export async function mayUsePaidNode(method: string, nowMs = Date.now()): Promise<boolean> {
  const spend = await spentToday(nowMs);
  const cost = unitsFor(method);
  if (spend.units + cost <= spend.allowance) {
    // inside the day's allowance. Sending is never made to wait; a read waits for its hour
    if (isSending(method) || spend.readUnits + cost <= readsAllowedBy(nowMs, spend.allowance)) return true;
    const hour = `${spend.day} ${new Date(nowMs).getUTCHours()}`;
    if (saidWaitFor !== hour) {
      saidWaitFor = hour;
      logger.info("rpc.paid_reads_wait", "Reads have used the paid chain node's share for this hour: the public node carries them until the next, and sending is not held up", { readUnits: spend.readUnits, allowedBy: readsAllowedBy(nowMs, spend.allowance), allowance: spend.allowance });
    }
    return false;
  }
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
  if (mem.day !== day) Object.assign(mem, { day, units: 0, calls: 0, sendUnits: 0, methods: new Map() });
  mem.units += units;
  mem.calls += 1;
  if (isSending(method)) mem.sendUnits += units;
  const m = mem.methods.get(method) ?? { units: 0, calls: 0 };
  mem.methods.set(method, { units: m.units + units, calls: m.calls + 1 });
  try {
    const d = await db();
    d.prepare("INSERT INTO rpc_budget (day, units, calls) VALUES (?, ?, 1) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units, calls = calls + 1").run(day, units);
    try {
      d.prepare("INSERT INTO rpc_budget_methods (day, method, units, calls) VALUES (?, ?, ?, 1) ON CONFLICT(day, method) DO UPDATE SET units = units + excluded.units, calls = calls + 1").run(day, method, units);
    } catch {
      // the total is counted, which is what the allowance rests on; the split is kept in memory
    }
  } catch {
    // the count in memory stands in
  }
}

/** For the tests: today starts again. */
export async function resetRpcBudget(): Promise<void> {
  Object.assign(mem, { day: "", units: 0, calls: 0, sendUnits: 0, methods: new Map() });
  saidSpentFor = "";
  saidWaitFor = "";
  try {
    const d = await db();
    d.prepare("DELETE FROM rpc_budget").run();
    d.prepare("DELETE FROM rpc_budget_methods").run();
  } catch {
    // nothing kept
  }
}
