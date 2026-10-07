// The Agent Minds reading calls, against a stubbed network: what the SDK asks for and how it unwraps replies.
// The server side is covered by the app's own minds suites.

import { describe, it, expect, vi, afterEach } from "vitest";
import { AxonClient, AxonApiError } from "../src/client";

interface Call { method: string; path: string; search: string }

function stub(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname, search: u.search });
    const body = responses[`${method} ${u.pathname}`];
    return new Response(JSON.stringify(body ?? { error: "No such token.", code: "NOT_FOUND" }), { status: body ? 200 : 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());
const client = () => new AxonClient({ endpoint: "https://axon.test", apiKey: "axon_test" });

const TOKEN = "0x00000000000000000000000000000000000000a1";
const row = { token: TOKEN, name: "Lumen", symbol: "LUM", mindBps: 2000, holders: 12, treasuryEth: 0.004 };
const totals = { tokens: 1, feesEth: 0.02, burnedEth: 0.006, toMindEth: 0.004, treasuryEth: 0.004 };

describe("agent minds", () => {
  it("listTokenMinds asks for the board with no query by default and returns the page", async () => {
    const calls = stub({ "GET /api/minds/tokens": { tokens: [row], totals, page: 1, pages: 1, ethUsd: 4100, opened: null, events: [{ id: 7, token: TOKEN, kind: "burn" }] } });
    const out = await client().listTokenMinds();
    expect(calls[0]).toEqual({ method: "GET", path: "/api/minds/tokens", search: "" });
    expect(out.tokens).toEqual([row]);
    expect(out.totals).toEqual(totals);
    expect(out).toMatchObject({ page: 1, pages: 1, ethUsd: 4100 });
    expect(out.events).toHaveLength(1);
    // The board's own "open this row" slot is the page's business, not the caller's.
    expect(out).not.toHaveProperty("opened");
  });

  it("listTokenMinds passes sort, limit and page", async () => {
    const calls = stub({ "GET /api/minds/tokens": { tokens: [], totals, page: 3, pages: 3 } });
    const out = await client().listTokenMinds({ sort: "burned", limit: 5, page: 3 });
    expect(calls[0].search).toBe("?sort=burned&limit=5&page=3");
    // A server that could not read the price, or sent no events, still gives a whole page.
    expect(out.ethUsd).toBeNull();
    expect(out.events).toEqual([]);
  });

  it("getTokenMind reads one token with its plan, orders, promises and record", async () => {
    const mind = {
      ...row,
      mind: { state: "waiting", text: "Waiting for something to happen.", actionsToday: 1, actionsAllowed: 6 },
      plan: { mission: "Grow slowly.", goal: { kind: "holders", target: 40 }, split: { buyback: 40, reward: 30, burnAxon: 10, reserve: 20 }, reserveEth: 0.001 },
      orders: [{ id: 3, status: "armed", when: "holders reach 30", then: "reward 0.001 ETH", promise: true }],
      promises: { made: 1, standing: 1, kept: 0, missed: 0, notCalled: 0, beingKept: 0, heldEth: 0.001 },
      record: { summary: { moves: 0, measured: 0, byKind: [] }, moves: [] },
      reports: [],
      brief: null,
      books: null,
    };
    const calls = stub({ [`GET /api/minds/tokens/${TOKEN}`]: mind });
    const out = await client().getTokenMind(TOKEN);
    expect(calls[0]).toEqual({ method: "GET", path: `/api/minds/tokens/${TOKEN}`, search: "" });
    expect(out.plan?.goal).toEqual({ kind: "holders", target: 40 });
    expect(out.orders[0].promise).toBe(true);
    expect(out.promises.heldEth).toBe(0.001);
    expect(out.mind?.state).toBe("waiting");
  });

  it("getTokenMind throws a 404 for an address with no mind, and keeps the path safe", async () => {
    const calls = stub({});
    await expect(client().getTokenMind("0xnope/../x")).rejects.toBeInstanceOf(AxonApiError);
    expect(calls[0].path).toBe("/api/minds/tokens/0xnope%2F..%2Fx");
    await expect(client().getTokenMind("0xnope")).rejects.toMatchObject({ status: 404 });
  });

  it("listMindThoughts reads every mind's journal, or one token's", async () => {
    const t = { id: 9, token: TOKEN, source: "pulse", thought: "Nothing to do yet.", action: null, verdict: "none", sent: null };
    const calls = stub({ "GET /api/minds/thoughts": { thoughts: [t] } });
    expect(await client().listMindThoughts()).toEqual([t]);
    expect(calls[0].search).toBe("");
    await client().listMindThoughts({ token: TOKEN, limit: 3 });
    expect(calls[1].search).toBe(`?token=${TOKEN}&limit=3`);
  });

  it("getMindRewards asks for one wallet's shares and keeps the amount exact", async () => {
    const share = { token: TOKEN, symbol: "LUM", name: "Lumen", vault: "0x00000000000000000000000000000000000000b2", rewardId: 1, index: 4, amountWei: "1234567890123456789", amountEth: 1.2345678901234568, proof: ["0xabc"], startAt: 1790000000, endAt: 1790600000 };
    const calls = stub({ "GET /api/minds/rewards": { shares: [share] } });
    const wallet = "0x00000000000000000000000000000000000000C3";
    const out = await client().getMindRewards(wallet);
    expect(calls[0].search).toBe(`?account=${wallet}`);
    expect(out).toEqual([share]);
    expect(out[0].amountWei).toBe("1234567890123456789");
  });
});
