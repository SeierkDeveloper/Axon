// Agent Minds 2, phase 5: the pulse. A mind that nothing has woken checks in on its own, at a pace its treasury can
// afford, and at once when its radar flags something unusual.
// stand-in. No ETH moves in this phase at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, addEvent } from "@/lib/mindsStats";
import { type Thinker } from "@/lib/mindsThinker";
import { thinkOnce, thinkDue, thoughts, MIN_GAP_MS, type Thought } from "@/lib/mindsMind";
import { sample } from "@/lib/mindsSenses";
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
import { pulseEveryMs, pulseState, pulseEnabled, pulseSpan, PULSE_MIN_MS, PULSE_MAX_MS, PULSE_OWN_MS, RADAR_GAP_MS } from "@/lib/mindsPulse";
import { fireDue } from "@/lib/mindsOrders";
import { mindStatus } from "@/lib/mindsStatus";
import { setHalted } from "@/lib/mindsAdmin";

beforeEach(() => { setHalted(false); getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history; DELETE FROM mind_orders;"); });

const setCap = (token: string, eth: number | null) => getDb().prepare("UPDATE mind_stats SET mcap_eth = ? WHERE token = ?").run(eth, token);
const H = 3_600_000;
const why = (r: Thought | { skipped: string }): string => ("skipped" in r ? r.skipped : "it thought");
const quietly = (text = "Nothing has changed since I last looked. Holding.") => thinker({ thought: text, action: null });

describe("how often a mind checks in", () => {
  // one thought on the first model costs about $0.0244, which is 0.00000976 ETH at $2,500
  const estimateEth = 0.0244 / USD;

  it("is hourly at most and daily at least, and in between is set by what its treasury holds", () => {
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: 0.08 })).toBe(PULSE_MIN_MS);
    // 0.005 ETH: a fiftieth is 0.0001 ETH a day, about ten thoughts, so about every 2 h 20 min
    const mid = pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: 0.005 })!;
    expect(mid).toBeGreaterThan(2.3 * H); expect(mid).toBeLessThan(2.4 * H);
    // 0.0006 ETH: just over one thought a day
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: 0.0006 })).toBeGreaterThan(19 * H);
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: 0.0006 })).toBeLessThanOrEqual(PULSE_MAX_MS);
  });

  it("does not check in at all on a treasury too small to pay for one a day", () => {
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: 0.0004 })).toBeNull();
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: 0 })).toBeNull();
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.01, treasuryEth: -1 })).toBeNull();
  });

  it("is held by the thinking limit its creator locked: check-ins may use half of it", () => {
    // a limit of 0.0001 ETH a day: half is 0.00005, about five thoughts, so about every 4 h 40 min however full the treasury
    const tight = pulseEveryMs({ estimateEth, ceilingEth: 0.0001, treasuryEth: 5 })!;
    expect(tight).toBeGreaterThan(4.6 * H); expect(tight).toBeLessThan(4.8 * H);
    expect(pulseEveryMs({ estimateEth, ceilingEth: 0.00001, treasuryEth: 5 })).toBeNull();
  });

  it("has one pace for a mind on its creator's own server, which costs nothing to wake", () => {
    expect(pulseEveryMs({ own: true, estimateEth: 0, ceilingEth: 0, treasuryEth: 0 })).toBe(PULSE_OWN_MS);
  });

  it("is on wherever minds think, and off when it is switched off", () => {
    expect(pulseEnabled({})).toBe(true);
    expect(pulseEnabled({ MINDS_PULSE: "on" })).toBe(true);
    expect(pulseEnabled({ MINDS_PULSE: " OFF " })).toBe(false);
    expect([pulseSpan(40 * 60_000), pulseSpan(2 * H + 5 * 60_000), pulseSpan(3 * H), pulseSpan(72 * H)]).toEqual(["40 min", "2 h 5 min", "3 h", "3 days"]);
  });
});

