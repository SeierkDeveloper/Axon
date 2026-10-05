// Agent Minds, phase 8: a mind for a token launched before minds. The chain here is written in the test.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury, EarlierToken } from "@/lib/mindsChain";
import { ATTACH_ABI, checkAttach, suggestAttach, prepareAttach, getAttach } from "@/lib/mindsAttach";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, board, events } from "@/lib/mindsStats";
import { thinkOnce, type Thought } from "@/lib/mindsMind";
import { checkProposal } from "@/lib/mindsRules";
import { checkLimits, mindLimits, DEFAULT_SETTINGS, CAN } from "@/lib/mindsLaunch";
import { DEFAULT_MIND_MODEL, OWN_MIND } from "@/lib/mindsModels";
import type { Thinker } from "@/lib/mindsThinker";
import type { Agent } from "@/sdk/types";
import { unreadChain } from "./helpers/unreadChain";

let n = 0;
const addr = () => `0x${(++n + 9_995_000).toString(16).padStart(40, "0")}`;
const LAUNCHER = "0x00000000000000000000000000000000000a110c";
const ENV = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: LAUNCHER, MIND_DEPLOY_BLOCK: "1000", MINDS_THINKING: "live", ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k", SEED_SECRET: "s" };
const T0 = Date.UTC(2026, 9, 5, 12);

const treasury = (availableEth = 0): Treasury => ({ availableEth, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true, limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01 } });
const snap = (treasuryEth = 0): Snapshot => ({ phase: 2, curve: addr(), priceEth: 2e-8, supply: 1e9, curveBps: 10_000, feesEth: 0, toMindEth: 0, burnedTokens: 0, burnedEth: 0, burns: 0, treasuryEth, poolManager: addr() });

/** An earlier token: launched by `dev` through `pot`, with no mind yet. */
function earlier(dev: string, over: Partial<EarlierToken> = {}) {
  const token: EarlierToken = { token: addr(), pot: addr(), dev: dev.toLowerCase(), name: "Old Timer", symbol: "OLD", vault: null, ...over };
  const state = { token, events: [] as MindLaunchEvent[], treasury: treasury(), snap: snap() };
  const chain: MindsChain = {
    ...unreadChain,
    head: async () => 2000n,
    launches: async () => state.events,
    blockTime: async () => new Date(T0 - 3_600_000).toISOString(),
    tokenMeta: async () => ({ name: token.name ?? "x", symbol: token.symbol ?? "X" }),
    treasury: async () => state.treasury,
    snapshot: async () => state.snap,
    transfers: async () => [],
    earlierToken: async (t) => (t.toLowerCase() === token.token ? state.token : { token: t.toLowerCase(), pot: null, dev: null, name: null, symbol: null, vault: null }),
    earlierTokenOf: async (w) => (w.toLowerCase() === token.dev ? token.token : null),
  };
  /** The chain's record of the mind being given. */
  const give = async (by = dev) => {
    const ev: MindLaunchEvent = { kind: "attached", token: token.token, creator: by.toLowerCase(), agentRef: `0x${"0".repeat(64)}`, pot: token.pot!, splitter: null, vault: addr(), payout: null, taxBps: null, creatorBps: null, burnBps: null, axonBps: null, mindBps: null, blockNumber: 1500, txHash: `0x${"d".repeat(64)}` };
    state.events = [ev];
    state.token = { ...state.token, vault: ev.vault };
    getDb().exec("DELETE FROM mind_cursor");
    await indexMinds(chain, ENV);
    await refreshStats(chain, ENV);
    return ev;
  };
  return { token, chain, state, give };
}

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_attaches;"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("what the creator's wallet signs", () => {
  const SOL = readFileSync(join(process.cwd(), "contracts", "src", "MindLauncher.sol"), "utf8");
  it("is the launcher's own function and event", () => {
    expect(SOL).toMatch(/function attachMind\(address pot, MindVault\.Limits calldata limits\) external nonReentrant returns \(address vault\)/);
    expect(SOL).toMatch(/event MindAttached\(address indexed token, address indexed creator, address pot, address vault\);/);
    const fn = ATTACH_ABI.find((x) => x.type === "function")! as { name: string; inputs: readonly { type: string; name: string; components?: readonly { type: string; name: string }[] }[] };
    expect(fn.name).toBe("attachMind");
    expect(fn.inputs.map((i) => [i.type, i.name])).toEqual([["address", "pot"], ["tuple", "limits"]]);
    const limits = /struct Limits \{([^}]*)\}/.exec(readFileSync(join(process.cwd(), "contracts", "src", "MindVault.sol"), "utf8"))![1].split(";").map((l) => l.replace(/\/\/[^\n]*/g, "").trim()).filter(Boolean).map((l) => l.split(/\s+/));
    expect(fn.inputs[1].components!.map((c) => [c.type, c.name])).toEqual(limits);
    const ev = ATTACH_ABI.find((x) => x.type === "event")! as { inputs: readonly { type: string; name: string; indexed?: boolean }[] };
    expect(ev.inputs.map((i) => [i.type, i.name, Boolean(i.indexed)])).toEqual([["address", "token", true], ["address", "creator", true], ["address", "pot", false], ["address", "vault", false]]);
  });

  it("carries limits inside the treasury's ceilings, with rewards left out", () => {
    const l = { ...DEFAULT_SETTINGS, canReward: false };
    expect(checkLimits(l)).toBeNull();
    expect(mindLimits(l).allowed).toBe(CAN.buyback | CAN.burnAxon);
    expect(checkLimits({ ...l, maxPerActionEth: "1", maxPerDayEth: "0.5" })).toMatch(/One action/);
    expect(checkLimits({ ...l, maxActionsPerDay: 25 })).toMatch(/24 times/);
    expect(checkLimits({ ...l, maxCostPerDayEth: "0.5" })).toMatch(/0\.01 ETH a day/);
    expect(checkLimits({ ...l, maxPerDayEth: "a lot" })).toMatch(/amounts of ETH/);
  });
});

