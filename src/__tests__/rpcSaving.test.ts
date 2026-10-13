import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { rpcCall } from "@/lib/evm";
import { RPC_URL } from "@/lib/chain";
import { countPaidCall, isSending, mayUsePaidNode, readsAllowedBy, resetRpcBudget, sendReservePct, spentByMethod, spentToday, spreadOn, unitsFor } from "@/lib/rpcBudget";
import { keepFor, resetRpcCache, rpcCacheStats, throughRpcCache } from "@/lib/rpcCache";

const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/secret-key-123";
const ENV = ["AXON_RPC_URL", "AXON_RPC_FALLBACK_URLS", "AXON_RPC_DAILY_UNITS", "AXON_RPC_CACHE", "AXON_RPC_SPREAD", "AXON_RPC_SEND_RESERVE_PCT"];

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV) delete process.env[k];
});
beforeEach(() => {
  resetRpcCache();
  return resetRpcBudget();
});

/** A node that answers every call with the next of `answers` and remembers what it was asked. */
function node(answers: unknown[]) {
  const asked: { url: string; method: string; params: unknown[] }[] = [];
  let i = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { method: string; params: unknown[] };
    asked.push({ url: String(url), method: body.method, params: body.params });
    const a = answers[Math.min(i++, answers.length - 1)];
    if (typeof a === "number") return new Response("no", { status: a });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: a }));
  });
  return asked;
}
const RECEIPT = { transactionHash: "0xabc", blockNumber: "0x10", status: "0x1", logs: [] };

describe("what is kept, and for how long", () => {
  it("a transaction in a block and its receipt, a block by its number or hash, code, and a token's fixed facts", () => {
    expect(keepFor("eth_getTransactionReceipt", ["0xabc"], RECEIPT)).toBe(600_000);
    expect(keepFor("eth_getTransactionByHash", ["0xabc"], { blockNumber: "0x10" })).toBe(600_000);
    expect(keepFor("eth_getBlockByNumber", ["0x10", false], { number: "0x10" })).toBe(600_000);
    expect(keepFor("eth_getBlockByHash", ["0xhash", false], { number: "0x10" })).toBe(600_000);
    expect(keepFor("eth_getCode", ["0xtoken", "latest"], "0x6080")).toBe(600_000);
    for (const data of ["0x06fdde03", "0x95d89b41", "0x313ce567"]) expect(keepFor("eth_call", [{ to: "0xtoken", data }, "latest"], "0x12")).toBe(3_600_000);
    expect(keepFor("eth_chainId", [], "0x1237")).toBeGreaterThan(3_600_000);
  });

  it("never an answer that may still change", () => {
    // not in a block yet, or not there at all
    expect(keepFor("eth_getTransactionReceipt", ["0xabc"], null)).toBe(0);
    expect(keepFor("eth_getTransactionByHash", ["0xabc"], { blockNumber: null })).toBe(0);
    expect(keepFor("eth_getBlockByNumber", ["latest", false], { number: "0x10" })).toBe(0);
    expect(keepFor("eth_getBlockByNumber", ["0x999999", false], null)).toBe(0);
    // an address with no code may be given some
    expect(keepFor("eth_getCode", ["0xwallet", "latest"], "0x")).toBe(0);
    // a balance, a total supply, an allowance, any other call, a nonce, logs
    expect(keepFor("eth_call", [{ to: "0xtoken", data: "0x18160ddd" }, "latest"], "0x12")).toBe(0);
    expect(keepFor("eth_call", [{ to: "0xtoken", data: "0x70a08231000000000000000000000000aa" }, "latest"], "0x12")).toBe(0);
    expect(keepFor("eth_call", [{ to: "0xtoken", data: "0x313ce567" }, "0x10"], "0x12")).toBe(0);
    for (const m of ["eth_getBalance", "eth_getTransactionCount", "eth_getLogs", "eth_estimateGas", "eth_sendRawTransaction", "eth_getStorageAt"]) expect(keepFor(m, ["0x1", "latest"], "0x1")).toBe(0);
  });

  it("the newest block for a second and the price of gas for three, and no longer", () => {
    expect(keepFor("eth_blockNumber", [], "0x10")).toBe(1000);
    for (const m of ["eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"]) expect(keepFor(m, [], "0x1")).toBe(3000);
  });
});

