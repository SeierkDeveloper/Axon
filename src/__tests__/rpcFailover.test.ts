import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { rpcCall, rpcUrls, describeRpcError } from "@/lib/evm";
import { RPC_URL } from "@/lib/chain";
import { DEFAULT_DAILY_UNITS, dailyUnits, isPaidNode, resetRpcBudget, spentToday, unitsFor } from "@/lib/rpcBudget";

const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/secret-key-123";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AXON_RPC_URL;
  delete process.env.AXON_RPC_FALLBACK_URLS;
  delete process.env.AXON_RPC_DAILY_UNITS;
});
beforeEach(() => resetRpcBudget());

describe("several nodes, in order", () => {
  it("tries the dedicated node first and the public one last, each once", () => {
    process.env.AXON_RPC_URL = ALCHEMY;
    process.env.AXON_RPC_FALLBACK_URLS = "https://b.test, ";
    expect(rpcUrls()).toEqual([ALCHEMY, "https://b.test", RPC_URL]);
  });

  it("hands a rate-limited call to the next node", async () => {
    process.env.AXON_RPC_URL = ALCHEMY;
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      seen.push(String(url));
      if (String(url) === ALCHEMY) return new Response("Too Many Requests", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }));
    });
    expect(await rpcCall<string>("eth_blockNumber", [])).toBe("0x10");
    expect(seen).toEqual([ALCHEMY, RPC_URL]);
  });

  it("does not shop a real answer around: a revert comes straight back", async () => {
    process.env.AXON_RPC_URL = ALCHEMY;
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } })),
    );
    await expect(rpcCall("eth_call", [])).rejects.toThrow("execution reverted");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("never logs a node's key", () => {
    process.env.AXON_RPC_URL = ALCHEMY;
    expect(describeRpcError(new Error(`request to ${ALCHEMY} failed`))).not.toContain("secret-key-123");
    expect(describeRpcError(new Error("see https://other.g.alchemy.com/v2/another-key"))).not.toContain("another-key");
  });
});

/** A fetch that answers per node: a number is that HTTP status, anything else the JSON-RPC result. */
function nodes(answers: Record<string, number | string>) {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    seen.push(String(url));
    const a = answers[String(url)];
    if (typeof a === "number") return new Response("no", { status: a });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: a }));
  });
  return seen;
}

describe("a paid node as the second choice", () => {
  it("is not asked while the public node answers, and costs nothing", async () => {
    process.env.AXON_RPC_FALLBACK_URLS = ALCHEMY;
    expect(rpcUrls()).toEqual([RPC_URL, ALCHEMY]);
    const seen = nodes({ [RPC_URL]: "0x10", [ALCHEMY]: "0x99" });
    expect(await rpcCall<string>("eth_blockNumber", [])).toBe("0x10");
    expect(seen).toEqual([RPC_URL]);
    expect((await spentToday()).units).toBe(0);
  });

  it("steps in when the public node turns the call away with a 403, and the call is counted", async () => {
    process.env.AXON_RPC_FALLBACK_URLS = ALCHEMY;
    const seen = nodes({ [RPC_URL]: 403, [ALCHEMY]: "0x99" });
    expect(await rpcCall<string>("eth_call", [])).toBe("0x99");
    expect(seen).toEqual([RPC_URL, ALCHEMY]);
    expect(await spentToday()).toMatchObject({ units: unitsFor("eth_call"), calls: 1, allowance: DEFAULT_DAILY_UNITS });
  });

  it("stops at the daily allowance: after that the public node's answer stands, refusal or not", async () => {
    process.env.AXON_RPC_FALLBACK_URLS = ALCHEMY;
    process.env.AXON_RPC_DAILY_UNITS = String(unitsFor("eth_call") * 2 + 5);
    const seen = nodes({ [RPC_URL]: 403, [ALCHEMY]: "0x99" });
    expect(await rpcCall<string>("eth_call", [])).toBe("0x99");
    expect(await rpcCall<string>("eth_call", [])).toBe("0x99");
    await expect(rpcCall("eth_call", [])).rejects.toThrow("403");
    expect(seen.filter((u) => u === ALCHEMY)).toHaveLength(2);
    expect((await spentToday()).units).toBe(unitsFor("eth_call") * 2);
  });

  it("holds as the first choice too: past the allowance every call goes to the public node", async () => {
    process.env.AXON_RPC_URL = ALCHEMY;
    process.env.AXON_RPC_DAILY_UNITS = String(unitsFor("eth_blockNumber"));
    const seen = nodes({ [RPC_URL]: "0x10", [ALCHEMY]: "0x99" });
    expect(await rpcCall<string>("eth_blockNumber", [])).toBe("0x99");
    expect(await rpcCall<string>("eth_blockNumber", [])).toBe("0x10");
    expect(await rpcCall<string>("eth_blockNumber", [])).toBe("0x10");
    expect(seen).toEqual([ALCHEMY, RPC_URL, RPC_URL]);
  });

  it("an allowance of 0 switches the paid node off without removing its address", async () => {
    process.env.AXON_RPC_FALLBACK_URLS = ALCHEMY;
    process.env.AXON_RPC_DAILY_UNITS = "0";
    const seen = nodes({ [RPC_URL]: 403, [ALCHEMY]: "0x99" });
    await expect(rpcCall("eth_call", [])).rejects.toThrow("403");
    expect(seen).toEqual([RPC_URL]);
  });

  it("a new day starts a new allowance, and yesterday's count is kept", async () => {
    const day1 = Date.UTC(2026, 9, 9, 23, 59), day2 = Date.UTC(2026, 9, 10, 0, 1);
    const { countPaidCall, mayUsePaidNode } = await import("@/lib/rpcBudget");
    process.env.AXON_RPC_DAILY_UNITS = String(unitsFor("eth_getLogs"));
    await countPaidCall("eth_getLogs", day1);
    expect(await mayUsePaidNode("eth_getLogs", day1)).toBe(false);
    expect(await mayUsePaidNode("eth_getLogs", day2)).toBe(true);
    expect((await spentToday(day1)).units).toBe(unitsFor("eth_getLogs"));
    expect((await spentToday(day2)).units).toBe(0);
  });

  it("reads the allowance plainly and counts an unknown method as a dear one", () => {
    expect(dailyUnits({} as NodeJS.ProcessEnv)).toBe(DEFAULT_DAILY_UNITS);
    expect(dailyUnits({ AXON_RPC_DAILY_UNITS: "250000" } as unknown as NodeJS.ProcessEnv)).toBe(250000);
    expect(dailyUnits({ AXON_RPC_DAILY_UNITS: "lots" } as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_DAILY_UNITS);
    expect(dailyUnits({ AXON_RPC_DAILY_UNITS: "-5" } as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_DAILY_UNITS);
    expect(unitsFor("debug_traceTransaction")).toBeGreaterThanOrEqual(unitsFor("eth_getLogs"));
    expect(isPaidNode(RPC_URL)).toBe(false);
    expect(isPaidNode(ALCHEMY)).toBe(true);
  });
});