describe("who may give a token a mind", () => {
  it("is the wallet that launched it through its burn pot, and nobody else", async () => {
    const me = addr();
    const w = earlier(me);
    expect(await checkAttach(me, w.token.token, w.chain, ENV)).toMatchObject({ ok: true, reason: null, token: { symbol: "OLD", pot: w.token.pot } });
    expect(await checkAttach(me.toUpperCase().replace("0X", "0x"), w.token.token.toUpperCase().replace("0X", "0x"), w.chain, ENV)).toMatchObject({ ok: true });
    expect(await checkAttach(addr(), w.token.token, w.chain, ENV)).toMatchObject({ ok: false, reason: expect.stringMatching(/Only the wallet that launched/) });
    expect(await checkAttach(null, w.token.token, w.chain, ENV)).toMatchObject({ ok: false, reason: expect.stringMatching(/Connect the wallet/) });
  });

  it("says why a token cannot have one", async () => {
    const me = addr();
    const w = earlier(me);
    expect(await checkAttach(me, "not-an-address", w.chain, ENV)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a token address/) });
    expect(await checkAttach(me, w.token.token, w.chain, { ...ENV, NEXT_PUBLIC_MIND_LAUNCHER: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/not open yet/) });
    // a token somebody launched straight from a wallet has no burn pot
    expect(await checkAttach(me, addr(), w.chain, ENV)).toMatchObject({ ok: false, reason: expect.stringMatching(/not launched through a burn pot/) });
    const has = earlier(me, { vault: addr() });
    expect(await checkAttach(me, has.token.token, has.chain, ENV)).toMatchObject({ ok: false, reason: expect.stringMatching(/already has a mind/) });
  });

  it("finds the token a wallet launched through the earlier flow, when that flow is set up", async () => {
    const me = addr();
    const w = earlier(me);
    expect(await suggestAttach(me, w.chain, ENV)).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_AGENT_LAUNCH_FACTORY", "0xb2c910d4cf68a5b7c12e78e9bcdf7fd0cbd6b527");
    expect(await suggestAttach(me, w.chain, ENV)).toMatchObject({ ok: true, token: { token: w.token.token } });
    expect(await suggestAttach(addr(), w.chain, ENV)).toBeNull();
  });
});

describe("choosing its mind", () => {
  it("writes the choice down under the token's pot, and only for the wallet that may", async () => {
    const me = addr();
    const w = earlier(me);
    expect(await prepareAttach(addr(), { token: w.token.token }, w.chain, ENV)).toMatch(/Only the wallet that launched/);
    expect(getAttach(w.token.pot!)).toBeNull();
    expect(await prepareAttach(me, { token: w.token.token, model: "x-ai/grok-4.7" }, w.chain, ENV)).toEqual({ pot: w.token.pot, token: w.token.token, launcher: LAUNCHER });
    expect(getAttach(w.token.pot!)).toMatchObject({ wallet: me, model: "x-ai/grok-4.7", mindUrl: null, agentId: null });
    // choosing again before signing replaces the choice
    await prepareAttach(me, { token: w.token.token }, w.chain, ENV);
    expect(getAttach(w.token.pot!)?.model).toBe(DEFAULT_MIND_MODEL);
  });

  it("checks the model, an own server's address and the agent like a launch does", async () => {
    const me = addr();
    const w = earlier(me);
    expect(await prepareAttach(me, { token: w.token.token, model: "openai/gpt-2" }, w.chain, ENV)).toMatch(/models on the list/);
    expect(await prepareAttach(me, { token: w.token.token, model: OWN_MIND }, w.chain, ENV)).toMatch(/Give the address/);
    expect(await prepareAttach(me, { token: w.token.token, model: OWN_MIND, mindUrl: "https://mind.example.com/wake" }, w.chain, ENV)).toMatchObject({ pot: w.token.pot });
    expect(getAttach(w.token.pot!)).toMatchObject({ model: OWN_MIND, mindUrl: "https://mind.example.com/wake" });
    expect(await prepareAttach(me, { token: w.token.token, agentId: "nobody-has-this" }, w.chain, ENV)).toMatch(/not an agent of yours/);
  });
});