describe("a call that need not be made is not made", () => {
  it("a receipt that is in a block is asked for once", async () => {
    const asked = node([RECEIPT]);
    const first = await rpcCall<typeof RECEIPT>("eth_getTransactionReceipt", ["0xabc"]);
    const second = await rpcCall<typeof RECEIPT>("eth_getTransactionReceipt", ["0xabc"]);
    expect(asked).toHaveLength(1);
    expect(second).toEqual(first);
    // each asker has a copy of its own: what one does to it, the next does not see
    (second as { status: string }).status = "changed";
    expect((await rpcCall<typeof RECEIPT>("eth_getTransactionReceipt", ["0xabc"])).status).toBe("0x1");
    expect(asked).toHaveLength(1);
    // another transaction is another question
    await rpcCall("eth_getTransactionReceipt", ["0xdef"]);
    expect(asked).toHaveLength(2);
  });

  it("a receipt that is not there yet is asked for again every time, until it is", async () => {
    const asked = node([null, null, RECEIPT]);
    expect(await rpcCall("eth_getTransactionReceipt", ["0xabc"])).toBeNull();
    expect(await rpcCall("eth_getTransactionReceipt", ["0xabc"])).toBeNull();
    expect(await rpcCall("eth_getTransactionReceipt", ["0xabc"])).toEqual(RECEIPT);
    expect(await rpcCall("eth_getTransactionReceipt", ["0xabc"])).toEqual(RECEIPT);
    expect(asked).toHaveLength(3);
  });

  it("what was kept is let go when its time is up", async () => {
    let now = 1_000_000;
    let calls = 0;
    const ask = async () => `0x${(++calls).toString(16)}`;
    expect(await throughRpcCache("eth_blockNumber", [], ask, () => now)).toBe("0x1");
    now += 900;
    expect(await throughRpcCache("eth_blockNumber", [], ask, () => now)).toBe("0x1");
    now += 200;
    expect(await throughRpcCache("eth_blockNumber", [], ask, () => now)).toBe("0x2");
    expect(calls).toBe(2);
  });

  it("the same question asked while its answer is on the way shares the one call", async () => {
    let release!: (v: string) => void;
    let calls = 0;
    const ask = () => { calls++; return new Promise<string>((r) => { release = r; }); };
    const a = throughRpcCache("eth_getBalance", ["0xaa", "latest"], ask);
    const b = throughRpcCache("eth_getBalance", ["0xaa", "latest"], ask);
    const other = throughRpcCache("eth_getBalance", ["0xbb", "latest"], async () => "0x7");
    release("0x5");
    expect(await Promise.all([a, b, other])).toEqual(["0x5", "0x5", "0x7"]);
    expect(calls).toBe(1);
    // a balance is not kept: asked again a moment later, it is asked
    await throughRpcCache("eth_getBalance", ["0xaa", "latest"], async () => { calls++; return "0x6"; });
    expect(calls).toBe(2);
    expect(rpcCacheStats()).toMatchObject({ shared: 1, asked: 3 });
  });

  it("a send is never shared or kept, and neither is anything asked of the pending block", async () => {
    let calls = 0;
    const ask = async () => `0x${(++calls).toString(16)}`;
    await Promise.all([throughRpcCache("eth_sendRawTransaction", ["0xsigned"], ask), throughRpcCache("eth_sendRawTransaction", ["0xsigned"], ask)]);
    expect(calls).toBe(2);
    await Promise.all([throughRpcCache("eth_getTransactionCount", ["0xaa", "pending"], ask), throughRpcCache("eth_getTransactionCount", ["0xaa", "pending"], ask)]);
    expect(calls).toBe(4);
  });

  it("an error is never kept: the next asker asks again", async () => {
    const asked = node([503, RECEIPT]);
    await expect(rpcCall("eth_getTransactionReceipt", ["0xabc"])).rejects.toThrow("503");
    expect(await rpcCall("eth_getTransactionReceipt", ["0xabc"])).toEqual(RECEIPT);
    expect(asked).toHaveLength(2);
  });

  it("is switched off with AXON_RPC_CACHE=off", async () => {
    process.env.AXON_RPC_CACHE = "off";
    const asked = node([RECEIPT]);
    await rpcCall("eth_getTransactionReceipt", ["0xabc"]);
    await rpcCall("eth_getTransactionReceipt", ["0xabc"]);
    expect(asked).toHaveLength(2);
  });

  it("saves the paid node's units too: a kept answer is not counted twice", async () => {
    process.env.AXON_RPC_URL = ALCHEMY;
    node([RECEIPT]);
    await rpcCall("eth_getTransactionReceipt", ["0xabc"]);
    await rpcCall("eth_getTransactionReceipt", ["0xabc"]);
    await rpcCall("eth_getTransactionReceipt", ["0xabc"]);
    expect(await spentToday()).toMatchObject({ units: unitsFor("eth_getTransactionReceipt"), calls: 1 });
  });
});

