import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null,
  scheduleAgentEmbedding: () => {},
}));
const described = vi.fn();
vi.mock("@/lib/agentDescription", async (orig) => ({
  ...(await orig<typeof import("@/lib/agentDescription")>()),
  scheduleAgentDescription: (...a: unknown[]) => described(...a),
}));

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { getInstructions } from "@/lib/agentKnowledge";
import type { MindsChain, MindLaunchEvent, Treasury, FeeFlow } from "@/lib/mindsChain";
import { prepare, skillsFrom, starterInstructions, LAUNCH_LIMITS } from "@/lib/mindsAgent";
import { indexMinds, earnedSince, liveToken } from "@/lib/mindsIndex";
import { getToken, getPrepared, listTokens, tokensOfCreator, tokenOfAgent, cursor, tokenCount } from "@/lib/mindsStore";
import { unreadChain } from "./helpers/unreadChain";

let n = 0;
const addr = (seed = ++n) => `0x${(seed + 9_100_000).toString(16).padStart(40, "0")}`;
const LAUNCHER = "0x00000000000000000000000000000000000a110c";
const ON = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: LAUNCHER, MIND_DEPLOY_BLOCK: "1000" };

const TREASURY: Treasury = {
  availableEth: 0.02, reservedEth: 0.005, boughtBackEth: 0.01, axonBurnedEth: 0.002, rewardedEth: 0.005, claimedEth: 0.001, thinkingEth: 0.0004, rewards: 1,
  paused: false, frozen: false, active: true, limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 12, maxCostPerDayEth: 0.01 },
};
const FEES: FeeFlow = { totalEth: 0.1, toCreatorEth: 0.05, toBurnEth: 0.02, toAxonEth: 0.01, toMindEth: 0.02, pendingCreatorEth: 0, burnedEth: 0.02, burnedTokens: 1_000_000, burns: 3 };

/** A chain that is written down here: these events, this head. */
function fakeChain(events: MindLaunchEvent[], head = 2000n) {
  const asked: { from: bigint; to: bigint }[] = [];
  const chain: MindsChain = {
    ...unreadChain,
    head: async () => head,
    launches: async (_launcher, from, to) => { asked.push({ from, to }); return events.filter((e) => BigInt(e.blockNumber) >= from && BigInt(e.blockNumber) <= to); },
    blockTime: async (b) => new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + b * 100).toISOString(),
    tokenMeta: async () => ({ name: "Chain Name", symbol: "CHAIN" }),
    treasury: async () => TREASURY,
    feeFlow: async () => FEES,
    snapshot: async () => { throw new Error("not read in these tests"); },
    transfers: async () => [],
    vaultDay: async () => ({ spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 }),
  };
  return { chain, asked };
}

function launched(creator: string, ref: string, over: Partial<MindLaunchEvent> = {}): MindLaunchEvent {
  return {
    kind: "launched", token: addr(), creator: creator.toLowerCase(), agentRef: ref.toLowerCase(), pot: addr(), splitter: addr(), vault: addr(), payout: creator.toLowerCase(),
    taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, blockNumber: 1500, txHash: `0x${randomUUID().replace(/-/g, "").padEnd(64, "0")}`, ...over,
  };
}

const ok = <T>(v: T | string): T => { if (typeof v === "string") throw new Error(v); return v; };

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor;");
  described.mockClear();
});

