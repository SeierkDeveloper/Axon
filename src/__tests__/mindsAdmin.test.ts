// Agent Minds, phase 11: Axon's own stop switches and the admin's account of what minds cost and paid back.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, board } from "@/lib/mindsStats";
import { thinkOnce, thinkDue } from "@/lib/mindsMind";
import { actDue, payThinkingDue, keepUp, settleSent, actingEnabled, type MindSender } from "@/lib/mindsAct";
import { mindsHalted, setHalted, stopMind, resumeMind, isStopped, overview } from "@/lib/mindsAdmin";
import type { Thinker } from "@/lib/mindsThinker";
import { unreadChain } from "./helpers/unreadChain";

let n = 0;
const addr = () => `0x${(++n + 9_998_000).toString(16).padStart(40, "0")}`;
const ENV = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: "0x00000000000000000000000000000000000a110c", MIND_DEPLOY_BLOCK: "1000", MINDS_THINKING: "live", MINDS_ACTING: "on", MIND_SIGNER_KEY: `0x${"7".repeat(64)}`, ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k", MINDS_DAILY_BUDGET_USD: "1000" };
const T0 = Date.UTC(2026, 9, 5, 12);
const treasury: Treasury = { availableEth: 0.02, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true, limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01 } };
const snap: Snapshot = { phase: 0, curve: addr(), priceEth: 2e-9, supply: 1e9, curveBps: 1000, feesEth: 0.05, toMindEth: 0.01, burnedTokens: 0, burnedEth: 0, burns: 0, treasuryEth: 0.02, poolManager: null };

function world() {
  const launches: MindLaunchEvent[] = [];
  const chain: MindsChain = { ...unreadChain, head: async () => 2000n, launches: async () => launches, blockTime: async () => new Date(T0 - 3_600_000).toISOString(), tokenMeta: async () => { throw new Error("none"); }, treasury: async () => treasury, snapshot: async () => snap, transfers: async () => [] };
  const launch = async (symbol: string) => {
    const me = addr();
    const p = prepare(me, { name: `${symbol} Token`, symbol, line: "Explains company filings in plain words" });
    if (typeof p === "string") throw new Error(p);
    const ev: MindLaunchEvent = { kind: "launched", token: addr(), creator: me, agentRef: p.ref, pot: addr(), splitter: addr(), vault: addr(), payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, blockNumber: 1100 + n, txHash: `0x${String(n).padStart(64, "0")}` };
    launches.push(ev);
    getDb().exec("DELETE FROM mind_cursor");
    await indexMinds(chain, ENV);
    await refreshStats(chain, ENV);
    return ev;
  };
  const thinker = (action: unknown, cost = 0.5): Thinker => async () => ({ text: JSON.stringify({ thought: "The numbers give a reason to act, within my limits.", action }), inputTokens: 1000, outputTokens: 200, costUsd: cost });
  const sent: { to: string; fn: string }[] = [];
  const sender: MindSender = { address: () => "0x51617e", simulate: async (_t, _a, fn) => (fn === "sweep" ? 10n ** 16n : fn === "preview" ? [1n, 0n, true] : undefined), send: async (to, _a, fn) => { sent.push({ to, fn }); return `0x${(sent.length).toString(16).padStart(64, "e")}`; }, wait: async () => ({ ok: true, logs: [] }) };
  return { chain, launch, thinker, sender, sent };
}

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_settings;"); });

describe("stopping every mind", () => {
  it("is off until switched, and can be switched back", () => {
    expect(mindsHalted()).toBe(false);
    setHalted(true);
    expect(mindsHalted()).toBe(true);
    expect(overview().halted).toBe(true);
    setHalted(false);
    expect(mindsHalted()).toBe(false);
  });

  it("stops thinking, sending, paying and housekeeping at once, and lets them go on again", async () => {
    const w = world(), t = await w.launch("LENS");
    const opts = { chain: w.chain, env: ENV, usdPerEth: 2500 };
    setHalted(true);
    expect(await thinkOnce(t.token, { ...opts, thinker: w.thinker(null), now: T0 })).toEqual({ skipped: "every mind is stopped" });
    expect(await thinkDue({ ...opts, thinker: w.thinker(null), now: T0 })).toBeNull();
    expect(actingEnabled(ENV)).toBe(false);
    expect(await actDue({ chain: w.chain, sender: w.sender, env: ENV, now: T0 })).toBeNull();
    expect(await payThinkingDue({ chain: w.chain, sender: w.sender, env: ENV })).toBe(0);
    expect(await keepUp({ chain: w.chain, sender: w.sender, env: ENV })).toBeNull();
    expect(w.sent).toHaveLength(0);
    expect((getDb().prepare("SELECT COUNT(*) n FROM mind_thoughts").get() as { n: number }).n).toBe(0);
    setHalted(false);
    expect("skipped" in (await thinkOnce(t.token, { ...opts, thinker: w.thinker({ kind: "buyback", eth: 0.002 }), now: T0 }))).toBe(false);
    expect(await actDue({ chain: w.chain, sender: w.sender, env: ENV, now: T0 })).toEqual({ done: 1, failed: 0, dropped: 0 });
  });

  it("still closes the record of what was already sent", async () => {
    const w = world(), t = await w.launch("LENS");
    getDb().prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, tx_hash, at, updated_at) VALUES (NULL,?,?,?,?,?,?,?,?)").run(t.token, "buyback", "1", 1e-18, "sent", `0x${"a".repeat(64)}`, new Date(T0).toISOString(), new Date(T0).toISOString());
    setHalted(true);
    expect(await settleSent({ sender: w.sender, env: ENV })).toBe(1);
    expect(w.sent).toHaveLength(0);
  });
});

