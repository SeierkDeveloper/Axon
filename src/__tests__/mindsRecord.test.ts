// Agent Minds 2, phase 6: the track record. Every move a mind makes that is carried out is measured an hour later, and
// the mind writes what it takes from it.
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
import { trackOutcomes, outcomesOf, recordOf, recordLines, saveLessons, followedBy, MEASURE_AFTER_MS } from "@/lib/mindsRecord";
import { sample } from "@/lib/mindsSenses";
import { actDue, type MindSender } from "@/lib/mindsAct";
import { setHalted } from "@/lib/mindsAdmin";

beforeEach(() => { setHalted(false); getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history; DELETE FROM mind_orders; DELETE FROM mind_outcomes;"); });

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
const H = 3_600_000;
const hist = (token: string, at: number, mcapEth: number | null, holders: number) => sample(token, { mcapEth, priceEth: null, holders, top10Bps: null, feesEth: 0.05, burnedTokens: 0, treasuryEth: 0.02 }, at);

/** A mind proposes, the sender carries it out, and the record is brought up to date: one move, done, at `at`. */
async function move(w: ReturnType<typeof world>, token: string, action: { kind: string; eth: number }, at: number, extra: Record<string, unknown> = {}) {
  addEvent(token, "fees", { eth: 0.004, at: new Date(at - 1000).toISOString() });
  const k = thinker({ thought: "The numbers give a reason to act, within my limits.", action, ...extra });
  const th = got(await thinkOnce(token, { chain: w.chain, thinker: k.fn, env: ACT, now: at, usdPerEth: USD }));
  expect(await actDue({ chain: w.chain, sender: signer().sender, env: ACT, now: at + 20_000 })).toMatchObject({ done: 1 });
  // the action is written with the clock's time; put it where the test says it happened
  getDb().prepare("UPDATE mind_actions SET at = ?, updated_at = ? WHERE thought_id = ?").run(new Date(at + 20_000).toISOString(), new Date(at + 20_000).toISOString(), th.id);
  return { th, k, id: (getDb().prepare("SELECT id FROM mind_actions WHERE thought_id = ?").get(th.id) as { id: number }).id };
}

describe("writing a move down and measuring it", () => {
  it("writes down a move that was carried out, with the numbers the mind decided on, and measures it once its hour is up", async () => {
    const w = world(), t = await w.launch("MEAS");
    setHolders(t.token, 30);
    const m = await move(w, t.token, { kind: "buyback", eth: 0.004 }, T0);
    expect(trackOutcomes(T0 + 30_000)).toEqual({ recorded: 1, measured: 0 });
    expect(outcomesOf(t.token)).toEqual([{ actionId: m.id, token: t.token, kind: "buyback", eth: 0.004, at: new Date(T0 + 20_000).toISOString(), mcapBefore: 2, holdersBefore: 30, mcapAfter: null, holdersAfter: null, measuredAt: null, capPct: null, holdersDelta: null, lesson: null, lessonThoughtId: null }]);
    expect(followedBy(outcomesOf(t.token)[0])).toBe("not measured yet: its hour is not up");

    // not before its hour
    setCap(t.token, 2.1); setHolders(t.token, 33);
    expect(trackOutcomes(T0 + H)).toEqual({ recorded: 0, measured: 0 });
    expect(trackOutcomes(T0 + H + 20_000)).toEqual({ recorded: 0, measured: 1 });
    const [o] = outcomesOf(t.token);
    expect(o).toMatchObject({ mcapAfter: 2.1, holdersAfter: 33, capPct: 5, holdersDelta: 3, measuredAt: new Date(T0 + H + 20_000).toISOString() });
    expect(followedBy(o)).toBe("market cap 2 to 2.1 ETH (+5%), holders 30 to 33 an hour later");
    // once, and it stands
    setCap(t.token, 9);
    expect(trackOutcomes(T0 + 2 * H)).toEqual({ recorded: 0, measured: 0 });
    expect(outcomesOf(t.token)[0].mcapAfter).toBe(2.1);
  });

  it("measures from the sample taken when the hour was up, if the pass that measures it comes late", async () => {
    const w = world(), t = await w.launch("LATE");
    getDb().prepare("DELETE FROM mind_history WHERE token = ?").run(t.token);
    await move(w, t.token, { kind: "buyback", eth: 0.004 }, T0);
    trackOutcomes(T0 + 30_000);
    hist(t.token, T0 + 50 * 60_000, 1.95, 0);
    hist(t.token, T0 + H + 5 * 60_000, 1.9, 2);
    hist(t.token, T0 + 3 * H, 3, 9);
    setCap(t.token, 3);
    expect(trackOutcomes(T0 + 3 * H + 1)).toEqual({ recorded: 0, measured: 1 });
    expect(outcomesOf(t.token)[0]).toMatchObject({ mcapAfter: 1.9, holdersAfter: 2, capPct: -5 });
  });

  it("closes a move as not measured, rather than give it a wrong number, when nothing was read near its hour", async () => {
    const w = world(), t = await w.launch("GAP");
    getDb().prepare("DELETE FROM mind_history WHERE token = ?").run(t.token);
    await move(w, t.token, { kind: "burn_axon", eth: 0.002 }, T0);
    trackOutcomes(T0 + 30_000);
    setCap(t.token, 5);
    expect(trackOutcomes(T0 + 6 * H)).toEqual({ recorded: 0, measured: 1 });
    const [o] = outcomesOf(t.token);
    expect(o).toMatchObject({ mcapAfter: null, holdersAfter: null, capPct: null, measuredAt: new Date(T0 + 6 * H).toISOString() });
    expect(followedBy(o)).toBe("could not be measured");
    expect(recordOf(t.token)).toMatchObject({ moves: 1, measured: 0 });
  });

  it("leaves out what was never carried out, and what is not a move", async () => {
    const w = world(), t = await w.launch("NOT");
    // refused by the rule check: never sent
    addEvent(t.token, "fees", { eth: 0.004 });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Trying for more than one action may spend.", action: { kind: "buyback", eth: 5 } }).fn, env: ACT, now: T0, usdPerEth: USD }));
    // dropped on the second look, failed on chain, and a payment for thinking
    const put = getDb().prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, at, updated_at) VALUES (NULL,?,?,?,?,?,?,?)");
    for (const [kind, status] of [["buyback", "dropped"], ["reward", "failed"], ["buyback", "sent"], ["thinking", "done"]]) put.run(t.token, kind, "1", 0.001, status, new Date(T0).toISOString(), new Date(T0).toISOString());
    expect(trackOutcomes(T0 + 2 * H)).toEqual({ recorded: 0, measured: 0 });
    expect(outcomesOf(t.token)).toEqual([]);
    expect(recordLines(t.token, T0)).toEqual(["your_track_record: no moves carried out yet"]);
  });
});

describe("a mind's record in numbers", () => {
  it("says, for each kind of move, how often it was made and what it was followed by on average", async () => {
    const w = world(), t = await w.launch("REC");
    setHolders(t.token, 30);
    for (let i = 0; i < 3; i++) getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(t.token, addr(), "1000000000000000000000");
    // three buybacks an hour and a half apart: followed by +5%, -2% and +3%; and one reward followed by +4 holders
    const steps: [string, number, number, number, number][] = [["buyback", 2, 2.1, 30, 30], ["buyback", 2.1, 2.058, 30, 31], ["buyback", 2.058, 2.11974, 31, 31], ["reward", 2.11974, 2.11974, 31, 35]];
    let at = T0;
    for (const [kind, before, after, hb, ha] of steps) {
      setCap(t.token, before); setHolders(t.token, hb);
      await move(w, t.token, { kind, eth: kind === "reward" ? 0.003 : 0.002 }, at);
      trackOutcomes(at + 30_000);
      setCap(t.token, after); setHolders(t.token, ha);
      trackOutcomes(at + H + 30_000);
      at += 1.5 * H;
    }
    expect(recordOf(t.token)).toEqual({ moves: 4, measured: 4, byKind: [
      { kind: "buyback", moves: 3, measured: 3, avgCapPct: 2, timesUp: 2, avgHolders: 0.3, eth: 0.006 },
      { kind: "reward", moves: 1, measured: 1, avgCapPct: 0, timesUp: 0, avgHolders: 4, eth: 0.003 },
    ] });
    const lines = recordLines(t.token, at);
    expect(lines[0]).toBe("your_track_record: 3 buybacks, followed an hour later by market cap +2% on average (up 2 of 3 times) and holders +0.3; 1 reward, followed an hour later by market cap 0% on average (up 0 of 1 times) and holders +4");
    expect(lines[1]).toBe("your_last_moves (newest first):");
    expect(lines).toHaveLength(5);
    expect(lines[2]).toMatch(/^ {2}#\d+ reward with 0\.003 ETH, 1 h ago: market cap 2\.12 to 2\.12 ETH \(0%\), holders 31 to 35 an hour later\. No lesson yet: write one in this answer\.$/);
    expect(lines[4]).toMatch(/^ {2}#\d+ buyback with 0\.002 ETH, 4 h ago: market cap 2\.1 to 2\.058 ETH \(-2%\), holders 30 to 31 an hour later\. No lesson yet/);
  });
});

describe("the lesson a mind writes", () => {
  const measured = async (w: ReturnType<typeof world>, symbol: string) => {
    const t = await w.launch(symbol);
    const m = await move(w, t.token, { kind: "buyback", eth: 0.004 }, T0);
    trackOutcomes(T0 + 30_000);
    setCap(t.token, 1.9);
    trackOutcomes(T0 + H + 30_000);
    return { t, id: m.id };
  };

  it("is asked for at its next thought, written in the same answer, shown back to it afterwards, and stands", async () => {
    const w = world(), { t, id } = await measured(w, "LEARN");
    addEvent(t.token, "fees", { eth: 0.004 });
    const k = thinker({ thought: "Looking back at my last buyback before deciding anything.", action: null, lessons: [{ move: id, lesson: "The market cap was 5% lower an hour after this buyback. One move shows little, so I keep them small." }] });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: ACT, now: T0 + 2 * H, usdPerEth: USD }));
    expect(k.calls[0].prompt).toContain("your_track_record: 1 buyback, followed an hour later by market cap -5% on average (up 0 of 1 times) and holders 0");
    expect(k.calls[0].prompt).toContain(`  #${id} buyback with 0.004 ETH, 2 h ago: market cap 2 to 1.9 ETH (-5%), holders 0 to 0 an hour later. No lesson yet: write one in this answer.`);
    expect(k.calls[0].system).toMatch(/That is what came after, not proof of what your move caused/);
    expect(k.calls[0].system).toMatch(/"lessons": \[\{"move"/);
    expect(outcomesOf(t.token)[0]).toMatchObject({ lesson: "The market cap was 5% lower an hour after this buyback. One move shows little, so I keep them small.", lessonThoughtId: th.id });

    // next time it reads its own lesson, and cannot rewrite it
    addEvent(t.token, "fees", { eth: 0.004 });
    const again = thinker({ thought: "Trying to rewrite what I learned.", action: null, lessons: [{ move: id, lesson: "Actually that buyback was a great success for everyone." }] });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: again.fn, env: ACT, now: T0 + 3 * H, usdPerEth: USD }));
    expect(again.calls[0].prompt).toContain(`Your lesson: "The market cap was 5% lower an hour after this buyback. One move shows little, so I keep them small."`);
    expect(again.calls[0].prompt).not.toContain("No lesson yet");
    expect(outcomesOf(t.token)[0].lesson).toMatch(/^The market cap was 5% lower/);
  });

  it("is only kept for a move of its own that has been measured, and is made safe to show", async () => {
    const w = world(), { t, id } = await measured(w, "SAFE"), other = await measured(w, "ELSE");
    const fresh = await move(w, t.token, { kind: "buyback", eth: 0.002 }, T0 + 2 * H);
    trackOutcomes(T0 + 2 * H + 30_000);
    expect(saveLessons(t.token, [{ move: other.id, lesson: "A lesson for a move that is not mine." }, { move: fresh.id, lesson: "A lesson before the numbers are in." }, { move: 99999, lesson: "A lesson for nothing at all." }, { move: id, lesson: "ok" }, { move: id }, "junk", null], 1)).toBe(0);
    expect(saveLessons(t.token, "the lesson", 1)).toBe(0);
    expect(saveLessons(t.token, [{ move: id, lesson: 'Smaller steps — and "patience",\n next time.' }], 7)).toBe(1);
    expect(outcomesOf(t.token).find((o) => o.actionId === id)).toMatchObject({ lesson: "Smaller steps, and 'patience', next time.", lessonThoughtId: 7 });
    expect(outcomesOf(other.t.token)[0].lesson).toBeNull();
    expect(saveLessons(other.t.token, [{ move: other.id, lesson: "x".repeat(400) }], 8)).toBe(1);
    expect(outcomesOf(other.t.token)[0].lesson!.length).toBeLessThanOrEqual(181);
  });

  it("is written by the stand-in thinker too, so all of this runs without a model", async () => {
    const w = world(), { t, id } = await measured(w, "STND");
    addEvent(t.token, "fees", { eth: 0.004 });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: standInThinker, env: ACT, now: T0 + 2 * H, usdPerEth: USD }));
    expect(outcomesOf(t.token).find((o) => o.actionId === id)!.lesson).toBe("An hour after this buyback the market cap stood lower by 5%. One move shows little; I keep the size measured.");
    expect(MEASURE_AFTER_MS).toBe(H);
  });
});