describe("preparing a launch", () => {
  it("writes the launch with a reference and makes no agent", () => {
    const me = addr();
    const before = (getDb().prepare("SELECT COUNT(*) n FROM agents").get() as { n: number }).n;
    const p = ok(prepare(me, { name: "Ledger Lens", symbol: "lens", line: "Reads a company's filings and explains what changed" }));
    expect(p.ref).toMatch(/^0x[0-9a-f]{64}$/);
    expect(p).toMatchObject({ wallet: me, symbol: "LENS", status: "prepared", agentId: null, token: null });
    expect((getDb().prepare("SELECT COUNT(*) n FROM agents").get() as { n: number }).n).toBe(before);
  });

  it("says what is wrong in words", () => {
    const me = addr();
    expect(prepare(me, { name: "", symbol: "X1", line: "Explains company filings well" })).toMatch(/name/);
    expect(prepare(me, { name: "Ledger Lens", symbol: "$LENS", line: "Explains company filings well" })).toMatch(/ticker/);
    expect(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "short" })).toMatch(/one line/);
    expect(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "Explains company filings well", logo: "javascript:alert(1)" })).toMatch(/picture/);
    expect(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "I am the official Axon agent for filings" })).toMatch(/Axon/);
    expect(prepare(me, { name: "Ledger Lens", symbol: "LENS", agentId: "nobody-has-this-agent" })).toMatch(/not an agent of yours/);
  });

  it("takes an agent only from the wallet that owns it", () => {
    const owner = addr();
    const agentId = `owned-${randomUUID().slice(0, 8)}`;
    createAgent({ agentId, name: "Owned Agent", capabilities: ["research"], publicKey: "k", provider: "anthropic", walletAddress: owner, createdAt: new Date().toISOString() });
    expect(prepare(addr(), { name: "Owned", symbol: "OWN", agentId })).toMatch(/not an agent of yours/);
    // the same wallet in another spelling is still the owner
    expect(ok(prepare(owner.toUpperCase().replace("0X", "0x"), { name: "Owned", symbol: "OWN", agentId })).agentId).toBe(agentId);
  });

  it("stops a wallet that prepares launch after launch", () => {
    const me = addr();
    for (let i = 0; i < LAUNCH_LIMITS.preparesPerDay; i++) ok(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "Explains company filings well" }));
    expect(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "Explains company filings well" })).toMatch(/tomorrow/);
  });
});

describe("the starter agent's template", () => {
  it("takes its skills from the line", () => {
    expect(skillsFrom("Reads a company's filings and explains what changed")).toEqual(["company", "filings", "explains", "changed"]);
    expect(skillsFrom("Turns long documents into short, clear briefs")).toEqual(["documents", "briefs", "turns"]);
    expect(skillsFrom("Fixes bugs in code")).toEqual(["fixes", "bugs", "code"]);
    expect(skillsFrom("!!!")).toEqual(["general"]);
  });
  it("puts the creator's line in the instructions", () => {
    expect(starterInstructions("Ledger Lens", "Reads filings")).toContain("You are Ledger Lens");
    expect(starterInstructions("Ledger Lens", "Reads filings")).toContain("Reads filings.");
  });
});

