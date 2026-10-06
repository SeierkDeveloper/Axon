// Agent Minds 2, phase 2: the plan a mind works to: its mission, a goal it is measured against, how it divides its
// treasury, and a reserve floor the rule check enforces.
// stand-in. No ETH moves in this phase at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, addEvent } from "@/lib/mindsStats";
import { checkProposal } from "@/lib/mindsRules";
import { standInThinker, type Thinker } from "@/lib/mindsThinker";
import { thinkOnce, type Thought } from "@/lib/mindsMind";
import { CAN } from "@/lib/mindsLaunch";
import { unreadChain } from "./helpers/unreadChain";

let n = 0;
const addr = () => `0x${(++n + 9_700_000).toString(16).padStart(40, "0")}`;
const LIVE = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: "0x00000000000000000000000000000000000a110c", MIND_DEPLOY_BLOCK: "1000", MINDS_THINKING: "live", ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k" };
const USD = 2500; // dollars for one ETH, so one dollar is 0.0004 ETH
const T0 = Date.UTC(2026, 9, 5, 12);

const treasury = (over: Partial<Treasury> = {}, limits: Partial<Treasury["limits"]> = {}): Treasury => ({
  availableEth: 0.02, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true,
  limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01, ...limits }, ...over,
});
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ phase: 0, curve: addr(), priceEth: 2e-9, supply: 1e9, curveBps: 1000, feesEth: 0.05, toMindEth: 0.01, burnedTokens: 0, burnedEth: 0, burns: 0, treasuryEth: 0.02, poolManager: null, ...over });

function world() {
  const state = { launches: [] as MindLaunchEvent[], snaps: new Map<string, Snapshot>(), treasuries: new Map<string, Treasury>() };
  const chain: MindsChain = {
    ...unreadChain,
    head: async () => 2000n,
    launches: async () => state.launches,
    blockTime: async () => new Date(T0 - 3_600_000).toISOString(),
    tokenMeta: async () => { throw new Error("none"); },
    treasury: async (vault) => state.treasuries.get(vault) ?? treasury(),
    feeFlow: async () => { throw new Error("unused"); },
    snapshot: async (t) => state.snaps.get(t.token)!,
    transfers: async () => [],
    vaultDay: async () => ({ spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 }),
  };
  const launch = async (symbol: string, model?: string) => {
    const me = addr();
    const p = prepare(me, { name: `${symbol} Token`, symbol, line: "Explains company filings in plain words", ...(model ? { model } : {}) });
    if (typeof p === "string") throw new Error(p);
    const ev: MindLaunchEvent = { kind: "launched", token: addr(), creator: me, agentRef: p.ref, pot: addr(), splitter: addr(), vault: addr(), payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, blockNumber: 1100 + n, txHash: `0x${String(n).padStart(64, "0")}` };
    state.launches.push(ev);
    state.snaps.set(ev.token, snap());
    await indexMinds(chain, LIVE);
    getDb().exec("DELETE FROM mind_cursor"); // every launch in these tests is read fresh
    await indexMinds(chain, LIVE);
    await refreshStats(chain, LIVE);
    return ev;
  };
  return { state, chain, launch };
}

/** A thinker written here: says what it is told to, and counts what it was asked. */
function thinker(answer: unknown, cost = 0.02) {
  const calls: { model: string; system: string; prompt: string }[] = [];
  const fn: Thinker = async (model, system, prompt) => { calls.push({ model: model.id, system, prompt }); return { text: typeof answer === "string" ? answer : JSON.stringify(answer), inputTokens: 1500, outputTokens: 300, costUsd: cost }; };
  return { fn, calls };
}
const got = (r: Thought | { skipped: string }): Thought => { if ("skipped" in r) throw new Error(`skipped: ${r.skipped}`); return r; };
import { readPlan, savePlan, planOf, planLog, progressOf, planLines, reserveOf, goalText, PLAN_MIN_MS, type Plan } from "@/lib/mindsPlan";

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history;"); });

const ALL = CAN.buyback | CAN.reward | CAN.burnAxon;
const WRITTEN = { mission: "Grow past 100 holders and keep a third in reserve.", goal: { kind: "holders", target: 100 }, split: { buyback: 40, reward: 30, burn_axon: 0, reserve: 30 }, reserve_eth: 0.006, thesis: "Buy back on dips, reward when holders grow." };
const NUMBERS = { holders: 54, mcapEth: 3.2, burnedTokens: 250_000, curveBps: 4200, phase: 0 };

