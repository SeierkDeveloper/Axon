// Agent Minds 2, phase 3: standing orders. A mind arms an action ahead of time; it fires the moment its condition is
// met, with no model called, and goes through the same rule check and the same sender as any other proposal.
// stand-in. No ETH moves in this phase at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, addEvent } from "@/lib/mindsStats";
import { standInThinker, type Thinker } from "@/lib/mindsThinker";
import { thinkOnce, thinkDue, thoughts, MIN_GAP_MS, type Thought } from "@/lib/mindsMind";
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
import { readOrder, saveOrders, ordersOf, ordersLines, armedCount, met, whenText, thenText, fireDue, settleOrders, MAX_ARMED, ORDER_HOURS, type Measures, type Wanted } from "@/lib/mindsOrders";
import { actDue, type MindSender } from "@/lib/mindsAct";
import { savePlan, readPlan } from "@/lib/mindsPlan";
import { mindStatus } from "@/lib/mindsStatus";
import { setHalted } from "@/lib/mindsAdmin";

beforeEach(() => { setHalted(false); getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history; DELETE FROM mind_orders;"); });

const ALL = CAN.buyback | CAN.reward | CAN.burnAxon;
const NOW: Measures = { mcapEth: 2, holders: 30, treasuryEth: 0.02, phase: 0 };
const CTX = { allowed: ALL, maxPerActionEth: 0.01, numbers: NOW };
const DROP = { when: { kind: "market_cap_drops_pct", value: 20 }, then: { kind: "buyback", eth: 0.004 }, hours: 12, say: "If the market cap falls a fifth from here I buy back and burn." };
const ok = (r: Wanted | { refused: string }): Wanted => { if ("refused" in r) throw new Error(r.refused); return r; };
const no = (r: Wanted | { refused: string }): string => ("refused" in r ? r.refused : "it was armed");
const setCap = (token: string, eth: number | null) => getDb().prepare("UPDATE mind_stats SET mcap_eth = ? WHERE token = ?").run(eth, token);
const setHolders = (token: string, count: number) => getDb().prepare("UPDATE mind_stats SET holders = ? WHERE token = ?").run(count, token);
const ACT = { ...LIVE, MINDS_ACTING: "on", MIND_SIGNER_KEY: `0x${"7".repeat(64)}` };
function signer(o: { simulate?: () => unknown; ok?: boolean } = {}) {
  const sent: { to: string; fn: string; args: readonly unknown[] }[] = [];
  const sender: MindSender = {
    address: () => "0x000000000000000000000000000000000051617e",
    simulate: async () => (o.simulate ? o.simulate() : undefined),
    send: async (to, _abi, fn, args) => { sent.push({ to, fn, args }); return `0x${sent.length.toString(16).padStart(64, "f")}`; },
    wait: async () => ({ ok: o.ok ?? true, logs: [] }),
  };
  return { sender, sent };
}

describe("reading a standing order out of a mind's answer", () => {
  it("takes a well-formed one, and remembers where the market cap stood when it was set", () => {
    expect(ok(readOrder(DROP, CTX))).toEqual({ when: { kind: "market_cap_drops_pct", value: 20, base: 2 }, then: { kind: "buyback", eth: 0.004 }, hours: 12, said: "If the market cap falls a fifth from here I buy back and burn.", promise: false });
    expect(ok(readOrder({ when: { kind: "Holders Reach", value: "50.4" }, then: { kind: "reward", eth: "0.002" } }, CTX))).toEqual({ when: { kind: "holders_reach", value: 50, base: null }, then: { kind: "reward", eth: 0.002 }, hours: ORDER_HOURS.usual, said: null, promise: false });
    expect(ok(readOrder({ when: { kind: "graduates" }, then: { kind: "burn_axon", eth: 0.001 }, hours: 9999 }, CTX))).toMatchObject({ when: { kind: "graduates", value: 0, base: null }, hours: ORDER_HOURS.most });
    expect(ok(readOrder({ ...DROP, hours: 0 }, CTX)).hours).toBe(ORDER_HOURS.least);
  });

  it("arms nothing the mind may not do, nothing past what one action may spend, and nothing it cannot measure", () => {
    expect(no(readOrder(DROP, { ...CTX, allowed: CAN.reward }))).toBe("This mind was never allowed to buy back and burn.");
    expect(no(readOrder({ ...DROP, then: { kind: "reward", eth: 0.004 } }, { ...CTX, attached: true }))).toBe("This mind was never allowed to reward holders.");
    expect(no(readOrder({ ...DROP, then: { kind: "buyback", eth: 0.02 } }, CTX))).toBe("More than one action may spend (0.01 ETH).");
    expect(no(readOrder({ ...DROP, then: { kind: "buyback", eth: 0.00001 } }, CTX))).toMatch(/^Too small to be worth sending/);
    expect(no(readOrder({ ...DROP, then: { kind: "buyback", eth: -1 } }, CTX))).toBe("Its amount is not a number above zero.");
    expect(no(readOrder({ ...DROP, then: { kind: "send_to_creator", eth: 0.004 } }, CTX))).toBe("Its action is not one a mind can take.");
    expect(no(readOrder({ ...DROP, when: { kind: "price_doubles", value: 2 } }, CTX))).toBe("Its condition is not one that can be measured.");
    expect(no(readOrder({ ...DROP, when: { kind: "market_cap_below" } }, CTX))).toBe("Its condition has no number above zero.");
    expect(no(readOrder({ ...DROP, when: { kind: "market_cap_drops_pct", value: 99 } }, CTX))).toBe("The change it waits for is out of range.");
    expect(no(readOrder(DROP, { ...CTX, numbers: { ...NOW, mcapEth: null } }))).toMatch(/^The market cap is not known right now/);
    for (const junk of [null, "buy the dip", 4, []]) expect(no(readOrder(junk, CTX))).toMatch(/could not be read|cannot be measured|not one that can be measured/);
  });

  it("refuses one whose condition is already true: an order waits for something, it is not a second action", () => {
    for (const when of [{ kind: "market_cap_below", value: 3 }, { kind: "market_cap_above", value: 1.5 }, { kind: "holders_reach", value: 30 }, { kind: "treasury_reaches", value: 0.01 }]) {
      expect(no(readOrder({ ...DROP, when }, CTX))).toBe("Its condition is already true, so there is nothing to wait for.");
    }
    expect(no(readOrder({ ...DROP, when: { kind: "graduates" } }, { ...CTX, numbers: { ...NOW, phase: 2 } }))).toMatch(/already true/);
  });

  it("makes its sentence safe to show", () => {
    expect(ok(readOrder({ ...DROP, say: 'If it falls — I act,\n and say "so" plainly.' }, CTX)).said).toBe("If it falls, I act, and say 'so' plainly.");
    expect(ok(readOrder({ ...DROP, say: "x".repeat(500) }, CTX)).said!.length).toBeLessThanOrEqual(201);
    expect(ok(readOrder({ ...DROP, say: 7 }, CTX)).said).toBeNull();
  });
});

describe("when a condition is met", () => {
  it("reads each kind against the token's numbers, and never fires on a number that could not be read", () => {
    const drop = { kind: "market_cap_drops_pct" as const, value: 20, base: 2 };
    expect(met(drop, { ...NOW, mcapEth: 1.61 })).toBe(false);
    expect(met(drop, { ...NOW, mcapEth: 1.6 })).toBe(true);
    expect(met(drop, { ...NOW, mcapEth: null })).toBe(false);
    expect(met({ kind: "market_cap_rises_pct", value: 50, base: 2 }, { ...NOW, mcapEth: 3 })).toBe(true);
    expect(met({ kind: "market_cap_rises_pct", value: 50, base: 2 }, { ...NOW, mcapEth: 2.99 })).toBe(false);
    expect(met({ kind: "market_cap_below", value: 1, base: null }, { ...NOW, mcapEth: 1 })).toBe(true);
    expect(met({ kind: "market_cap_above", value: 5, base: null }, { ...NOW, mcapEth: null })).toBe(false);
    expect(met({ kind: "holders_reach", value: 50, base: null }, { ...NOW, holders: 49 })).toBe(false);
    expect(met({ kind: "holders_reach", value: 50, base: null }, { ...NOW, holders: 50 })).toBe(true);
    expect(met({ kind: "treasury_reaches", value: 0.05, base: null }, { ...NOW, treasuryEth: 0.05 })).toBe(true);
    expect(met({ kind: "graduates", value: 0, base: null }, { ...NOW, phase: 1 })).toBe(false);
    expect(met({ kind: "graduates", value: 0, base: null }, { ...NOW, phase: 2 })).toBe(true);
  });

  it("says the condition and the action in plain words", () => {
    expect(whenText({ kind: "market_cap_drops_pct", value: 20, base: 2.3456789 })).toBe("the market cap falls 20% from 2.346 ETH");
    expect(whenText({ kind: "holders_reach", value: 50, base: null })).toBe("holders reach 50");
    expect(whenText({ kind: "graduates", value: 0, base: null })).toBe("the token graduates to its pool");
    expect(thenText({ kind: "buyback", eth: 0.004 })).toBe("buy back and burn with 0.004 ETH");
    expect(thenText({ kind: "burn_axon", eth: 0.001 })).toBe("burn $AXON with 0.001 ETH");
  });
});

describe("arming, cancelling and keeping count", () => {
  const T = "0x00000000000000000000000000000000000a11a6";

  it("arms what it is given while there is room, and says why the rest was left out", () => {
    const five = [DROP, { ...DROP, when: { kind: "market_cap_drops_pct", value: 30 } }, { ...DROP, when: { kind: "holders_reach", value: 50 }, then: { kind: "reward", eth: 0.002 } }, { ...DROP, when: { kind: "market_cap_rises_pct", value: 50 } }, { ...DROP, then: { kind: "buyback", eth: 5 } }];
    const r = saveOrders(T, { orders: five }, 7, CTX, T0);
    expect(r.armed).toHaveLength(MAX_ARMED);
    expect(r.refused).toEqual([`It already has ${MAX_ARMED} orders armed, which is the most a mind keeps at once.`, "More than one action may spend (0.01 ETH)."]);
    expect(armedCount(T)).toBe(MAX_ARMED);
    expect(r.armed[0]).toMatchObject({ token: T, thoughtId: 7, status: "armed", promise: false, when: { kind: "market_cap_drops_pct", value: 20, base: 2 }, then: { kind: "buyback", eth: 0.004 }, createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 12 * 3_600_000).toISOString() });
  });

  it("lets the mind take back its own order by number, and nobody else's", () => {
    const mine = saveOrders(T, { orders: [DROP] }, 1, CTX, T0).armed[0];
    const theirs = saveOrders("0x00000000000000000000000000000000000a11a7", { orders: [DROP] }, 2, CTX, T0).armed[0];
    expect(saveOrders(T, { cancel: [theirs.id, mine.id, "junk", 99999] }, 3, CTX, T0)).toMatchObject({ cancelled: 1 });
    expect(ordersOf(T)[0]).toMatchObject({ id: mine.id, status: "cancelled", note: "Cancelled by the mind." });
    expect(ordersOf("0x00000000000000000000000000000000000a11a7")[0].status).toBe("armed");
    // cancelling and arming in one answer: the room it frees is there for the new one
    saveOrders(T, { orders: [DROP, DROP, DROP] }, 4, CTX, T0);
    const first = ordersOf(T).find((o) => o.status === "armed")!;
    expect(saveOrders(T, { cancel: [first.id], orders: [{ ...DROP, when: { kind: "holders_reach", value: 100 } }] }, 5, CTX, T0)).toMatchObject({ cancelled: 1, armed: [expect.objectContaining({ when: { kind: "holders_reach", value: 100, base: null } })] });
    expect(armedCount(T)).toBe(MAX_ARMED);
  });

  it("is read back by the mind with how far each one is from firing", () => {
    expect(ordersLines(T, NOW, T0)).toEqual([`your_standing_orders: none armed. You may arm up to ${MAX_ARMED} (see "orders" below).`, "your_promises: none made yet. One clear promise for a milestone you would act on anyway is worth making (an order with \"promise\": true)."]);
    const [a, b] = saveOrders(T, { orders: [DROP, { ...DROP, when: { kind: "holders_reach", value: 50 }, then: { kind: "reward", eth: 0.002 }, hours: 72 }] }, 1, CTX, T0).armed;
    expect(ordersLines(T, { ...NOW, mcapEth: 1.8, holders: 41 }, T0 + 3_600_000)).toEqual([
      `your_standing_orders (2 of ${MAX_ARMED} armed):`,
      `  #${a.id}: when the market cap falls 20% from 2 ETH (now -10.0% from there), buy back and burn with 0.004 ETH; lapses in 11 h`,
      `  #${b.id}: when holders reach 50 (now 41), reward holders with 0.002 ETH; lapses in 2 days`,
      "your_promises: none made yet. One clear promise for a milestone you would act on anyway is worth making (an order with \"promise\": true).",
    ]);
  });
});

describe("a standing order firing", () => {
  const arm = async (w: ReturnType<typeof world>, symbol: string, order: unknown = DROP) => {
    const t = await w.launch(symbol);
    const k = thinker({ thought: "Nothing to do yet. I am setting an order for the move I would answer.", action: null, orders: [order] });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    return { t, th, k, order: ordersOf(t.token)[0] };
  };

  it("is armed by the mind in an answer, and waits while its condition is not met", async () => {
    const w = world(), { t, th, k, order } = await arm(w, "WAIT");
    expect(k.calls[0].prompt).toContain("your_standing_orders: none armed. You may arm up to 3");
    expect(k.calls[0].system).toMatch(/You can also set standing orders/);
    expect(k.calls[0].system).toMatch(/"orders": \[\{"when"/);
    expect(order).toMatchObject({ status: "armed", thoughtId: th.id, when: { kind: "market_cap_drops_pct", value: 20, base: 2 }, said: DROP.say });
    setCap(t.token, 1.7);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 0, lapsed: 0 });
    expect(thoughts(t.token)).toHaveLength(1);
  });

  it("fires the moment its condition is met, with no model called, as an approved proposal in the journal", async () => {
    const w = world(), { t, order } = await arm(w, "FIRE");
    setCap(t.token, 1.55);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 90_000 })).toEqual({ fired: 1, lapsed: 0 });
    const [entry] = thoughts(t.token);
    expect(entry).toMatchObject({ source: "order", modelLabel: "Standing order", standin: false, costEth: 0, costUsd: 0, action: { kind: "buyback", eth: 0.004 }, verdict: "approved", reasons: ["a standing order it set: when the market cap falls 20% from 2 ETH"] });
    expect(entry.thought).toBe(`My standing order was met: the market cap falls 20% from 2 ETH. It stands at 1.55 ETH. When I set it I said: "${DROP.say}" It calls for me to buy back and burn with 0.004 ETH, so that goes to the rule check now.`);
    expect(ordersOf(t.token)[0]).toMatchObject({ id: order.id, status: "fired", firedAt: new Date(T0 + 90_000).toISOString(), firedThoughtId: entry.id, note: null });
    // it fires once
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 120_000 })).toEqual({ fired: 0, lapsed: 0 });
    expect(thoughts(t.token)).toHaveLength(2);
  });

  it("is carried out by the same sender after the same second look, and is then marked as kept", async () => {
    const w = world(), { t, order } = await arm(w, "KEPT"), s = signer();
    setCap(t.token, 1.5);
    await fireDue({ chain: w.chain, env: ACT, now: T0 + 60_000 });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ACT, now: T0 + 80_000 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    expect(s.sent).toEqual([{ to: t.vault.toLowerCase(), fn: "buyback", args: [4_000_000_000_000_000n] }]);
    expect(settleOrders()).toBe(1);
    expect(ordersOf(t.token)[0]).toMatchObject({ id: order.id, status: "kept", note: null });
    expect(thoughts(t.token)[0].sent).toMatchObject({ status: "done" });
    expect(settleOrders()).toBe(0);
  });

  it("is marked as missed, with the reason, when the treasury would refuse it on the second look", async () => {
    const w = world(), { t } = await arm(w, "MISS"), s = signer({ simulate: () => { throw new Error("DayLimit()"); } });
    setCap(t.token, 1.5);
    await fireDue({ chain: w.chain, env: ACT, now: T0 + 60_000 });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ACT, now: T0 + 80_000 })).toEqual({ done: 0, failed: 0, dropped: 1 });
    settleOrders();
    expect(ordersOf(t.token)[0]).toMatchObject({ status: "missed", note: "The treasury would refuse it: DayLimit()" });
  });

  it("gets no way round the rule check: one that the treasury cannot cover, or that breaks the plan's reserve, is refused when it fires", async () => {
    const w = world(), { t } = await arm(w, "POOR");
    w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.001 }));
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.001 }));
    setCap(t.token, 1.5);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 1, lapsed: 0 });
    expect(thoughts(t.token)[0]).toMatchObject({ source: "order", verdict: "refused", verdictReason: expect.stringMatching(/^The treasury cannot cover it/) });
    expect(ordersOf(t.token)[0]).toMatchObject({ status: "missed", note: expect.stringMatching(/^The treasury cannot cover it/) });

    const b = await arm(w, "FLOOR");
    savePlan(b.t.token, readPlan({ mission: "Keep nearly everything in reserve for a bad day.", split: { reserve: 100 }, reserve_eth: 0.018 }, { allowed: ALL })!, null, { now: T0 });
    setCap(b.t.token, 1.5);
    await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 });
    expect(ordersOf(b.t.token)[0]).toMatchObject({ status: "missed", note: expect.stringMatching(/below the reserve its own plan keeps \(0\.018 ETH\)/) });
  });

  it("lapses when its time runs out unmet, and a lapsed order never fires", async () => {
    const w = world(), { t } = await arm(w, "LATE");
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 12 * 3_600_000 - 1 })).toEqual({ fired: 0, lapsed: 0 });
    setCap(t.token, 1);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 12 * 3_600_000 })).toEqual({ fired: 0, lapsed: 1 });
    expect(ordersOf(t.token)[0].status).toBe("lapsed");
    expect(thoughts(t.token)).toHaveLength(1);
  });

  it("fires nothing while minds are off, halted, or this one is stopped or paused; the order waits as it is", async () => {
    const w = world(), { t } = await arm(w, "HELD");
    setCap(t.token, 1.5);
    expect(await fireDue({ chain: w.chain, env: { ...LIVE, AGENT_MINDS: "off" }, now: T0 + 60_000 })).toBeNull();
    expect(await fireDue({ chain: w.chain, env: { ...LIVE, MINDS_THINKING: "off" }, now: T0 + 60_000 })).toBeNull();
    setHalted(true);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toBeNull();
    setHalted(false);
    getDb().prepare("UPDATE mind_tokens SET stopped_at = ? WHERE token = ?").run(new Date(T0).toISOString(), t.token);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 0, lapsed: 0 });
    getDb().prepare("UPDATE mind_tokens SET stopped_at = NULL WHERE token = ?").run(t.token);
    w.state.treasuries.set(t.vault, treasury({ paused: true, active: false })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ paused: true, active: false }));
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 0, lapsed: 0 });
    expect(ordersOf(t.token)[0].status).toBe("armed");
    w.state.treasuries.delete(t.vault); w.state.treasuries.delete(t.vault.toLowerCase());
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 1, lapsed: 0 });
  });

  it("can be switched off on its own: then none fires and none is armed, and the mind is told so", async () => {
    const w = world(), { t } = await arm(w, "SWOFF"), off = { ...LIVE, MINDS_ORDERS: "off" };
    setCap(t.token, 1.5);
    expect(await fireDue({ chain: w.chain, env: off, now: T0 + 60_000 })).toBeNull();
    expect(ordersOf(t.token)[0].status).toBe("armed");
    addEvent(t.token, "fees", { eth: 0.004 });
    const k = thinker({ thought: "Trying to set another order while they are off.", action: null, orders: [{ ...DROP, when: { kind: "holders_reach", value: 77 } }] });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: off, now: T0 + 20 * 60_000, usdPerEth: USD }));
    expect(k.calls[0].prompt).toContain("your_standing_orders: switched off for now. Set none in this answer.");
    expect(ordersOf(t.token)).toHaveLength(1);
    // back on, the order that waited fires
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 21 * 60_000 })).toEqual({ fired: 1, lapsed: 0 });
  });

  it("fires one order a token a pass, the oldest first", async () => {
    const w = world(), t = await w.launch("TWO");
    const k = thinker({ thought: "Two orders, for two depths of the same fall.", action: null, orders: [DROP, { ...DROP, when: { kind: "market_cap_drops_pct", value: 30 }, then: { kind: "buyback", eth: 0.002 } }] });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    setCap(t.token, 1);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 1, lapsed: 0 });
    expect(ordersOf(t.token).map((o) => o.status).sort()).toEqual(["armed", "fired"]);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 80_000 })).toEqual({ fired: 1, lapsed: 0 });
    expect(thoughts(t.token).filter((x) => x.source === "order").map((x) => x.action!.eth)).toEqual([0.002, 0.004]);
  });

  it("does not hold the mind's next thought back or hide news from it, and the mind reads what its order did", async () => {
    const w = world(), { t } = await arm(w, "NEXT");
    setCap(t.token, 1.5);
    addEvent(t.token, "fees", { eth: 0.004 });
    // the order fires nine minutes after the thought; one minute later the mind is due again and is not made to wait for the order
    await fireDue({ chain: w.chain, env: LIVE, now: T0 + MIN_GAP_MS - 60_000 });
    expect((await mindStatus(t.token, { chain: w.chain, env: LIVE, now: T0 + MIN_GAP_MS + 1000, usdPerEth: USD }))!.state).toBe("about_to_think");
    const k = thinker({ thought: "My order answered the fall. Holding the rest.", action: null });
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: LIVE, now: T0 + MIN_GAP_MS + 1000, usdPerEth: USD })).toEqual({ thought: 1, skipped: 0 });
    const p = k.calls[0].prompt;
    expect(p).toContain("woke_by: fees paid out (0.00400 ETH)");
    expect(p).toContain("your_standing_orders: none armed.");
    expect(p).toMatch(/  earlier: #\d+ \(when the market cap falls 20% from 2 ETH, buy back and burn with 0\.004 ETH\): its condition was met and it was put to the rule check, 1 min ago/);
    expect(p).toMatch(/- \(1 min ago\) My standing order was met: .* \[proposed buyback 0\.004 ETH: approved\]/);
    expect(p).toMatch(/your_last_action: buyback with 0\.004 ETH, 1 min ago/);
    // what it compares the numbers with is its own last look, not the moment the order fired
    expect(p).toMatch(/at_your_last_thought \(10 min ago\): market cap was 2 ETH \(-25\.0% since\)/);
  });

  it("is not armed when the mind's answer asks for something it may not do, and the thought still stands", async () => {
    const w = world(), t = await w.launch("NOPE");
    w.state.treasuries.set(t.vault, treasury({}, { allowed: CAN.reward })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({}, { allowed: CAN.reward }));
    const k = thinker({ thought: "Setting an order I was never allowed to carry out.", action: null, orders: [DROP] });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(th.thought).toBe("Setting an order I was never allowed to carry out.");
    expect(ordersOf(t.token)).toEqual([]);
  });

  it("is armed by the stand-in thinker too, so all of this runs without a model", async () => {
    const w = world(), t = await w.launch("STND");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: standInThinker, env: LIVE, now: T0, usdPerEth: USD }));
    const [o] = ordersOf(t.token);
    expect(o).toMatchObject({ status: "armed", when: { kind: "market_cap_drops_pct", value: 15, base: 2 }, then: { kind: "buyback" } });
    expect(o.then.eth).toBeGreaterThanOrEqual(0.0001);
    setHolders(t.token, 3); setCap(t.token, 1.6);
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 60_000 })).toEqual({ fired: 1, lapsed: 0 });
    expect(thoughts(t.token)[0]).toMatchObject({ source: "order", verdict: "approved" });
  });
});
