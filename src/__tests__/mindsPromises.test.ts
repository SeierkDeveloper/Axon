// Agent Minds 2, phase 4: promises. A promise is a standing order a mind makes in public and binds itself to: it says
// what it promises, it cannot be taken back, and its ETH is held in the treasury until it is kept, missed or never called on.
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
import { thinkOnce, thoughts, type Thought } from "@/lib/mindsMind";
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
import { readOrder, saveOrders, ordersOf, ordersLines, heldFor, promiseRecord, fireDue, settleOrders, type Measures, type Wanted } from "@/lib/mindsOrders";
import { checkProposal } from "@/lib/mindsRules";
import { actDue, type MindSender } from "@/lib/mindsAct";
import { setHalted } from "@/lib/mindsAdmin";

beforeEach(() => { setHalted(false); getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history; DELETE FROM mind_orders;"); });

const ALL = CAN.buyback | CAN.reward | CAN.burnAxon;
const NOW: Measures = { mcapEth: 2, holders: 30, treasuryEth: 0.02, phase: 0 };
const CTX = { allowed: ALL, maxPerActionEth: 0.01, numbers: NOW };
const DROP = { when: { kind: "market_cap_drops_pct", value: 20 }, then: { kind: "buyback", eth: 0.004 }, hours: 12, say: "If the market cap falls a fifth from here I buy back and burn." };
const ok = (r: Wanted | { refused: string }): Wanted => { if ("refused" in r) throw new Error(r.refused); return r; };
const no = (r: Wanted | { refused: string }): string => ("refused" in r ? r.refused : "it was armed");
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

const PROMISE = { when: { kind: "holders_reach", value: 50 }, then: { kind: "reward", eth: 0.005 }, hours: 48, say: "If holders reach 50 within two days, I set 0.005 ETH aside for them to claim.", promise: true };
const T = "0x00000000000000000000000000000000000a11a8";

describe("making a promise", () => {
  it("is a standing order marked as a promise, and has to say what it promises", () => {
    expect(ok(readOrder(PROMISE, CTX))).toMatchObject({ promise: true, said: PROMISE.say, hours: 48, then: { kind: "reward", eth: 0.005 } });
    expect(no(readOrder({ ...PROMISE, say: undefined }, CTX))).toBe("A promise has to say what it promises, in a sentence holders can read.");
    expect(no(readOrder({ ...PROMISE, say: "ok" }, CTX))).toMatch(/^A promise has to say what it promises/);
    // everything that holds for an order holds for a promise
    expect(no(readOrder(PROMISE, { ...CTX, allowed: CAN.buyback }))).toBe("This mind was never allowed to reward holders.");
    expect(no(readOrder({ ...PROMISE, when: { kind: "holders_reach", value: 20 } }, CTX))).toMatch(/already true/);
    for (const flag of [false, "no", 0, undefined]) expect(ok(readOrder({ ...PROMISE, promise: flag }, CTX)).promise).toBe(false);
  });

  it("is only made with the ETH to keep it in the treasury now, and each one made leaves less to promise", () => {
    expect(saveOrders(T, { orders: [PROMISE] }, 1, { ...CTX, freeEth: 0.004 }, T0)).toMatchObject({ armed: [], refused: ["The treasury cannot cover this promise now: 0.004000 ETH is free to promise."] });
    expect(saveOrders(T, { orders: [PROMISE] }, 1, CTX, T0).refused[0]).toMatch(/0\.000000 ETH is free to promise/);
    const r = saveOrders(T, { orders: [PROMISE, { ...PROMISE, when: { kind: "holders_reach", value: 100 } }, DROP] }, 2, { ...CTX, freeEth: 0.008 }, T0);
    expect(r.armed.map((o) => o.promise)).toEqual([true, false]);
    expect(r.refused).toEqual(["The treasury cannot cover this promise now: 0.003000 ETH is free to promise."]);
    expect(heldFor(T)).toBe(0.005);
    // an ordinary order holds nothing back
    expect(heldFor(T, r.armed[0].id)).toBe(0);
  });

  it("cannot be taken back by the mind that made it", () => {
    const [p, o] = saveOrders(T, { orders: [PROMISE, DROP] }, 1, { ...CTX, freeEth: 0.01 }, T0).armed;
    expect(saveOrders(T, { cancel: [p.id, o.id] }, 2, CTX, T0).cancelled).toBe(1);
    expect(ordersOf(T).map((x) => [x.promise, x.status])).toEqual([[true, "armed"], [false, "cancelled"]]);
    expect(heldFor(T)).toBe(0.005);
  });
});

describe("what is held for a promise", () => {
  const ctx = { allowed: ALL, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, availableEth: 0.02, owedThinkingEth: 0, spentTodayEth: 0, actionsToday: 0, active: true, phase: 0, holders: 30 };

  it("cannot be spent by anything else: the rule check refuses it", () => {
    // 0.02 held, 0.0002 kept for thinking: 0.0198 free. 0.012 is held for promises, so 0.0078 is free beside it.
    expect(checkProposal({ kind: "buyback", eth: 0.007 }, { ...ctx, heldEth: 0.012 })).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.008 }, { ...ctx, heldEth: 0.012 })).toEqual({ ok: false, reason: "It would spend what it has promised: 0.012 ETH is held for promises it made, and 0.007800 ETH is free beside that." });
    // the reserve of its plan and what it holds for promises both stay: 0.0198 - 0.005 - 0.012 = 0.0028
    expect(checkProposal({ kind: "buyback", eth: 0.002 }, { ...ctx, reserveEth: 0.005, heldEth: 0.012 })).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.003 }, { ...ctx, reserveEth: 0.005, heldEth: 0.012 })).toMatchObject({ ok: false, reason: expect.stringMatching(/0\.002800 ETH is free beside that/) });
    expect(checkProposal({ kind: "buyback", eth: 0.008 }, { ...ctx, heldEth: 0 })).toEqual({ ok: true });
  });

  it("is told to the mind, taken out of what it reads as free, and holds against the action in its next answer", async () => {
    const w = world(), t = await w.launch("HOLD");
    getDb().prepare("UPDATE mind_stats SET holders = 30 WHERE token = ?").run(t.token);
    const first = thinker({ thought: "I am promising holders a reward for the day there are fifty of them.", action: null, orders: [PROMISE] });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: first.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(first.calls[0].prompt).toContain("your_promises: none made yet");
    expect(first.calls[0].system).toMatch(/A promise is a standing order with "promise": true/);
    expect(first.calls[0].system).toMatch(/"promise": <true to make it a promise/);
    expect(ordersOf(t.token)[0]).toMatchObject({ promise: true, status: "armed", said: PROMISE.say });
    expect(promiseRecord(t.token)).toEqual({ made: 1, standing: 1, kept: 0, missed: 0, notCalled: 0, beingKept: 0, heldEth: 0.005 });

    // twenty minutes on the treasury holds 0.012 and it tries to spend 0.008 of it: 0.005 of that is not its to spend
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.012 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.012 }));
    addEvent(t.token, "fees", { eth: 0.004 });
    const second = thinker({ thought: "Trying to spend more than is free beside my promise.", action: { kind: "buyback", eth: 0.008 } });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: second.fn, env: LIVE, now: T0 + 20 * 60_000, usdPerEth: USD }));
    const p = second.calls[0].prompt;
    expect(p).toMatch(/  #\d+ \(a promise, it cannot be cancelled\): when holders reach 50 \(now 30\), reward holders with 0\.005 ETH; stands for another 47 h/);
    expect(p).toContain("your_promises: 1 standing (0.005 ETH held for them, which nothing else may spend), 0 kept, 0 missed");
    const free = Number(/free_to_spend_eth: ([0-9.e-]+)/.exec(p)![1]);
    expect(free).toBeGreaterThan(0.0067); expect(free).toBeLessThan(0.0068);
    expect(th).toMatchObject({ verdict: "refused", verdictReason: expect.stringMatching(/^It would spend what it has promised: 0\.005 ETH is held/) });
  });

  it("has to fit beside the action proposed in the same answer", async () => {
    const w = world(), t = await w.launch("SAME");
    getDb().prepare("UPDATE mind_stats SET holders = 30 WHERE token = ?").run(t.token);
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.012 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.012 }));
    // 0.012 held; a 0.008 buyback is approved; what is left cannot cover a 0.005 promise
    const k = thinker({ thought: "Buying back now and promising a reward on top of it.", action: { kind: "buyback", eth: 0.008 }, orders: [PROMISE] });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(th.verdict).toBe("approved");
    expect(ordersOf(t.token)).toEqual([]);
    expect(promiseRecord(t.token).made).toBe(0);
  });
});

