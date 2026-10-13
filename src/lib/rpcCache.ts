// Chain calls that need not be made.
//
// Every call to a node costs something: the public node turns a busy caller away, and the paid one is billed by the
// call. A good part of what Axon asks, it has asked before and the answer cannot have changed, or it is asking
// twice in the same instant from two places. Three things are done about that, and nothing else:
//
//   kept     an answer that cannot change is kept for a while: the receipt of a transaction that is in a block,
//            that transaction itself, a block asked for by its number or hash, the code at an address that has
//            code, a token's name, symbol and decimals. Only an answer that is there is kept. "Not yet" (a null
//            receipt, an address with no code) is always asked again.
//   briefly  the newest block's number is kept for a second and the price of gas for three: the chain makes a
//            block ten times a second, and nothing here needs to know sooner than that.
//   shared   the same question asked while its answer is on the way gets that answer, not a second call.
//
// A call that sends something is never kept or shared, and neither is anything asked "as of the pending block".
// An error is never kept. AXON_RPC_CACHE=off turns all of it off. Each process (the site, the worker) keeps its own.

const MINUTE = 60_000;
const MOST = 3000;

interface Kept { until: number; value: unknown }
const kept = new Map<string, Kept>();
const flying = new Map<string, Promise<unknown>>();
const count = { kept: 0, shared: 0, asked: 0 };

export function rpcCacheOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AXON_RPC_CACHE ?? "").trim().toLowerCase() !== "off";
}

/** What the cache has saved since the process started: answers given from what was kept, questions that shared a call, and calls made. */
export function rpcCacheStats(): { kept: number; shared: number; asked: number; held: number } {
  return { ...count, held: kept.size };
}

export function resetRpcCache(): void {
  kept.clear();
  flying.clear();
  count.kept = count.shared = count.asked = 0;
  written.kept = written.shared = written.asked = 0;
}

// ---- the day's count, for the site and the worker together ----

const written = { kept: 0, shared: 0, asked: 0 };
let timer: ReturnType<typeof setInterval> | null = null;

/** Add what this process has counted since it last did so to the day's row. Never throws: a count is not worth a failed call. */
export async function writeRpcSaved(nowMs = Date.now()): Promise<void> {
  const d = { kept: count.kept - written.kept, shared: count.shared - written.shared, asked: count.asked - written.asked };
  if (d.kept + d.shared + d.asked <= 0) return;
  try {
    const { getDb } = await import("./db");
    getDb()
      .prepare("INSERT INTO rpc_saved (day, kept, shared, asked) VALUES (?, ?, ?, ?) ON CONFLICT(day) DO UPDATE SET kept = kept + excluded.kept, shared = shared + excluded.shared, asked = asked + excluded.asked")
      .run(new Date(nowMs).toISOString().slice(0, 10), d.kept, d.shared, d.asked);
    written.kept += d.kept; written.shared += d.shared; written.asked += d.asked;
  } catch {
    // tried again with the next minute's count
  }
}

/** Today's count from every process, as far as each has written it down (a minute behind at most). */
export async function rpcSavedToday(nowMs = Date.now()): Promise<{ kept: number; shared: number; asked: number }> {
  try {
    const { getDb } = await import("./db");
    const row = getDb().prepare("SELECT kept, shared, asked FROM rpc_saved WHERE day = ?").get(new Date(nowMs).toISOString().slice(0, 10)) as { kept: number; shared: number; asked: number } | undefined;
    return row ?? { kept: 0, shared: 0, asked: 0 };
  } catch {
    return { kept: 0, shared: 0, asked: 0 };
  }
}

/** Started by the first call that goes through: once a minute, and never a reason for the process to stay up. */
function keepCount(): void {
  if (timer || process.env.VITEST) return;
  timer = setInterval(() => void writeRpcSaved(), 60_000);
  timer.unref?.();
}

const isHexNumber = (v: unknown): boolean => typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
const latest = (tag: unknown): boolean => tag === undefined || tag === "latest";
// name(), symbol(), decimals(): fixed when a token is made
const FIXED_CALLS = new Set(["0x06fdde03", "0x95d89b41", "0x313ce567"]);

/** How long an answer may be kept, in ms. 0: not at all. */
export function keepFor(method: string, params: unknown[], result: unknown): number {
  switch (method) {
    case "eth_chainId":
    case "net_version":
      return 24 * 60 * MINUTE;
    case "eth_blockNumber":
      return 1000;
    case "eth_gasPrice":
    case "eth_maxPriorityFeePerGas":
    case "eth_feeHistory":
      return 3000;
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      // in a block: it is what it is. Not in one yet: asked again
      return result && typeof result === "object" && isHexNumber((result as { blockNumber?: unknown }).blockNumber) ? 10 * MINUTE : 0;
    case "eth_getBlockByHash":
      return result ? 10 * MINUTE : 0;
    case "eth_getBlockByNumber":
      // by its number, never by a name like "latest", which is another block every time
      return result && isHexNumber(params[0]) ? 10 * MINUTE : 0;
    case "eth_getCode":
      return typeof result === "string" && result.length > 2 && latest(params[1]) ? 10 * MINUTE : 0;
    case "eth_call": {
      const call = params[0] as { data?: unknown; input?: unknown } | undefined;
      const data = typeof call?.data === "string" ? call.data : typeof call?.input === "string" ? call.input : "";
      return FIXED_CALLS.has(data.toLowerCase()) && latest(params[1]) && typeof result === "string" && result.length > 2 ? 60 * MINUTE : 0;
    }
    default:
      return 0;
  }
}

/** Whether two askers of the same thing at the same moment may share one call. */
function mayShare(method: string, params: unknown[]): boolean {
  if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") return false;
  return !params.includes("pending");
}

const copy = <T,>(v: T): T => (v !== null && typeof v === "object" ? structuredClone(v) : v);

/**
 * One call, through what is kept. `ask` makes the call when it has to be made.
 */
export async function throughRpcCache<T>(method: string, params: unknown[], ask: () => Promise<T>, nowMs: () => number = Date.now): Promise<T> {
  if (!rpcCacheOn() || !mayShare(method, params)) return ask();
  keepCount();
  let key: string;
  try {
    key = `${method}:${JSON.stringify(params)}`;
  } catch {
    return ask(); // something that cannot be written down cannot be looked up
  }
  const had = kept.get(key);
  if (had) {
    if (had.until > nowMs()) {
      count.kept++;
      return copy(had.value) as T;
    }
    kept.delete(key);
  }
  const onItsWay = flying.get(key);
  if (onItsWay) {
    count.shared++;
    return copy(await onItsWay) as T;
  }
  count.asked++;
  const call = ask();
  flying.set(key, call);
  try {
    const result = await call;
    const ms = keepFor(method, params, result);
    if (ms > 0) {
      // the oldest goes first when there are too many: a Map hands its keys back in the order they were put in
      if (kept.size >= MOST) kept.delete(kept.keys().next().value as string);
      kept.set(key, { until: nowMs() + ms, value: copy(result) });
    }
    return result;
  } finally {
    flying.delete(key);
  }
}