describe("reading a plan out of a mind's answer", () => {
  it("takes a well-formed plan as it was written", () => {
    expect(readPlan(WRITTEN, { allowed: ALL })).toEqual({
      mission: "Grow past 100 holders and keep a third in reserve.", goal: { kind: "holders", target: 100 },
      split: { buyback: 40, reward: 30, burnAxon: 0, reserve: 30 }, reserveEth: 0.006, thesis: "Buy back on dips, reward when holders grow.",
    });
  });

  it("brings the shares to exactly 100, and moves a share for something it may not do into the reserve", () => {
    // shares that leave room: the reserve is whatever the three leave
    expect(readPlan({ ...WRITTEN, split: { buyback: 50, reward: 20 } }, { allowed: ALL })!.split).toEqual({ buyback: 50, reward: 20, burnAxon: 0, reserve: 30 });
    // more than everything promised to spending: scaled down in proportion, nothing left for reserve
    expect(readPlan({ ...WRITTEN, split: { buyback: 100, reward: 100, burn_axon: 0, reserve: 50 } }, { allowed: ALL })!.split).toEqual({ buyback: 50, reward: 50, burnAxon: 0, reserve: 0 });
    // it was never allowed to reward holders: that share is not spent, it is kept
    expect(readPlan(WRITTEN, { allowed: CAN.buyback })!.split).toEqual({ buyback: 40, reward: 0, burnAxon: 0, reserve: 60 });
    // a token launched before minds cannot reward either
    expect(readPlan(WRITTEN, { allowed: ALL, attached: true })!.split.reward).toBe(0);
    for (const split of [{ buyback: 33.4, reward: 33.3, burn_axon: 33.3 }, { buyback: "45", reward: -5, burn_axon: 900 }, {}]) {
      const s = readPlan({ ...WRITTEN, split }, { allowed: ALL })!.split;
      expect(s.buyback + s.reward + s.burnAxon + s.reserve).toBe(100);
      for (const v of Object.values(s)) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); }
    }
  });

  it("keeps only a goal it can measure, and a reserve that is an amount", () => {
    expect(readPlan({ ...WRITTEN, goal: { kind: "graduate", target: 5 } }, { allowed: ALL })!.goal).toEqual({ kind: "graduate", target: null });
    expect(readPlan({ ...WRITTEN, goal: { kind: "Market Cap ETH", target: "12.5" } }, { allowed: ALL })!.goal).toEqual({ kind: "market_cap_eth", target: 12.5 });
    for (const goal of [{ kind: "price", target: 2 }, { kind: "holders", target: 0 }, { kind: "holders" }, "more holders", null]) expect(readPlan({ ...WRITTEN, goal }, { allowed: ALL })!.goal).toBeNull();
    for (const reserve_eth of [-1, "lots", null, undefined]) expect(readPlan({ ...WRITTEN, reserve_eth }, { allowed: ALL })!.reserveEth).toBe(0);
    expect(readPlan({ ...WRITTEN, reserve_eth: 1e9 }, { allowed: ALL })!.reserveEth).toBe(1000);
  });

  it("is nothing without a mission, and its sentences are made safe to show", () => {
    for (const raw of [null, "a plan", [], {}, { ...WRITTEN, mission: "" }, { ...WRITTEN, mission: 7 }, { ...WRITTEN, mission: "short" }]) expect(readPlan(raw, { allowed: ALL })).toBeNull();
    const p = readPlan({ ...WRITTEN, mission: "Grow   holders \u2014 slowly,\n and keep a reserve.", thesis: "x".repeat(400) }, { allowed: ALL })!;
    expect(p.mission).toBe("Grow holders, slowly, and keep a reserve.");
    expect(p.thesis!.length).toBeLessThanOrEqual(241);
    expect(readPlan({ ...WRITTEN, thesis: 12 }, { allowed: ALL })!.thesis).toBeNull();
  });
});