describe("a promise's moment coming", () => {
  const promised = async (w: ReturnType<typeof world>, symbol: string, promise: unknown = PROMISE) => {
    const t = await w.launch(symbol);
    setHolders(t.token, 30);
    for (let i = 0; i < 3; i++) getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(t.token, addr(), "1000000000000000000000");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Making one promise to holders, with the ETH for it set aside.", action: null, orders: [promise] }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    return t;
  };

  it("is kept from the ETH held for it, written in the journal in its own words, and counted as kept once it is on chain", async () => {
    const w = world(), t = await promised(w, "KEEP", { ...PROMISE, then: { kind: "buyback", eth: 0.005 }, say: "If holders reach 50 within two days, I buy back and burn with 0.005 ETH." }), s = signer();
    setHolders(t.token, 52);
    expect(await fireDue({ chain: w.chain, env: ACT, now: T0 + 3_600_000 })).toEqual({ fired: 1, lapsed: 0 });
    const [entry] = thoughts(t.token);
    expect(entry).toMatchObject({ source: "order", modelLabel: "Standing order", verdict: "approved", action: { kind: "buyback", eth: 0.005 }, reasons: ["a promise it made: when holders reach 50"] });
    expect(entry.thought).toBe('I made a promise: "If holders reach 50 within two days, I buy back and burn with 0.005 ETH." Its moment has come: holders reach 50. There are 52 now. Keeping it means I buy back and burn with 0.005 ETH, from the ETH I held for it. That goes to the rule check now.');
    expect(promiseRecord(t.token)).toMatchObject({ standing: 0, beingKept: 1, kept: 0, heldEth: 0 });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ACT, now: T0 + 3_600_000 + 20_000 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    settleOrders();
    expect(promiseRecord(t.token)).toEqual({ made: 1, standing: 0, kept: 1, missed: 0, notCalled: 0, beingKept: 0, heldEth: 0 });
    expect(ordersLines(t.token, { ...NOW, holders: 52 }, T0 + 2 * 3_600_000).at(-1)).toBe("your_promises: 0 standing (none right now: a new one for your next milestone is worth making), 1 kept, 0 missed");
  });

  it("is kept even when the mind has since tried to spend everything else: its own ETH was never free", async () => {
    const w = world(), t = await promised(w, "SAFE", { ...PROMISE, then: { kind: "buyback", eth: 0.009 }, say: "If holders reach 50 within two days, I buy back and burn with 0.009 ETH." });
    // the treasury is spent down to just above the promise by other things: 0.0095 left, 0.009 of it held
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.0095 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.0095 }));
    setHolders(t.token, 50);
    await fireDue({ chain: w.chain, env: LIVE, now: T0 + 3_600_000 });
    expect(thoughts(t.token)[0]).toMatchObject({ verdict: "approved", action: { kind: "buyback", eth: 0.009 } });
  });

  it("keeps what is held for the other promises held while one is being kept", async () => {
    const w = world(), t = await w.launch("BOTH");
    setHolders(t.token, 30);
    const two = [{ ...PROMISE, then: { kind: "buyback", eth: 0.006 }, say: "At 50 holders I buy back and burn with 0.006 ETH." }, { ...PROMISE, when: { kind: "holders_reach", value: 100 }, then: { kind: "buyback", eth: 0.006 }, say: "At 100 holders I buy back and burn with 0.006 ETH." }];
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Two promises, one for each round number of holders.", action: null, orders: two }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(heldFor(t.token)).toBe(0.012);
    // the treasury has shrunk to 0.01: the first promise is called, but 0.006 of what is left belongs to the second
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.01 })); w.state.treasuries.set(t.vault.toLowerCase(), treasury({ availableEth: 0.01 }));
    setHolders(t.token, 50);
    await fireDue({ chain: w.chain, env: LIVE, now: T0 + 3_600_000 });
    expect(ordersOf(t.token).find((o) => o.status === "missed")).toMatchObject({ promise: true, note: expect.stringMatching(/^It would spend what it has promised: 0\.006 ETH is held/) });
    expect(promiseRecord(t.token)).toMatchObject({ made: 2, standing: 1, missed: 1, heldEth: 0.006 });
  });

  it("is counted as missed, with the reason, when its moment came and it was not carried out", async () => {
    const w = world(), t = await promised(w, "BROKE"), s = signer({ simulate: () => { throw new Error("Paused()"); } });
    setHolders(t.token, 50);
    await fireDue({ chain: w.chain, env: ACT, now: T0 + 3_600_000 });
    await actDue({ chain: w.chain, sender: s.sender, env: ACT, now: T0 + 3_600_000 + 20_000 });
    settleOrders();
    expect(ordersOf(t.token)[0]).toMatchObject({ promise: true, status: "missed", note: "The treasury would refuse it: Paused()" });
    expect(promiseRecord(t.token)).toMatchObject({ kept: 0, missed: 1, standing: 0 });
    expect(ordersLines(t.token, NOW, T0 + 2 * 3_600_000).at(-1)).toBe("your_promises: 0 standing (none right now: a new one for your next milestone is worth making), 0 kept, 1 missed");
  });

  it("is neither kept nor missed when its condition never came: its time runs out and its ETH is free again", async () => {
    const w = world(), t = await promised(w, "NEVER");
    expect(await fireDue({ chain: w.chain, env: LIVE, now: T0 + 48 * 3_600_000 })).toEqual({ fired: 0, lapsed: 1 });
    expect(promiseRecord(t.token)).toEqual({ made: 1, standing: 0, kept: 0, missed: 0, notCalled: 1, beingKept: 0, heldEth: 0 });
    expect(ordersLines(t.token, NOW, T0 + 49 * 3_600_000).at(-1)).toBe("your_promises: 0 standing (none right now: a new one for your next milestone is worth making), 0 kept, 0 missed, 1 never called on");
  });

  it("is made by the stand-in thinker too, so all of this runs without a model", async () => {
    const w = world(), t = await w.launch("STND");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: standInThinker, env: LIVE, now: T0, usdPerEth: USD }));
    const made = ordersOf(t.token).find((o) => o.promise)!;
    expect(made).toMatchObject({ status: "armed", when: { kind: "holders_reach", value: 10 }, then: { kind: "buyback", eth: 0.0001 } });
    expect(made.said).toBe("If holders reach 10 within three days, I buy back and burn with 0.0001 ETH. It is set aside from now.");
    expect(promiseRecord(t.token)).toMatchObject({ made: 1, standing: 1, heldEth: 0.0001 });
    // it does not promise again while one has been made
    addEvent(t.token, "fees", { eth: 0.004 });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: standInThinker, env: LIVE, now: T0 + 3_600_000, usdPerEth: USD }));
    expect(promiseRecord(t.token).made).toBe(1);
  });
});
