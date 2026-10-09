// Jobs that start themselves, on chain: read the new logs of every contract a trigger watches, and fire it for each.
//
// The worker calls this once a minute. Each trigger remembers the block it has read up to, so nothing is read twice
// and nothing between two ticks is missed. A log is one event: its transaction and its place in it are its key, so a
// tick that is cut short and run again cannot hire twice.
//
// A busy contract cannot drown a trigger or the project: a tick fires at most a handful of new runs for one trigger
// and comes back for the rest, and once a trigger has made its runs for the day what follows is not run, and the
// owner is told so once, not once per log.

import { getDb } from "./db";
import { logger } from "./logger";
import { getLogs, publicClient } from "./evm";
import { EXPLORER } from "./chain";
import { fireTrigger, getTrigger, limitReached, triggersEnabled, TRANSFER_TOPIC, type Trigger, type TriggerEvent } from "./triggers";

/** Blocks behind the head that are left alone, so a log that is fired is one that stays. */
export const CONFIRMATIONS = 2;
/** The widest stretch of chain one trigger reads in one tick. A trigger that fell far behind catches up over a few. */
export const MAX_SPAN = 20_000;
/** New runs one trigger starts in one tick. */
export const MAX_PER_TICK = 5;

export interface ChainLog { address: string; topics: string[]; data: string; blockNumber: string | number; transactionHash: string; logIndex: string | number }
const num = (v: string | number): number => (typeof v === "number" ? v : Number(BigInt(v)));
const addr = (topic: string | undefined): string | null => (topic && /^0x[0-9a-fA-F]{64}$/.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null);

/** A log as one event: its key, a line for the list, and what the agent is told happened. */
export function describeLog(log: ChainLog): TriggerEvent {
  const block = num(log.blockNumber), index = num(log.logIndex), tx = log.transactionHash, contract = log.address.toLowerCase();
  const where = `Contract: ${contract}\nTransaction: ${tx}\nBlock: ${block}\nExplorer: ${EXPLORER}/tx/${tx}`;
  const from = addr(log.topics[1]), to = addr(log.topics[2]);
  if ((log.topics[0] ?? "").toLowerCase() === TRANSFER_TOPIC && from && to) {
    let value = "unknown";
    try { value = BigInt(log.data && log.data !== "0x" ? log.data : "0x0").toString(); } catch { /* an odd token: the raw data is given below */ }
    return {
      key: `${tx}:${index}`,
      summary: `Transfer of ${value} from ${from.slice(0, 8)}… to ${to.slice(0, 8)}…`,
      text: `A token transfer on Robinhood Chain.\nFrom: ${from}\nTo: ${to}\nAmount, in the token's smallest unit: ${value}\n${where}`,
    };
  }
  return {
    key: `${tx}:${index}`,
    summary: `A log from ${contract.slice(0, 10)}… in block ${block}`,
    text: `A contract on Robinhood Chain wrote a log.\n${where}\nTopics: ${log.topics.join(", ") || "none"}\nData: ${(log.data ?? "0x").slice(0, 2000)}`,
  };
}

type ReadLogs = (from: bigint, to: bigint, filter: { address: string; topics?: (string | null)[] }) => Promise<unknown[]>;