describe("stopping one mind", () => {
  it("stops that mind and leaves the others alone", async () => {
    const w = world();
    const a = await w.launch("AAA"), b = await w.launch("BBB");
    expect(stopMind(a.token.toUpperCase().replace("0X", "0x"), "its creator asked")).toBe(true);
    expect(stopMind(addr(), null)).toBe(false);
    expect(isStopped(a.token)).toBe(true);
    const opts = { chain: w.chain, env: ENV, usdPerEth: 2500, thinker: w.thinker({ kind: "buyback", eth: 0.002 }) };
    expect(await thinkOnce(a.token, { ...opts, now: T0 })).toEqual({ skipped: "the mind is stopped" });
    expect(await thinkDue({ ...opts, now: T0 })).toEqual({ thought: 1, skipped: 0 });
    expect((getDb().prepare("SELECT token FROM mind_thoughts").all() as { token: string }[]).map((r) => r.token)).toEqual([b.token]);
    expect(board().find((r) => r.token === a.token)).toMatchObject({ stopped: true });
    expect(board().find((r) => r.token === b.token)).toMatchObject({ stopped: false, thoughts: 1 });
  });

  it("sends nothing for it, even a proposal the rule check had already passed, and no housekeeping", async () => {
    const w = world();
    const a = await w.launch("AAA"), b = await w.launch("BBB");
    const opts = { chain: w.chain, env: ENV, usdPerEth: 2500, thinker: w.thinker({ kind: "buyback", eth: 0.002 }) };
    await thinkDue({ ...opts, now: T0 });
    stopMind(a.token, null);
    expect(await actDue({ chain: w.chain, sender: w.sender, env: ENV, now: T0 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    expect(w.sent.map((x) => x.to)).toEqual([b.vault]);
    await payThinkingDue({ chain: w.chain, sender: w.sender, env: ENV });
    await keepUp({ chain: w.chain, sender: w.sender, env: ENV });
    const own = new Set([a.vault, a.pot, a.splitter]);
    expect(w.sent.some((x) => own.has(x.to))).toBe(false);
    // let go on in time, its proposal is still sent; nothing was lost by the stop
    expect(resumeMind(a.token)).toBe(true);
    expect(await actDue({ chain: w.chain, sender: w.sender, env: ENV, now: T0 + 60_000 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    expect(w.sent.some((x) => x.to === a.vault && x.fn === "buyback")).toBe(true);
  });
});

describe("the admin's account", () => {
  it("adds up what each mind cost, paid back, still owes and sent", async () => {
    const w = world(), t = await w.launch("LENS");
    const opts = { chain: w.chain, env: ENV, usdPerEth: 2500 };
    await thinkOnce(t.token, { ...opts, thinker: w.thinker({ kind: "buyback", eth: 0.002 }, 1), now: T0 });
    await actDue({ chain: w.chain, sender: w.sender, env: ENV, now: T0 });
    await payThinkingDue({ chain: w.chain, sender: w.sender, env: ENV });
    getDb().prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, cost_usd, cost_eth) VALUES (?,?,?,1,'thought','[]','free',9,0.0036)").run(t.token, new Date(T0).toISOString(), "claude-opus-5-5");
    const o = overview();
    const m = o.minds.find((x) => x.token === t.token)!;
    expect(m).toMatchObject({ symbol: "LENS", model: "Claude Opus 5.5", thoughts: 2, failedThoughts: 0, thinkingUsd: 1, boughtBackEth: 0.002, actions: 1, notSent: 0, attached: false, stoppedAt: null, treasuryEth: 0.02, paidInEth: 0.01 });
    expect(m.thinkingEth).toBeCloseTo(0.0004, 12);
    expect(m.paidBackEth).toBeCloseTo(0.0004, 12);
    expect(m.owedEth).toBeCloseTo(0, 12);
    expect(o).toMatchObject({ tokens: 1, halted: false });
    expect(o.thinkingEth).toBeCloseTo(0.0004, 12);
    expect(o.open).toEqual([]);
  });

  it("lists what was sent and never confirmed", async () => {
    const w = world(), t = await w.launch("LENS");
    getDb().prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, tx_hash, at, updated_at) VALUES (NULL,?,?,?,?,?,?,?,?)").run(t.token, "buyback", "2000000000000000", 0.002, "sent", `0x${"a".repeat(64)}`, new Date(T0).toISOString(), new Date(T0).toISOString());
    expect(overview().open).toMatchObject([{ token: t.token, kind: "buyback", eth: 0.002, status: "sent" }]);
  });
});