describe("a quiet mind checking in", () => {
  const first = async (w: ReturnType<typeof world>, symbol: string) => {
    const t = await w.launch(symbol);
    got(await thinkOnce(t.token, { chain: w.chain, thinker: quietly("The launch. Nothing to do yet.").fn, env: LIVE, now: T0, usdPerEth: USD }));
    return t;
  };

  it("does not think when nothing happened and its check-in is not due, and costs no call to the chain to find that out", async () => {
    const w = world(), t = await first(w, "CALM");
    let asked = 0;
    const chain = { ...w.chain, treasury: async (v: string) => { asked++; return w.chain.treasury(v); } };
    const k = quietly();
    expect(why(await thinkOnce(t.token, { chain, thinker: k.fn, env: LIVE, now: T0 + MIN_GAP_MS + 1, usdPerEth: USD }))).toBe("nothing has happened since its last thought");
    expect(why(await thinkOnce(t.token, { chain, thinker: k.fn, env: LIVE, now: T0 + H - 1, usdPerEth: USD }))).toBe("nothing has happened since its last thought");
    expect(await thinkDue({ chain, thinker: k.fn, env: LIVE, now: T0 + H - 1, usdPerEth: USD })).toEqual({ thought: 0, skipped: 0 });
    expect(asked).toBe(0); expect(k.calls).toHaveLength(0);
    expect(pulseState(t.token, T0 + 30 * 60_000, { usdPerEth: USD })).toEqual({ everyMs: PULSE_MIN_MS, nextAt: T0 + H, due: false, reason: null, kind: null });
  });

  it("checks in on its own once nothing has woken it for an hour, and is told so", async () => {
    const w = world(), t = await first(w, "PULSE"), k = quietly("An hour on and the numbers are where I left them. Holding to my plan.");
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + H, usdPerEth: USD })).toEqual({ thought: 1, skipped: 0 });
    const [entry] = thoughts(t.token);
    expect(entry).toMatchObject({ source: "pulse", reasons: ["a check-in of its own: nothing has woken it for 1 h"], thought: "An hour on and the numbers are where I left them. Holding to my plan.", action: null });
    expect(k.calls[0].prompt).toContain("woke_by: a check-in of its own: nothing has woken it for 1 h");
    expect(k.calls[0].system).toMatch(/When woke_by says a check-in of your own, or your radar, nothing happened to the token/);
    // it is a thought like any other: paid for, and the next one counts from it
    expect(entry.costEth).toBeGreaterThan(0);
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + H + MIN_GAP_MS + 1, usdPerEth: USD }))).toBe("nothing has happened since its last thought");
  });

  it("may act on a check-in, through the same rule check", async () => {
    const w = world(), t = await first(w, "ACTS");
    setCap(t.token, 1.7);
    const k = thinker({ thought: "The market cap has slid since I last looked. Buying back a measured amount.", action: { kind: "buyback", eth: 0.003 } });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + H, usdPerEth: USD }));
    expect(th).toMatchObject({ source: "pulse", verdict: "approved", action: { kind: "buyback", eth: 0.003 } });
    expect(k.calls[0].prompt).toMatch(/at_your_last_thought \(1 h 0 min ago\): market cap was 2 ETH \(-15\.0% since\)/);
  });

  it("slows down while it keeps finding nothing new, and picks its pace up again when its numbers move", async () => {
    const w = world(), t = await first(w, "SLOW"), k = quietly();
    const at = (ms: number) => thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + ms, usdPerEth: USD });
    expect(await at(H)).toEqual({ thought: 1, skipped: 0 });              // first check-in, an hour after its thought
    expect(await at(2 * H)).toEqual({ thought: 0, skipped: 0 });          // one quiet check-in behind it: now every two hours
    expect(pulseState(t.token, T0 + 2 * H, { usdPerEth: USD })).toMatchObject({ everyMs: 2 * H, nextAt: T0 + 3 * H, due: false });
    expect(await at(3 * H)).toEqual({ thought: 1, skipped: 0 });
    expect(pulseState(t.token, T0 + 3 * H + 1, { usdPerEth: USD })).toMatchObject({ everyMs: 3 * H, nextAt: T0 + 6 * H });
    // the market cap moves 6%: back to its base pace, so it is due an hour after its last look
    setCap(t.token, 2.12);
    expect(pulseState(t.token, T0 + 4 * H, { usdPerEth: USD })).toMatchObject({ everyMs: H, due: true, kind: "timer" });
    expect(await at(4 * H)).toEqual({ thought: 1, skipped: 0 });
    expect(thoughts(t.token).map((x) => x.source)).toEqual(["pulse", "pulse", "pulse", "event"]);
  });

  it("gives way to what really happened: an event wakes it as before, and is what it is told woke it", async () => {
    const w = world(), t = await first(w, "NEWS"), k = quietly("Fees came in. Holding.");
    addEvent(t.token, "fees", { eth: 0.004 });
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + 2 * H, usdPerEth: USD })).toEqual({ thought: 1, skipped: 0 });
    expect(thoughts(t.token)[0]).toMatchObject({ source: "event", reasons: ["fees paid out (0.00400 ETH)"] });
    // and the pulse counts from that thought
    expect(pulseState(t.token, T0 + 2 * H + 1, { usdPerEth: USD })).toMatchObject({ nextAt: T0 + 3 * H, due: false });
  });

  it("is not counted from a standing order firing: an order is not the mind looking", async () => {
    const w = world(), t = await w.launch("ORD");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Setting one order and waiting.", action: null, orders: [{ when: { kind: "market_cap_drops_pct", value: 20 }, then: { kind: "buyback", eth: 0.004 } }] }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    setCap(t.token, 1.5);
    await fireDue({ chain: w.chain, env: LIVE, now: T0 + 50 * 60_000 });
    expect(pulseState(t.token, T0 + H, { usdPerEth: USD })).toMatchObject({ nextAt: T0 + H, due: true });
  });

  it("is switched off with one setting, and then a quiet mind stays quiet", async () => {
    const w = world(), t = await first(w, "OFF"), k = quietly();
    const env = { ...LIVE, MINDS_PULSE: "off" };
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env, now: T0 + 5 * H, usdPerEth: USD })).toEqual({ thought: 0, skipped: 0 });
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env, now: T0 + 5 * H, usdPerEth: USD }))).toBe("nothing has happened since its last thought");
  });

  it("never checks in for a mind that is stopped, or that has never thought", async () => {
    const w = world(), t = await first(w, "STOP"), never = await w.launch("NEW"), k = quietly();
    getDb().prepare("DELETE FROM mind_events WHERE token = ?").run(never.token);
    getDb().prepare("UPDATE mind_tokens SET stopped_at = ? WHERE token = ?").run(new Date(T0).toISOString(), t.token);
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + 5 * H, usdPerEth: USD })).toEqual({ thought: 0, skipped: 0 });
    expect(pulseState(never.token, T0 + 5 * H, { usdPerEth: USD })).toEqual({ everyMs: null, nextAt: null, due: false, reason: null, kind: null });
  });
});