describe("keeping a plan", () => {
  const plan = readPlan(WRITTEN, { allowed: ALL })!;
  const T = "0x00000000000000000000000000000000000a11a5";

  it("takes the first at once, lets it stand six hours, and keeps every version", () => {
    expect(planOf(T)).toBeNull(); expect(reserveOf(T)).toBe(0);
    expect(savePlan(T, plan, 1, { now: T0 })).toBe("set");
    expect(planOf(T)).toMatchObject({ mission: plan.mission, reserveEth: 0.006, revisions: 0, thoughtId: 1, setAt: new Date(T0).toISOString() });
    expect(reserveOf(T.toUpperCase().replace("0X", "0x"))).toBe(0.006);

    const next: Plan = { ...plan, mission: "Reach graduation and reward the ones who stayed.", reserveEth: 0.004 };
    expect(savePlan(T, plan, 2, { now: T0 + 60_000 })).toBe("same");
    expect(savePlan(T, next, 2, { now: T0 + PLAN_MIN_MS - 1 })).toBe("too_soon");
    expect(planOf(T)!.mission).toBe(plan.mission);
    expect(savePlan(T, next, 3, { now: T0 + PLAN_MIN_MS })).toBe("revised");
    expect(planOf(T)).toMatchObject({ mission: next.mission, reserveEth: 0.004, revisions: 1, thoughtId: 3 });
    expect(planLog(T).map((v) => v.plan.mission)).toEqual([next.mission, plan.mission]);
  });

  it("may be rewritten at once when its goal has been reached", () => {
    savePlan(T, plan, 1, { now: T0 });
    const next: Plan = { ...plan, goal: { kind: "holders", target: 250 } };
    expect(savePlan(T, next, 2, { now: T0 + 60_000 })).toBe("too_soon");
    expect(savePlan(T, next, 2, { now: T0 + 60_000, reached: true })).toBe("revised");
    expect(planOf(T)!.goal).toEqual({ kind: "holders", target: 250 });
  });
});

describe("how far along its goal a token is", () => {
  it("measures each kind of goal from the token's own numbers", () => {
    expect(progressOf({ goal: { kind: "holders", target: 100 } }, NUMBERS)).toEqual({ now: 54, target: 100, percent: 54, reached: false });
    expect(progressOf({ goal: { kind: "holders", target: 50 } }, NUMBERS)).toEqual({ now: 54, target: 50, percent: 100, reached: true });
    expect(progressOf({ goal: { kind: "market_cap_eth", target: 10 } }, NUMBERS)).toMatchObject({ now: 3.2, percent: 32, reached: false });
    expect(progressOf({ goal: { kind: "market_cap_eth", target: 10 } }, { ...NUMBERS, mcapEth: null })).toEqual({ now: null, target: 10, percent: null, reached: false });
    expect(progressOf({ goal: { kind: "burned_tokens", target: 1_000_000 } }, NUMBERS)).toMatchObject({ percent: 25, reached: false });
    expect(progressOf({ goal: { kind: "graduate", target: null } }, NUMBERS)).toEqual({ now: 42, target: 100, percent: 42, reached: false });
    expect(progressOf({ goal: { kind: "graduate", target: null } }, { ...NUMBERS, phase: 2 })).toMatchObject({ percent: 100, reached: true });
    expect(progressOf({ goal: null }, NUMBERS)).toBeNull();
    expect(goalText({ kind: "holders", target: 100 })).toBe("100 holders");
    expect(goalText({ kind: "burned_tokens", target: 1_000_000 })).toBe("1,000,000 tokens burned");
  });
});

describe("the reserve a plan keeps", () => {
  const ctx = { allowed: ALL, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, availableEth: 0.02, owedThinkingEth: 0, spentTodayEth: 0, actionsToday: 0, active: true, phase: 0, holders: 30 };

  it("is enforced by the rule check, not left to the mind", () => {
    // 0.02 held, 0.0002 kept for thinking: 0.0198 free. With a 0.015 floor, 0.0048 is free above it.
    expect(checkProposal({ kind: "buyback", eth: 0.004 }, { ...ctx, reserveEth: 0.015 })).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.006 }, { ...ctx, reserveEth: 0.015 })).toEqual({ ok: false, reason: "It would take the treasury below the reserve its own plan keeps (0.015 ETH): 0.004800 ETH is free above it." });
    // a floor above everything it holds refuses every move, and says so
    expect(checkProposal({ kind: "reward", eth: 0.001 }, { ...ctx, reserveEth: 0.5 })).toMatchObject({ ok: false, reason: expect.stringMatching(/0\.000000 ETH is free above it/) });
    // no plan, no floor: as before
    expect(checkProposal({ kind: "buyback", eth: 0.006 }, ctx)).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.006 }, { ...ctx, reserveEth: 0 })).toEqual({ ok: true });
  });
});