describe("reading the launcher", () => {
  it("does nothing while switched off or with no launcher", async () => {
    const { chain, asked } = fakeChain([launched(addr(), `0x${"1".repeat(64)}`)]);
    expect(await indexMinds(chain, { ...ON, AGENT_MINDS: "off" })).toBeNull();
    expect(await indexMinds(chain, { ...ON, NEXT_PUBLIC_MIND_LAUNCHER: undefined })).toBeNull();
    expect(await indexMinds(chain, { ...ON, MIND_DEPLOY_BLOCK: undefined })).toBeNull();
    expect(asked).toHaveLength(0);
    expect(tokenCount()).toBe(0);
  });

  it("writes a launch as the chain states it and makes its starter agent", async () => {
    const me = addr();
    const p = ok(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "Reads a company's filings and explains what changed", logo: "https://example.com/lens.png" }));
    const ev = launched(me, p.ref);
    const { chain, asked } = fakeChain([ev]);
    const pass = await indexMinds(chain, ON);
    expect(pass).toEqual({ from: 1000, to: 2000, events: 1, added: 1 });
    expect(asked).toEqual([{ from: 1000n, to: 2000n }]);
    expect(cursor()).toBe(2000);

    const t = getToken(ev.token)!;
    expect(t).toMatchObject({ creator: me, pot: ev.pot, splitter: ev.splitter, vault: ev.vault, payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, attached: false, blockNumber: 1500, txHash: ev.txHash });
    // the token's own name and ticker win over what the form said
    expect(t).toMatchObject({ name: "Chain Name", symbol: "CHAIN", logo: "https://example.com/lens.png" });
    expect(t.launchedAt).toBe(new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + 150_000).toISOString());

    const agent = getAgentById(t.agentId!)!;
    expect(agent).toMatchObject({ name: "Ledger Lens", publicKey: `minds:${p.ref}`, capabilities: ["company", "filings", "explains", "changed"] });
    expect(agent.walletAddress?.toLowerCase()).toBe(me);
    expect(getInstructions(agent.agentId)).toContain("Reads a company's filings and explains what changed.");
    const row = getDb().prepare("SELECT description FROM agents WHERE agent_id = ?").get(agent.agentId) as { description: string };
    expect(row.description).toBe("Reads a company's filings and explains what changed");
    // no model was asked to describe it
    expect(described).not.toHaveBeenCalled();
    expect(getPrepared(p.ref)).toMatchObject({ status: "launched", token: ev.token });
    expect(tokenOfAgent(agent.agentId)?.token).toBe(ev.token);
    expect(tokensOfCreator(me.toUpperCase())).toHaveLength(1);
  });

  it("reads on from where it stopped and never writes a token twice", async () => {
    const me = addr();
    const p = ok(prepare(me, { name: "Tide Table", symbol: "TIDE", line: "Explains what moved a stock today in plain words" }));
    const first = launched(me, p.ref, { blockNumber: 1200 });
    const { chain, asked } = fakeChain([first], 1300n);
    await indexMinds(chain, ON);
    const agents = (getDb().prepare("SELECT COUNT(*) n FROM agents WHERE public_key = ?").get(`minds:${p.ref}`) as { n: number }).n;

    const second = launched(addr(), `0x${"2".repeat(64)}`, { blockNumber: 1400 });
    const later = fakeChain([first, second], 1500n);
    expect(await indexMinds(later.chain, ON)).toEqual({ from: 1301, to: 1500, events: 1, added: 1 });
    expect(asked).toEqual([{ from: 1000n, to: 1300n }]);

    // the whole range read again from the start changes nothing
    getDb().exec("DELETE FROM mind_cursor");
    expect((await indexMinds(later.chain, ON))?.added).toBe(0);
    expect(tokenCount()).toBe(2);
    expect((getDb().prepare("SELECT COUNT(*) n FROM agents WHERE public_key = ?").get(`minds:${p.ref}`) as { n: number }).n).toBe(agents);
    expect(listTokens().map((t) => t.token)).toEqual([second.token, first.token]);
  });

  it("gives no agent to a launch that carries somebody else's reference", async () => {
    const me = addr();
    const thief = addr();
    const p = ok(prepare(me, { name: "Ledger Lens", symbol: "LENS", line: "Reads a company's filings and explains what changed" }));
    const stolen = launched(thief, p.ref, { blockNumber: 1100 });
    const { chain } = fakeChain([stolen]);
    await indexMinds(chain, ON);
    expect(getToken(stolen.token)).toMatchObject({ creator: thief, agentId: null });
    // the reference is still good for the wallet that prepared it
    expect(getPrepared(p.ref)?.status).toBe("prepared");
  });

  it("links the agent its creator picked, once", async () => {
    const me = addr();
    const agentId = `picked-${randomUUID().slice(0, 8)}`;
    createAgent({ agentId, name: "Picked Agent", capabilities: ["research"], publicKey: "k", provider: "anthropic", walletAddress: me, createdAt: new Date().toISOString() });
    const a = ok(prepare(me, { name: "Picked", symbol: "PICK", agentId }));
    const b = ok(prepare(me, { name: "Picked Two", symbol: "PICK2", agentId }));
    const one = launched(me, a.ref, { blockNumber: 1100 });
    const two = launched(me, b.ref, { blockNumber: 1200 });
    const { chain } = fakeChain([one, two]);
    await indexMinds(chain, ON);
    expect(getToken(one.token)?.agentId).toBe(agentId);
    // an agent stands behind one token: the second launch is a token with no agent
    expect(getToken(two.token)?.agentId).toBeNull();
    expect(prepare(me, { name: "Picked Three", symbol: "PICK3", agentId })).toMatch(/already has a token/);
  });

  it("records a mind given to an earlier token, with no split of its own", async () => {
    const me = addr();
    const ev: MindLaunchEvent = { kind: "attached", token: addr(), creator: me, agentRef: `0x${"0".repeat(64)}`, pot: addr(), splitter: null, vault: addr(), payout: null, taxBps: null, creatorBps: null, burnBps: null, axonBps: null, mindBps: null, blockNumber: 1700, txHash: `0x${"a".repeat(64)}` };
    const { chain } = fakeChain([ev]);
    await indexMinds(chain, ON);
    expect(getToken(ev.token)).toMatchObject({ attached: true, splitter: null, taxBps: null, mindBps: null, agentId: null, vault: ev.vault });
  });

  it("leaves the cursor where it was when the chain cannot be read", async () => {
    const { chain } = fakeChain([]);
    chain.launches = async () => { throw new Error("429"); };
    await expect(indexMinds(chain, ON)).rejects.toThrow("429");
    expect(cursor()).toBeNull();
  });

  it("catches up a bounded stretch at a time", async () => {
    const { chain, asked } = fakeChain([], 5_000_000n);
    expect(await indexMinds(chain, ON)).toMatchObject({ from: 1000, to: 1_000_999 });
    expect(await indexMinds(chain, ON)).toMatchObject({ from: 1_001_000, to: 2_000_999 });
    expect(asked).toHaveLength(2);
  });
});

