// Agent Minds 2, phase 9: the mind's books, and Mylo reading what a mind works to and has to show for it.
// The page shows the same figures; every one of them is the chain's or Axon's own record.
// stand-in. No ETH moves in this phase at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats } from "@/lib/mindsStats";
import { type Thinker } from "@/lib/mindsThinker";
import { thinkOnce, type Thought } from "@/lib/mindsMind";
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
import { settleOrders } from "@/lib/mindsOrders";
import { booksOf } from "@/lib/mindsBooks";
import { trackOutcomes } from "@/lib/mindsRecord";
import { setBrief } from "@/lib/mindsBrief";
import { runTool } from "@/lib/myloTools";
import { startConversation } from "@/lib/myloStore";
import { actDue, type MindSender } from "@/lib/mindsAct";
import { setHalted } from "@/lib/mindsAdmin";

beforeEach(() => { setHalted(false); getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history; DELETE FROM mind_orders; DELETE FROM mind_outcomes; DELETE FROM mind_reports; DELETE FROM mind_briefs; DELETE FROM mind_brief_log;"); });

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
const H = 3_600_000;
const PLAN = { mission: "Grow past 100 holders and keep a third in reserve.", goal: { kind: "holders", target: 100 }, split: { buyback: 40, reward: 30, burn_axon: 0, reserve: 30 }, reserve_eth: 0.006, thesis: "Buy back on dips, reward when holders grow." };
const PROMISE = { when: { kind: "holders_reach", value: 50 }, then: { kind: "reward", eth: 0.002 }, hours: 48, say: "If holders reach 50 within two days, I set 0.002 ETH aside for them to claim.", promise: true };

describe("a mind's books", () => {
  it("add up what it holds, what it keeps back and what is free, from the treasury the chain reports", async () => {
    const w = world(), t = await w.launch("BOOK");
    setHolders(t.token, 30);
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Setting my plan and one promise.", action: null, plan: PLAN, orders: [PROMISE] }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    const tr = treasury({ availableEth: 0.02, reservedEth: 0.003, boughtBackEth: 0.01, rewardedEth: 0.004, axonBurnedEth: 0.001, thinkingEth: 0.0005 });
    const b = booksOf(t.token, tr, 0.04, T0 + 60_000);
    expect(b).toMatchObject({ fromFeesEth: 0.04, holdsEth: 0.02, setAsideEth: 0.003, reserveEth: 0.006, heldForPromisesEth: 0.002, spent: { buybackEth: 0.01, rewardEth: 0.004, burnAxonEth: 0.001, thinkingEth: 0.0005 } });
    // one thought at $0.02 is owed: 0.000008 ETH. Free is 0.02 less that, the 0.0002 kept for thinking, the reserve and the promise.
    expect(b.owedThinkingEth).toBeCloseTo(0.000008, 9);
    expect(b.freeEth).toBeCloseTo(0.02 - 0.000008 - 0.0002 - 0.006 - 0.002, 9);
  });

  it("say how long the treasury covers its thinking, at the pace it has really been thinking", async () => {
    const w = world(), t = await w.launch("RUN");
    // nothing has cost anything yet
    expect(booksOf(t.token, treasury(), 0, T0)).toMatchObject({ thinkingPerDayEth: null, runwayDays: null, freeEth: 0.0198 });
    // twelve thoughts at 0.0001 ETH over just over two days: about 0.00056 ETH a day, and 0.0012 ETH of it is still owed, so the 0.0188 ETH left covers 33 days
    const put = getDb().prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, cost_usd, cost_eth, source) VALUES (?,?,?,0,'thought','[]','x',?,?,'event')");
    for (let d = 0; d < 3; d++) for (let i = 0; i < 4; i++) put.run(t.token, new Date(T0 - d * 24 * H - i * H - 60_000).toISOString(), "claude-opus-5-5", 0.25, 0.0001);
    const b = booksOf(t.token, treasury(), 0, T0);
    expect(b.thinkingPerDayEth!).toBeGreaterThan(0.00055); expect(b.thinkingPerDayEth!).toBeLessThan(0.00058);
    expect(b.runwayDays).toBe(33);
    // a stand-in's thoughts cost nothing and never count
    getDb().prepare("UPDATE mind_thoughts SET standin = 1 WHERE token = ?").run(t.token);
    expect(booksOf(t.token, treasury(), 0, T0).runwayDays).toBeNull();
  });
});

describe("Mylo reading what a mind works to", () => {
  it("is given its plan, its orders and promises, its track record, its brief and its books, in plain words", async () => {
    const w = world(), t = await w.launch("ALLOF");
    setHolders(t.token, 30);
    setBrief(t.token, t.creator, "Care most about the people who hold for the long run.", T0 - 60_000);
    const k = thinker({ thought: "Setting my plan, an order and a promise, and buying back a measured amount.", action: { kind: "buyback", eth: 0.004 }, plan: PLAN, orders: [PROMISE, { when: { kind: "market_cap_drops_pct", value: 20 }, then: { kind: "buyback", eth: 0.002 }, say: "If it falls a fifth I buy back." }] });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: ACT, now: T0, usdPerEth: USD }));
    await actDue({ chain: w.chain, sender: signer().sender, env: ACT, now: T0 + 20_000 });
    getDb().prepare("UPDATE mind_actions SET at = ? WHERE thought_id = ?").run(new Date(T0 + 20_000).toISOString(), th.id);
    settleOrders(); trackOutcomes(T0 + 30_000);
    getDb().prepare("UPDATE mind_stats SET mcap_eth = 2.1 WHERE token = ?").run(t.token);
    trackOutcomes(T0 + H + 30_000);
    getDb().prepare("UPDATE mind_outcomes SET lesson = 'One move shows little, so I keep them small.' WHERE token = ?").run(t.token);
    getDb().prepare("INSERT INTO mind_reports (token, day, text, thought_id, at) VALUES (?, '2026-10-05', 'Fees came in and I bought back a measured amount.', NULL, ?)").run(t.token, new Date(T0).toISOString());

    const old = process.env.AGENT_MINDS; process.env.AGENT_MINDS = "on";
    let r: Record<string, unknown>;
    try { r = (await runTool("token_details", { token: t.token }, { wallet: null, owner: "guest:books", conversationId: startConversation("guest:books", "t").id })).result as Record<string, unknown>; }
    finally { if (old === undefined) delete process.env.AGENT_MINDS; else process.env.AGENT_MINDS = old; }
    expect(r.mind_plan).toMatchObject({ mission: PLAN.mission, goal: "100 holders", goal_progress: "30% of the way", means_to_split_what_it_spends: { buybacks: "40%", rewards: "30%", burning_axon: "0%", kept_in_reserve: "30%" }, reserve_it_will_not_spend_below_eth: 0.006 });
    expect(r.standing_orders).toMatchObject({
      waiting: [{ a_promise: true, when: "holders reach 50", then: "reward holders with 0.002 ETH", in_its_words: PROMISE.say }, { when: "the market cap falls 20% from 2 ETH", then: "buy back and burn with 0.002 ETH" }],
      promises_so_far: { made: 1, standing: 1, kept: 0, missed: 0, eth_held_for_them: 0.002 },
    });
    expect(r.track_record).toMatchObject({ note: expect.stringMatching(/FOLLOWED BY an hour later.*never proof of what the move caused/), by_kind: [{ times: 1, measured: 1, market_cap_an_hour_later_on_average: "+5%", times_it_was_higher: "1 of 1" }], latest: [{ followed_by: "market cap 2 to 2.1 ETH (+5%), holders 30 to 30 an hour later", the_minds_lesson: "One move shows little, so I keep them small." }] });
    expect(r.latest_daily_report).toEqual({ for_day: "5 October", in_its_words: "Fees came in and I bought back a measured amount." });
    expect(r.brief_from_its_creator).toMatchObject({ in_the_creators_words: "Care most about the people who hold for the long run." });
    // its books are read from the chain's own treasury, which a test has no way to reach: the field is there, and empty
    expect(r).toHaveProperty("books");
  });

  it("says so plainly when a mind has none of it yet", async () => {
    const w = world(), t = await w.launch("BARE");
    const old = process.env.AGENT_MINDS; process.env.AGENT_MINDS = "on";
    let r: Record<string, unknown>;
    try { r = (await runTool("token_details", { token: t.token }, { wallet: null, owner: "guest:bare", conversationId: startConversation("guest:bare", "t").id })).result as Record<string, unknown>; }
    finally { if (old === undefined) delete process.env.AGENT_MINDS; else process.env.AGENT_MINDS = old; }
    expect(r.mind_plan).toBe("It has not written a plan yet.");
    // said last, where a small model reads it: its own words are never made up for it
    expect(r.before_you_answer).toMatch(/Anything you put in quotation marks must be copied word for word from this result/);
    expect(r.track_record).toBe("No move of its mind has been carried out yet.");
    expect(r.brief_from_its_creator).toBe("Its creator has left its mind no brief.");
    expect(r.latest_daily_report).toMatch(/^It has not written a daily report yet/);
    expect(r.standing_orders).toMatchObject({ waiting: [], recent: [], promises_so_far: { made: 0 } });
  });
});