describe("a mind writing and keeping to its plan", () => {
  it("is told it has none, writes one, and reads it back next time with its progress", async () => {
    const w = world(), t = await w.launch("PLAN");
    const first = thinker({ thought: "Fees came in. I am setting my plan before I spend anything.", action: null, plan: WRITTEN });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: first.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(first.calls[0].prompt).toContain('your_plan: none yet. Write your first one in this answer (see "plan" below).');
    expect(first.calls[0].system).toMatch(/You work to a plan that you write yourself/);
    expect(first.calls[0].system).toMatch(/"plan": \{"mission"/);
    expect(planOf(t.token)).toMatchObject({ mission: WRITTEN.mission, reserveEth: 0.006, revisions: 0 });

    addEvent(t.token, "fees", { eth: 0.004 });
    const second = thinker({ thought: "Holding to the plan. Nothing to add.", action: null });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: second.fn, env: LIVE, now: T0 + 3_600_000, usdPerEth: USD }));
    const p = second.calls[0].prompt;
    expect(p).toContain("your_plan (written 1 h 0 min ago):");
    expect(p).toContain("  mission: Grow past 100 holders and keep a third in reserve.");
    expect(p).toMatch(/  goal: 100 holders \(now \d+, \d+% of the way\)/);
    expect(p).toContain("  split: buybacks 40%, rewards 30%, $AXON burn 0%, reserve 30%");
    expect(p).toContain("  reserve_floor_eth: 0.006 (the rule check refuses anything that would take the treasury below it)");
    expect(p).toContain("  spent_so_far: nothing yet");
    expect(p).toContain("  you_may_rewrite_it: not for another 5 h 0 min");
    // what it is told is free already leaves the reserve out: 0.02 held, 0.0002 for thinking, 0.006 floor, and what the first thought cost
    const free = Number(/free_to_spend_eth: ([0-9.e-]+)/.exec(p)![1]);
    expect(free).toBeGreaterThan(0.0135); expect(free).toBeLessThan(0.0138);
  });

  it("has a proposal that would break its reserve refused, in the same answer that sets the reserve", async () => {
    const w = world(), t = await w.launch("FLOOR");
    const k = thinker({ thought: "Setting a high reserve and trying to spend past it anyway.", action: { kind: "buyback", eth: 0.009 }, plan: { ...WRITTEN, reserve_eth: 0.015 } });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(th.verdict).toBe("refused");
    expect(th.verdictReason).toMatch(/below the reserve its own plan keeps \(0\.015 ETH\)/);
    expect(reserveOf(t.token)).toBe(0.015);
  });

  it("cannot rewrite its plan every time it thinks, and a rewrite that is too soon changes nothing", async () => {
    const w = world(), t = await w.launch("FIRM");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "My first plan, written now.", action: null, plan: WRITTEN }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    addEvent(t.token, "fees", { eth: 0.004 });
    // twenty minutes later it tries to drop its reserve to nothing and spend it: the old reserve still holds
    const k = thinker({ thought: "Changing my mind already.", action: { kind: "buyback", eth: 0.01 }, plan: { ...WRITTEN, mission: "Spend it all right now, no reserve at all.", reserve_eth: 0 } });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + 20 * 60_000, usdPerEth: USD }));
    expect(planOf(t.token)!.mission).toBe(WRITTEN.mission);
    expect(reserveOf(t.token)).toBe(0.006);
    expect(th.verdict).toBe("approved"); // 0.01 fits above the 0.006 floor
    expect(planLog(t.token)).toHaveLength(1);
  });

  it("gets a plain first plan from the stand-in thinker, so everything built on a plan works without a model", async () => {
    const w = world(), t = await w.launch("STND");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: standInThinker, env: LIVE, now: T0, usdPerEth: USD }));
    const p = planOf(t.token)!;
    expect(p.mission).toMatch(/measured steps/);
    expect(p.goal).toEqual({ kind: "holders", target: 10 });
    expect(p.split.buyback + p.split.reward + p.split.burnAxon + p.split.reserve).toBe(100);
    expect(p.reserveEth).toBeGreaterThan(0);
    // and it does not write another while that one stands
    addEvent(t.token, "fees", { eth: 0.004 });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: standInThinker, env: LIVE, now: T0 + 3_600_000, usdPerEth: USD }));
    expect(planLog(t.token)).toHaveLength(1);
  });

  it("reads the same lines the mind does", () => {
    const stored = { ...readPlan(WRITTEN, { allowed: ALL })!, setAt: new Date(T0).toISOString(), revisions: 2, thoughtId: 1 };
    const lines = planLines(stored, { ...NUMBERS, holders: 120 }, { buybackEth: 0.03, rewardEth: 0.01, burnAxonEth: 0 }, T0 + 7 * 3_600_000);
    expect(lines[0]).toBe("your_plan (written 7 h 0 min ago, revised 2 times):");
    expect(lines).toContain("  goal: 100 holders (REACHED: set your next goal in this answer)");
    expect(lines).toContain("  spent_so_far: buybacks 0.03 ETH (75%), rewards 0.01 ETH (25%), $AXON burn 0 ETH (0%)");
    expect(lines.at(-1)).toBe("  you_may_rewrite_it: yes, your goal is reached");
    expect(planLines(stored, NUMBERS, { buybackEth: 0, rewardEth: 0, burnAxonEth: 0 }, T0 + 7 * 3_600_000).at(-1)).toBe("  you_may_rewrite_it: yes, if something has really changed");
  });
});
