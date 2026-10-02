import { describe, it, expect, vi, afterEach } from "vitest";
import { rpcCall, rpcUrls, describeRpcError } from "@/lib/evm";
import { RPC_URL } from "@/lib/chain";

const ALCHEMY = "https://robinhood-mainnet.g.alchemy.com/v2/secret-key-123";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AXON_RPC_URL;
  delete process.env.AXON_RPC_FALLBACK_URLS;
});

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