describe("what a check-in may cost", () => {
  it("is paced by the treasury the chain reports, not by an old figure", async () => {
    const w = world(), t = await w.launch("THIN");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: quietly("The launch.").fn, env: LIVE, now: T0, usdPerEth: USD }));
    // Axon's last reading says 0.02 ETH, but the treasury has since been spent down to 0.0003: too small to check in
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.0003 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.0003 }));
    expect(pulseState(t.token, T0 + 2 * H, { usdPerEth: USD }).due).toBe(true);
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: quietly().fn, env: LIVE, now: T0 + 2 * H, usdPerEth: USD }))).toBe("nothing has happened since its last thought");
  });

  it("stops at half of what its thinking may cost in a day, so the rest is there when something happens", async () => {
    const w = world(), t = await w.launch("HALF");
    // its creator locked thinking at 0.0001 ETH a day; each thought here costs 0.000024 ETH
    w.state.treasuries.set(t.vault, treasury({}, { maxCostPerDayEth: 0.0001 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({}, { maxCostPerDayEth: 0.0001 }));
    const k = thinker({ thought: "Looking in. Nothing to do.", action: null }, 0.06);
    const day = Date.UTC(2026, 9, 6, 0, 30);
    getDb().prepare("UPDATE mind_events SET at = ? WHERE token = ?").run(new Date(day).toISOString(), t.token);
    got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: day, usdPerEth: USD }));                 // the launch: 0.000024
    setCap(t.token, 2.2);
    got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: day + 7 * H, usdPerEth: USD }));         // a check-in: 0.000048 so far, and one more would pass half
    setCap(t.token, 2.5);
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: day + 14 * H, usdPerEth: USD }))).toBe("its check-ins have used their share of what its thinking may cost today");
    // something really happening is still thought about: that is what the other half is for
    addEvent(t.token, "fees", { eth: 0.004 });
    expect(got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: day + 14 * H, usdPerEth: USD })).source).toBe("event");
  });

  it("waits when all minds together are close to the day's shared budget, while events still get through", async () => {
    const w = world(), t = await w.launch("BUDG");
    const k = thinker({ thought: "Looking in. Nothing to do.", action: null }, 0.02);
    const env = { ...LIVE, MINDS_DAILY_BUDGET_USD: "0.06" };
    got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env, now: T0, usdPerEth: USD }));                         // $0.02 spent of $0.06
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env, now: T0 + 2 * H, usdPerEth: USD }))).toBe("minds together are close to today's budget, so check-ins wait");
    addEvent(t.token, "fees", { eth: 0.004 });
    expect(got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env, now: T0 + 2 * H, usdPerEth: USD })).source).toBe("event");
  });
});