/** Read one trigger's new logs and fire it for each. Returns how many runs it started. */
async function watch(t: Trigger, head: number, readLogs: ReadLogs, nowMs: number): Promise<number> {
  const db = getDb();
  if (t.lastBlock === null) {
    // a trigger made or resumed while the chain could not be read: it starts here, at its first reading
    db.prepare("UPDATE triggers SET last_block = ?, updated_at = ? WHERE trigger_id = ? AND last_block IS NULL").run(head, new Date(nowMs).toISOString(), t.triggerId);
    return 0;
  }
  const from = t.lastBlock + 1;
  if (from > head || !t.chainAddress) return 0;
  // A trigger that has made its runs for the day does not read at all: what happens meanwhile is passed over, and
  // the owner is told so once for the day rather than once for every log.
  // one line a day in the owner's list, however many logs go by: its key is the day
  const sayFull = () => fireTrigger(t.triggerId, { key: `limit:${new Date(nowMs).toISOString().slice(0, 10)}`, summary: "More happened on chain than today's runs. What came after was not run.", text: "" }, { nowMs });
  if (limitReached(t, nowMs)) {
    await sayFull();
    db.prepare("UPDATE triggers SET last_block = ?, updated_at = ? WHERE trigger_id = ?").run(head, new Date(nowMs).toISOString(), t.triggerId);
    return 0;
  }
  const to = Math.min(head, from + MAX_SPAN - 1);
  const logs = ((await readLogs(BigInt(from), BigInt(to), { address: t.chainAddress, ...(t.chainTopic0 ? { topics: [t.chainTopic0] } : {}) })) as ChainLog[])
    .filter((l) => l && typeof l.transactionHash === "string" && Array.isArray(l.topics))
    .sort((a, b) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex));

  let started = 0, readTo = to;
  for (const log of logs) {
    if (started >= MAX_PER_TICK) {
      // come back for the rest: read again from this log's block, where what was already fired is known by its key
      readTo = num(log.blockNumber) - 1;
      break;
    }
    // the last run of the day may have just been made by the log before this one
    if (started > 0 && limitReached(getTrigger(t.triggerId) ?? t, nowMs)) {
      await sayFull();
      break;
    }
    const r = await fireTrigger(t.triggerId, describeLog(log), { nowMs });
    if (r.fired) { started++; continue; }
    if (r.reason === "duplicate") continue;
    // Any other refusal (the price moved, the allowance said no, the trigger just paused itself) is recorded on this
    // log, and nothing more is tried this tick: the rest of this stretch is passed over rather than refused one by one.
    break;
  }
  db.prepare("UPDATE triggers SET last_block = ?, updated_at = ? WHERE trigger_id = ? AND (last_block IS NULL OR last_block < ?)").run(Math.max(readTo, from - 1), new Date(nowMs).toISOString(), t.triggerId, Math.max(readTo, from - 1));
  return started;
}

/** One tick: every active chain trigger, read up to the chain's head. Never throws; a trigger that fails is tried again next tick. */
export async function runChainTriggers(o: { nowMs?: number; head?: number; readLogs?: ReadLogs; limit?: number } = {}): Promise<{ watched: number; started: number }> {
  if (!triggersEnabled()) return { watched: 0, started: 0 };
  const ids = getDb().prepare("SELECT trigger_id FROM triggers WHERE kind = 'chain' AND status = 'active' ORDER BY updated_at ASC LIMIT ?").all(o.limit ?? 50) as { trigger_id: string }[];
  if (!ids.length) return { watched: 0, started: 0 };
  const nowMs = o.nowMs ?? Date.now();
  let head: number;
  try {
    head = (o.head ?? Number(await publicClient().getBlockNumber())) - CONFIRMATIONS;
  } catch (err) {
    logger.warn("trigger.chain_unreadable", "The chain's head could not be read; triggers wait for the next tick", { err });
    return { watched: 0, started: 0 };
  }
  const readLogs: ReadLogs = o.readLogs ?? ((from, to, filter) => getLogs(from, to, filter));
  let watched = 0, started = 0;
  for (const { trigger_id } of ids) {
    const t = getTrigger(trigger_id);
    if (!t || t.status !== "active") continue;
    watched++;
    try {
      started += await watch(t, head, readLogs, nowMs);
    } catch (err) {
      logger.warn("trigger.watch_failed", "A trigger's logs could not be read this tick", { err, triggerId: trigger_id });
    }
  }
  return { watched, started };
}

/** The chain's head, for a trigger that starts watching now. Null when the chain cannot be read. */
export async function chainHead(): Promise<number | null> {
  try {
    return Number(await publicClient().getBlockNumber());
  } catch {
    return null;
  }
}