describe("what a token's page reads", () => {
  const pay = (agentId: string, eth: number, at: string, status = "completed", currency = "ETH") =>
    getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at, settled_at) VALUES (?,?,?,?,?,?,0,?,?,?)")
      .run(randomUUID(), randomUUID(), "payer", agentId, eth, status, currency, at, at);

  it("counts what the agent earned from the launch onward, and nothing before it", () => {
    const agentId = `earner-${randomUUID().slice(0, 8)}`;
    const launch = "2026-10-05T12:00:00.000Z";
    pay(agentId, 0.5, "2026-10-01T09:00:00.000Z");
    pay(agentId, 0.001, "2026-10-05T12:00:00.000Z");
    pay(agentId, 0.002, "2026-10-05T18:00:00.000Z");
    pay(agentId, 0.004, "2026-10-05T19:00:00.000Z", "escrow");
    pay(agentId, 9, "2026-10-05T19:00:00.000Z", "completed", "AXON");
    expect(earnedSince(agentId, launch)).toBe(0.003);
  });

  it("puts the chain's numbers beside the token, and says nothing it could not read", async () => {
    const me = addr();
    const p = ok(prepare(me, { name: "Tide Table", symbol: "TIDE", line: "Explains what moved a stock today in plain words" }));
    const ev = launched(me, p.ref);
    const { chain } = fakeChain([ev]);
    await indexMinds(chain, ON);
    const live = (await liveToken(ev.token.toUpperCase().replace("0X", "0x"), chain))!;
    expect(live.treasury).toEqual(TREASURY);
    expect(live.fees).toEqual(FEES);
    expect(live.agent).toMatchObject({ name: "Tide Table", earnedEth: 0 });

    chain.treasury = async () => { throw new Error("rpc down"); };
    const dark = (await liveToken(ev.token, chain))!;
    expect(dark.treasury).toBeNull();
    expect(dark.fees).toEqual(FEES);
    expect(await liveToken(addr(), chain)).toBeNull();
  });
});