describe("the paid node's allowance lasts the day", () => {
  const at = (hour: number, minute = 0) => Date.UTC(2026, 9, 14, hour, minute);

  it("holds a quarter back for sending, and gives reads the rest by the hour", () => {
    expect(sendReservePct({} as NodeJS.ProcessEnv)).toBe(25);
    expect(spreadOn({} as NodeJS.ProcessEnv)).toBe(true);
    // 400,000 a day: 300,000 for reads, 12,500 more of it with every hour
    expect(readsAllowedBy(at(0), 400_000)).toBe(12_500);
    expect(readsAllowedBy(at(11, 59), 400_000)).toBe(150_000);
    expect(readsAllowedBy(at(23), 400_000)).toBe(300_000);
    expect(readsAllowedBy(at(0), 400_000, { AXON_RPC_SPREAD: "off" } as unknown as NodeJS.ProcessEnv)).toBe(300_000);
    expect(readsAllowedBy(at(23), 400_000, { AXON_RPC_SEND_RESERVE_PCT: "0" } as unknown as NodeJS.ProcessEnv)).toBe(400_000);
    expect(sendReservePct({ AXON_RPC_SEND_RESERVE_PCT: "200" } as unknown as NodeJS.ProcessEnv)).toBe(25);
  });

  it("knows which calls a transaction cannot be sent without", () => {
    for (const m of ["eth_sendRawTransaction", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_gasPrice"]) expect(isSending(m)).toBe(true);
    for (const m of ["eth_call", "eth_getLogs", "eth_getBalance", "eth_blockNumber", "eth_getCode"]) expect(isSending(m)).toBe(false);
  });

  it("a read waits for its hour once reads have used their share so far, and is let through in the next", async () => {
    process.env.AXON_RPC_DAILY_UNITS = "24000"; // 18,000 for reads: 750 an hour
    const call = unitsFor("eth_call");
    for (let i = 0; i < Math.floor(750 / call); i++) {
      expect(await mayUsePaidNode("eth_call", at(0, 5))).toBe(true);
      await countPaidCall("eth_call", at(0, 5));
    }
    expect(await mayUsePaidNode("eth_call", at(0, 30))).toBe(false);
    // what an hour did not use is there for the next: at one o'clock there are 750 more
    expect(await mayUsePaidNode("eth_call", at(1, 0))).toBe(true);
    // and an hour nobody used leaves its share for later
    expect(readsAllowedBy(at(5), 24_000)).toBe(4500);
  });

  it("sending is never made to wait for its hour, and has its part of the day to itself", async () => {
    process.env.AXON_RPC_DAILY_UNITS = "24000";
    // reads use everything that is theirs for the whole day
    for (let spent = 0; spent + unitsFor("eth_getLogs") <= 18_000; spent += unitsFor("eth_getLogs")) await countPaidCall("eth_getLogs", at(23, 0));
    expect(await mayUsePaidNode("eth_getLogs", at(23, 30))).toBe(false);
    expect(await mayUsePaidNode("eth_call", at(23, 30))).toBe(false);
    // and a payment still goes out, at any hour, with what a send needs around it
    for (const m of ["eth_getTransactionCount", "eth_estimateGas", "eth_sendRawTransaction", "eth_getTransactionReceipt"]) expect(await mayUsePaidNode(m, at(23, 30))).toBe(true);
    expect(await mayUsePaidNode("eth_sendRawTransaction", at(0, 0))).toBe(true);
    const s = await spentToday(at(23, 30));
    expect(s.sendUnits).toBe(0);
    expect(s.readUnits).toBe(s.units);
  });

  it("the day's total still holds for everything: past it not even a send goes to the paid node", async () => {
    process.env.AXON_RPC_DAILY_UNITS = String(unitsFor("eth_sendRawTransaction") * 2);
    await countPaidCall("eth_sendRawTransaction", at(9));
    expect(await mayUsePaidNode("eth_sendRawTransaction", at(9))).toBe(true);
    await countPaidCall("eth_sendRawTransaction", at(9));
    expect(await mayUsePaidNode("eth_sendRawTransaction", at(9))).toBe(false);
    expect(await spentToday(at(9))).toMatchObject({ units: 500, sendUnits: 500, readUnits: 0 });
  });

  it("counts what was spent by the kind of call, dearest first", async () => {
    await countPaidCall("eth_call", at(9));
    await countPaidCall("eth_call", at(9));
    await countPaidCall("eth_getLogs", at(9));
    await countPaidCall("eth_sendRawTransaction", at(9));
    expect(await spentByMethod(at(9))).toEqual([
      { method: "eth_sendRawTransaction", units: 250, calls: 1 },
      { method: "eth_getLogs", units: 75, calls: 1 },
      { method: "eth_call", units: 52, calls: 2 },
    ]);
    expect(await spentByMethod(at(9) + 86_400_000)).toEqual([]);
  });

  it("at the node: a read past its hour's share is carried by the public node, and a send goes to the paid one", async () => {
    process.env.AXON_RPC_FALLBACK_URLS = ALCHEMY;
    process.env.AXON_RPC_DAILY_UNITS = "2400"; // 1,800 for reads, 75 an hour: not one eth_getLogs in the first hours of the day
    vi.spyOn(Date, "now").mockReturnValue(at(0, 10));
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      seen.push(String(url));
      return String(url) === RPC_URL ? new Response("no", { status: 403 }) : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xdone" }));
    });
    await expect(rpcCall("eth_call", [{ to: "0xaa", data: "0x70a08231" }, "latest"])).resolves.toBe("0xdone"); // 26 of 75
    await expect(rpcCall("eth_call", [{ to: "0xbb", data: "0x70a08231" }, "latest"])).resolves.toBe("0xdone"); // 52 of 75
    await expect(rpcCall("eth_call", [{ to: "0xcc", data: "0x70a08231" }, "latest"])).rejects.toThrow("403"); // would be 78: waits
    await expect(rpcCall("eth_sendRawTransaction", ["0xsigned"])).resolves.toBe("0xdone");
    expect(seen.filter((u) => u === ALCHEMY)).toHaveLength(3);
  });
});