describe("when the chain shows the mind was given", () => {
  it("lists the token with the mind its creator chose and the agent they named", async () => {
    const me = addr();
    const w = earlier(me);
    const agent = createAgent({ agentId: `old-${n}`, name: "Old Timer Agent", capabilities: ["x"], publicKey: "k", provider: "anthropic", walletAddress: me, createdAt: new Date().toISOString() } as Agent);
    await prepareAttach(me, { token: w.token.token, model: "x-ai/grok-4.7", agentId: agent.agentId }, w.chain, ENV);
    const ev = await w.give();
    expect(board()[0]).toMatchObject({ token: w.token.token, attached: true, name: "Old Timer", symbol: "OLD", model: "x-ai/grok-4.7", agentId: agent.agentId, agentName: "Old Timer Agent", vault: ev.vault, splitter: null, taxBps: null });
    expect(events().map((e) => e.kind)).toContain("attached");
    expect(events().map((e) => e.kind)).not.toContain("launch");
  });

  it("uses nothing somebody else prepared for that pot", async () => {
    const me = addr(), other = addr();
    const w = earlier(me);
    // written straight in, as if another wallet's choice had got there: it must not be picked up
    getDb().prepare("INSERT INTO mind_attaches (pot, wallet, token, agent_id, model, mind_url, created_at) VALUES (?,?,?,?,?,?,?)").run(w.token.pot, other, w.token.token, null, OWN_MIND, "https://not-yours.example.com", new Date().toISOString());
    await w.give(me);
    expect(board()[0]).toMatchObject({ model: DEFAULT_MIND_MODEL, agentId: null });
    expect((getDb().prepare("SELECT mind_url FROM mind_tokens WHERE token = ?").get(w.token.token) as { mind_url: string | null }).mind_url).toBeNull();
  });
});

describe("a mind given to an earlier token", () => {
  const thinker = (answer: unknown) => { const calls: string[] = []; const fn: Thinker = async (_m, _s, prompt) => { calls.push(prompt); return { text: JSON.stringify(answer), inputTokens: 1000, outputTokens: 200, costUsd: 0.02 }; }; return { fn, calls }; };
  const got = (r: Thought | { skipped: string }): Thought => { if ("skipped" in r) throw new Error(`skipped: ${r.skipped}`); return r; };

  it("has an empty treasury that only top-ups fill, and wakes when one arrives", async () => {
    const me = addr();
    const w = earlier(me);
    await w.give();
    const k = thinker({ thought: "Somebody funded me. I will put part of it into a buyback.", action: { kind: "buyback", eth: 0.002 } });
    const opts = { chain: w.chain, thinker: k.fn, env: ENV, usdPerEth: 2500 };
    // given a mind, but nothing to think with yet
    expect(await thinkOnce(w.token.token, { ...opts, now: T0 })).toEqual({ skipped: "its treasury cannot pay for a thought yet" });
    w.state.treasury = treasury(0.01);
    w.state.snap = snap(0.01);
    await refreshStats(w.chain, ENV);
    expect(events().map((e) => e.kind)).toContain("topup");
    const h = got(await thinkOnce(w.token.token, { ...opts, now: T0 }));
    expect(h.reasons).toEqual(expect.arrayContaining(["being given a mind", "its treasury being topped up (0.01000 ETH)"]));
    expect(h).toMatchObject({ verdict: "approved", action: { kind: "buyback", eth: 0.002 } });
    // it is told what it is: fees do not reach it, and rewarding holders is not among what it may do
    expect(k.calls[0]).toContain("this token was launched before minds");
    expect(k.calls[0]).toContain("may: buy back and burn, burn $AXON");
    expect(k.calls[0]).not.toContain("reward holders");
  });

  it("is refused a reward by the rule check, whatever its limits say", async () => {
    const base = { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, availableEth: 0.02, owedThinkingEth: 0, spentTodayEth: 0, actionsToday: 0, active: true, phase: 2, holders: 500 };
    expect(checkProposal({ kind: "reward", eth: 0.001 }, { ...base, attached: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/not open for a token launched before minds/) });
    expect(checkProposal({ kind: "reward", eth: 0.001 }, { ...base, attached: false })).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.001 }, { ...base, attached: true })).toEqual({ ok: true });
    const me = addr();
    const w = earlier(me);
    await w.give();
    w.state.treasury = treasury(0.01); w.state.snap = snap(0.01);
    await refreshStats(w.chain, ENV);
    const h = got(await thinkOnce(w.token.token, { chain: w.chain, thinker: thinker({ thought: "I want to reward the people who held on.", action: { kind: "reward", eth: 0.001 } }).fn, env: ENV, usdPerEth: 2500, now: T0 }));
    expect(h).toMatchObject({ verdict: "refused", verdictReason: expect.stringMatching(/launched before minds/) });
  });

  it("does not report holders it has only counted from the day it got its mind", async () => {
    const me = addr();
    const w = earlier(me);
    await w.give();
    for (let i = 0; i < 5; i++) getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(w.token.token, addr(), "1000");
    await refreshStats(w.chain, ENV);
    expect(events().map((e) => e.kind)).not.toContain("holders");
  });
});