describe("the radar waking a mind", () => {
  // a fall the radar flags: the market cap was 2 ETH an hour ago and is 1.7 now
  const fall = (token: string, now: number) => {
    sample(token, { mcapEth: 2, priceEth: 2e-9, holders: 0, top10Bps: null, feesEth: 0.05, burnedTokens: 0, treasuryEth: 0.02 }, now - H - 60_000);
    setCap(token, 1.7);
  };

  it("wakes it at once for something unusual, without waiting for its next check-in", async () => {
    const w = world(), t = await w.launch("RADAR");
    getDb().prepare("DELETE FROM mind_history WHERE token = ?").run(t.token);
    got(await thinkOnce(t.token, { chain: w.chain, thinker: quietly("The launch.").fn, env: LIVE, now: T0, usdPerEth: USD }));
    const now = T0 + 20 * 60_000;
    expect(pulseState(t.token, now, { usdPerEth: USD }).due).toBe(false);
    fall(t.token, now);
    expect(pulseState(t.token, now, { usdPerEth: USD })).toMatchObject({ due: true, kind: "radar", reason: "its radar: market cap down 15% in the last hour" });
    const k = thinker({ thought: "My radar flagged a fall of 15% in an hour. Buying back a measured amount.", action: { kind: "buyback", eth: 0.003 } });
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now, usdPerEth: USD })).toEqual({ thought: 1, skipped: 0 });
    expect(thoughts(t.token)[0]).toMatchObject({ source: "pulse", reasons: ["its radar: market cap down 15% in the last hour"], verdict: "approved" });
    expect(k.calls[0].prompt).toContain("woke_by: its radar: market cap down 15% in the last hour");
    expect(k.calls[0].prompt).toContain("radar: market cap down 15% in the last hour");
  });

  it("wakes it at most once an hour for the same thing, and never inside the ten minutes between thoughts", async () => {
    const w = world(), t = await w.launch("ONCE");
    getDb().prepare("DELETE FROM mind_history WHERE token = ?").run(t.token);
    got(await thinkOnce(t.token, { chain: w.chain, thinker: quietly("The launch.").fn, env: LIVE, now: T0, usdPerEth: USD }));
    const k = quietly("Flagged, looked, holding.");
    // five minutes after its thought the radar already flags it: it still waits out the ten minutes
    fall(t.token, T0 + 5 * 60_000);
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + 5 * 60_000, usdPerEth: USD })).toEqual({ thought: 0, skipped: 0 });
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + 12 * 60_000, usdPerEth: USD })).toEqual({ thought: 1, skipped: 0 });
    // the flag is still up twenty minutes later: it is not woken for it again
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + 32 * 60_000, usdPerEth: USD })).toEqual({ thought: 0, skipped: 0 });
    expect(pulseState(t.token, T0 + 32 * 60_000, { usdPerEth: USD })).toMatchObject({ due: false });
    expect(RADAR_GAP_MS).toBe(H);
  });
});

describe("what its status says", () => {
  it("says when it will next check in, that it is about to, or that its treasury is too small to", async () => {
    const w = world(), t = await w.launch("SAYS");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: quietly("The launch.").fn, env: LIVE, now: T0, usdPerEth: USD }));
    const at = async (ms: number) => (await mindStatus(t.token, { chain: w.chain, env: LIVE, now: T0 + ms, usdPerEth: USD }))!;
    expect(await at(20 * 60_000)).toMatchObject({ state: "waiting", text: "Nothing has happened to its token since its last thought. It wakes on the next fee payout, burn or holder milestone, or when its agent earns. It also checks in on its own about every 1 h; the next is in about 40 min." });
    expect(await at(H)).toMatchObject({ state: "about_to_think", text: "It is about to check in on its token on its own." });
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.0004 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.0004 }));
    expect((await at(20 * 60_000)).text).toBe("Nothing has happened to its token since its last thought. It wakes on the next fee payout, burn or holder milestone, or when its agent earns. Its treasury is too small for it to check in on its own between those.");
    expect((await mindStatus(t.token, { chain: w.chain, env: { ...LIVE, MINDS_PULSE: "off" }, now: T0 + 5 * H, usdPerEth: USD }))!.text).toBe("Nothing has happened to its token since its last thought. It wakes on the next fee payout, burn or holder milestone, or when its agent earns.");
  });
});
