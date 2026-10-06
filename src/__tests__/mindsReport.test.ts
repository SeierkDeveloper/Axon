// Agent Minds 2, phase 7: the daily report. Once a day a mind writes a short report on the day that just ended, from
// facts worked out by plain code, for its creator and its holders.
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
import { thinkOnce, thinkDue, thoughts, type Thought } from "@/lib/mindsMind";
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
import { dayFacts, dayBefore, dayLabel, reportDue, reportsOf, reportsEnabled, reportUntilHour, REPORT_UNTIL_HOUR } from "@/lib/mindsReport";
import { runMyloPass } from "@/lib/myloPass";
import { fireDue, settleOrders } from "@/lib/mindsOrders";
import { pulseState } from "@/lib/mindsPulse";
import { sample } from "@/lib/mindsSenses";
import { actDue, type MindSender } from "@/lib/mindsAct";
import { setHalted } from "@/lib/mindsAdmin";

beforeEach(() => { setHalted(false); getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_plans; DELETE FROM mind_plan_log; DELETE FROM mind_history; DELETE FROM mind_orders; DELETE FROM mind_outcomes; DELETE FROM mind_reports; DELETE FROM mylo_inbox; DELETE FROM mylo_conversations;"); });

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
}const H = 3_600_000;
// the day reported on is 5 October 2026 (T0 is noon that day); reports are written in the first hours of the 6th
const DAY = "2026-10-05", START = Date.UTC(2026, 9, 5), NEXT = Date.UTC(2026, 9, 6, 0, 30);
const hist = (token: string, at: number, mcapEth: number | null, holders: number, feesEth = 0.05) => sample(token, { mcapEth, priceEth: null, holders, top10Bps: null, feesEth, burnedTokens: 0, treasuryEth: 0.02 }, at);
const inbox = (wallet: string) => getDb().prepare("SELECT kind, title, body, link FROM mylo_inbox WHERE wallet = ? ORDER BY created_at DESC").all(wallet.toLowerCase()) as { kind: string; title: string; body: string | null; link: string | null }[];

/** A token whose mind thought at noon on the 5th, with samples at the start and the end of that day. */
async function lived(w: ReturnType<typeof world>, symbol: string, o: { capEnd?: number; holdersEnd?: number; feesEnd?: number } = {}) {
  const t = await w.launch(symbol);
  getDb().prepare("DELETE FROM mind_history WHERE token = ?").run(t.token);
  getDb().prepare("UPDATE mind_tokens SET launched_at = ? WHERE token = ?").run(new Date(START - 2 * 86_400_000).toISOString(), t.token);
  getDb().prepare("UPDATE mind_events SET at = ? WHERE token = ?").run(new Date(START - 86_400_000).toISOString(), t.token);
  hist(t.token, START + 5 * 60_000, 2, 30);
  got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Looking at the token at noon. Holding.", action: null }).fn, env: ACT, now: T0, usdPerEth: USD }));
  hist(t.token, START + 23.9 * H, o.capEnd ?? 2, o.holdersEnd ?? 30, o.feesEnd ?? 0.05);
  return t;
}

describe("the facts of a day", () => {
  it("are worked out from Axon's own records: how the numbers moved, what happened, what the mind did", async () => {
    const w = world(), t = await lived(w, "FACT", { capEnd: 2.3, holdersEnd: 36, feesEnd: 0.08 });
    for (let i = 0; i < 3; i++) getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(t.token, addr(), "1000000000000000000000");
    setHolders(t.token, 30);
    // an afternoon on the 5th: fees, a buyback carried out, a burn, a refused proposal, a check-in, an order kept, a promise made
    addEvent(t.token, "fees", { eth: 0.03, at: new Date(T0 + 1 * H).toISOString() });
    const k = thinker({ thought: "Fees came in. Buying back a measured amount.", action: { kind: "buyback", eth: 0.004 }, orders: [{ when: { kind: "holders_reach", value: 50 }, then: { kind: "reward", eth: 0.002 }, say: "At fifty holders I set a reward aside.", promise: true }, { when: { kind: "market_cap_drops_pct", value: 10 }, then: { kind: "buyback", eth: 0.002 } }] });
    const th = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: ACT, now: T0 + 1 * H + 1000, usdPerEth: USD }));
    await actDue({ chain: w.chain, sender: signer().sender, env: ACT, now: T0 + 1 * H + 20_000 });
    getDb().prepare("UPDATE mind_actions SET at = ? WHERE thought_id = ?").run(new Date(T0 + 1 * H + 20_000).toISOString(), th.id);
    addEvent(t.token, "burn", { tokens: 125_000, eth: 0.01, at: new Date(T0 + 2 * H).toISOString() });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "A burn. Trying for more than one action may spend.", action: { kind: "buyback", eth: 5 } }).fn, env: ACT, now: T0 + 2 * H + 1000, usdPerEth: USD }));
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Checking in. Nothing new.", action: null }).fn, env: ACT, now: T0 + 4 * H, usdPerEth: USD }));
    setCap(t.token, 1.7);
    await fireDue({ chain: w.chain, env: ACT, now: T0 + 5 * H });
    await actDue({ chain: w.chain, sender: signer().sender, env: ACT, now: T0 + 5 * H + 20_000 });
    getDb().prepare("UPDATE mind_actions SET at = ? WHERE thought_id = (SELECT MAX(id) FROM mind_thoughts WHERE source = 'order')").run(new Date(T0 + 5 * H + 20_000).toISOString());
    settleOrders();

    const f = dayFacts(t.token, DAY);
    expect(f).toMatchObject({ day: DAY, label: "5 October", eventful: true });
    expect(f.lines).toEqual([
      "market cap 2 ETH at the start of the day, 2.3 ETH at the end (+15%)",
      "holders 30 at the start, 36 at the end (+6)",
      "fees paid out: 0.03 ETH, from about 1 ETH traded",
      "the burn pot burned 125,000 tokens in 1 burn",
      expect.stringMatching(/^you thought 4 times \(3 woken by something happening, 1 check-in of your own\), which cost [0-9.e-]+ ETH$/),
      "the rule check refused 1 proposal of yours",
      "you carried out 2 buybacks (0.006 ETH)",
      "standing orders that fired: 1 carried out",
      "promises: 1 made",
    ]);
    // the day before and the day after are their own days
    expect(dayFacts(t.token, "2026-10-07")).toMatchObject({ eventful: false, lines: ["market cap and holders: not read on that day", "you did not think that day", "you carried out no moves"] });
  });

  it("says a day was not worth a report when nothing happened on it", async () => {
    const w = world(), t = await lived(w, "DULL");
    // a mind that only looked in on its own, with the numbers where they were
    getDb().prepare("UPDATE mind_thoughts SET source = 'pulse' WHERE token = ?").run(t.token);
    expect(dayFacts(t.token, DAY)).toMatchObject({ eventful: false, lines: ["market cap 2 ETH at the start of the day, 2 ETH at the end (0%)", "holders 30 at the start, 30 at the end (0)", "fees paid out: none", expect.stringMatching(/^you thought 1 time \(0 woken by something happening, 1 check-in of your own\)/), "you carried out no moves"] });
    // a market cap that moved 5% is worth one on its own
    const moved = await lived(w, "MOVE", { capEnd: 1.9 });
    getDb().prepare("UPDATE mind_thoughts SET source = 'pulse' WHERE token = ?").run(moved.token);
    expect(dayFacts(moved.token, DAY).eventful).toBe(true);
    expect([dayBefore(NEXT), dayBefore(START + 23.9 * H), dayLabel("2026-01-31")]).toEqual([DAY, "2026-10-04", "31 January"]);
  });
});

describe("a mind writing its daily report", () => {
  const REPORT = "Fees came in on 5 October and the market cap ended the day higher. I held, because nothing called for a move inside my plan. I am watching the holder count next.";

  it("writes it in the first hours of the next day, from the facts it is handed, as an entry in its journal", async () => {
    const w = world(), t = await lived(w, "RPT", { capEnd: 2.3, feesEnd: 0.08 });
    const k = thinker({ thought: REPORT, action: null });
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT, usdPerEth: USD })).toEqual({ written: 1, skipped: 0, quiet: 0 });
    expect(reportsOf(t.token)).toEqual([{ id: expect.any(Number), token: t.token, day: DAY, label: "5 October", text: REPORT, thoughtId: expect.any(Number), at: new Date(NEXT).toISOString() }]);
    const [entry] = thoughts(t.token);
    expect(entry).toMatchObject({ source: "report", reasons: ["its daily report for 5 October"], thought: REPORT, action: null, verdict: "none" });
    expect(entry.costEth).toBeGreaterThan(0);
    const p = k.calls[0].prompt;
    expect(p).toContain("woke_by: its daily report for 5 October");
    expect(p).toContain("your_day (5 October, midnight to midnight UTC):\n  market cap 2 ETH at the start of the day, 2.3 ETH at the end (+15%)\n  holders 30 at the start, 30 at the end (0)\n  fees paid out: 0.03 ETH, from about 1 ETH traded");
    expect(p.trimEnd().endsWith("this_answer: your daily report on that day, written as your thought. Propose nothing.")).toBe(true);
    expect(k.calls[0].system).toMatch(/When woke_by says your daily report, this answer is your report on the day shown in your_day/);
    // once a day: the next pass has nothing to do
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT + 60_000, usdPerEth: USD })).toEqual({ written: 0, skipped: 0, quiet: 0 });
    expect(k.calls).toHaveLength(1);
  });

  it("is only a report: an action, a plan or an order in the same answer is left out", async () => {
    const w = world(), t = await lived(w, "ONLY", { feesEnd: 0.08 });
    const k = thinker({ thought: REPORT, action: { kind: "buyback", eth: 0.004 }, plan: { mission: "Spend everything at once, with no reserve.", split: { buyback: 100 } }, orders: [{ when: { kind: "holders_reach", value: 99 }, then: { kind: "buyback", eth: 0.004 } }] });
    await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT, usdPerEth: USD });
    expect(thoughts(t.token)[0]).toMatchObject({ source: "report", action: null, verdict: "none" });
    expect(getDb().prepare("SELECT COUNT(*) n FROM mind_plans WHERE token = ?").get(t.token)).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) n FROM mind_orders WHERE token = ?").get(t.token)).toEqual({ n: 0 });
  });

  it("does not use up the news the mind has yet to think about, or count as it looking in", async () => {
    const w = world(), t = await lived(w, "KEEP", { feesEnd: 0.08 });
    addEvent(t.token, "fees", { eth: 0.004, at: new Date(NEXT - 60_000).toISOString() });
    await reportDue({ chain: w.chain, thinker: thinker({ thought: REPORT, action: null }).fn, env: ACT, now: NEXT, usdPerEth: USD });
    // the fees that came in a minute before the report still wake it, at once
    const k = thinker({ thought: "Fees came in overnight. Holding.", action: null });
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT + 30_000, usdPerEth: USD })).toEqual({ thought: 1, skipped: 0 });
    expect(k.calls[0].prompt).toContain("woke_by: fees paid out (0.00400 ETH)");
    // and its check-ins are counted from that thought, not from the report
    expect(pulseState(t.token, NEXT + 40_000, { usdPerEth: USD }).nextAt).toBe(NEXT + 30_000 + H);
  });

  it("gets no report for a day on which nothing happened, and is not asked again", async () => {
    const w = world(), t = await lived(w, "NONE");
    getDb().prepare("UPDATE mind_thoughts SET source = 'pulse' WHERE token = ?").run(t.token);
    const k = thinker({ thought: REPORT, action: null });
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT, usdPerEth: USD })).toEqual({ written: 0, skipped: 0, quiet: 1 });
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT + 60_000, usdPerEth: USD })).toEqual({ written: 0, skipped: 0, quiet: 0 });
    expect(k.calls).toHaveLength(0);
    expect(reportsOf(t.token)).toEqual([]);
  });

  it("is not written after noon, for a mind that is stopped, for one that was not thinking yet, or on a treasury too small to check in", async () => {
    const w = world(), t = await lived(w, "LATE", { feesEnd: 0.08 }), k = thinker({ thought: REPORT, action: null });
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: Date.UTC(2026, 9, 6, REPORT_UNTIL_HOUR), usdPerEth: USD })).toBeNull();
    for (const env of [{ ...ACT, MINDS_REPORTS: "off" }, { ...ACT, MINDS_THINKING: "off" }, { ...ACT, AGENT_MINDS: "off" }]) expect(await reportDue({ chain: w.chain, thinker: k.fn, env, now: NEXT, usdPerEth: USD })).toBeNull();
    expect([reportsEnabled({}), reportsEnabled({ MINDS_REPORTS: "off" })]).toEqual([true, false]);
    // the hour can be moved for a service; anything that is not a whole hour from 1 to 24 is ignored
    expect([reportUntilHour({}), reportUntilHour({ MINDS_REPORT_UNTIL_HOUR: "24" }), reportUntilHour({ MINDS_REPORT_UNTIL_HOUR: "0" }), reportUntilHour({ MINDS_REPORT_UNTIL_HOUR: "soon" }), reportUntilHour({ MINDS_REPORT_UNTIL_HOUR: "9.5" })]).toEqual([12, 24, 12, 12, 12]);
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: { ...ACT, MINDS_REPORT_UNTIL_HOUR: "9" }, now: Date.UTC(2026, 9, 6, 9, 5), usdPerEth: USD })).toBeNull();
    getDb().prepare("UPDATE mind_tokens SET stopped_at = ? WHERE token = ?").run(new Date(T0).toISOString(), t.token);
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT, usdPerEth: USD })).toEqual({ written: 0, skipped: 0, quiet: 0 });
    getDb().prepare("UPDATE mind_tokens SET stopped_at = NULL WHERE token = ?").run(t.token);
    // its first thought came after the day ended: there is no day of its own to report on
    getDb().prepare("UPDATE mind_thoughts SET at = ? WHERE token = ?").run(new Date(NEXT - 60_000).toISOString(), t.token);
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT, usdPerEth: USD })).toEqual({ written: 0, skipped: 0, quiet: 0 });
    getDb().prepare("UPDATE mind_thoughts SET at = ? WHERE token = ?").run(new Date(T0).toISOString(), t.token);
    getDb().prepare("UPDATE mind_stats SET treasury_eth = 0.0002 WHERE token = ?").run(t.token);
    expect(await reportDue({ chain: w.chain, thinker: k.fn, env: ACT, now: NEXT, usdPerEth: USD })).toEqual({ written: 0, skipped: 0, quiet: 0 });
    expect(k.calls).toHaveLength(0);
  });

  it("waits half an hour after an attempt that failed, and gives a day up after three", async () => {
    const w = world(), t = await lived(w, "FAIL", { feesEnd: 0.08 });
    const broken: Thinker = async () => { throw new Error("model down"); };
    const at = (min: number, fn: Thinker) => reportDue({ chain: w.chain, thinker: fn, env: ACT, now: NEXT + min * 60_000, usdPerEth: USD });
    expect(await at(0, broken)).toEqual({ written: 0, skipped: 1, quiet: 0 });
    expect(await at(10, broken)).toEqual({ written: 0, skipped: 0, quiet: 0 });
    expect(await at(31, broken)).toEqual({ written: 0, skipped: 1, quiet: 0 });
    expect(await at(62, broken)).toEqual({ written: 0, skipped: 1, quiet: 0 });
    const k = thinker({ thought: REPORT, action: null });
    expect(await at(95, k.fn)).toEqual({ written: 0, skipped: 0, quiet: 0 });
    expect(k.calls).toHaveLength(0);
    expect(reportsOf(t.token)).toEqual([]);
  });

  it("is written by the stand-in thinker too, so all of this runs without a model", async () => {
    const w = world(), t = await lived(w, "STND", { capEnd: 2.3, feesEnd: 0.08 });
    expect(await reportDue({ chain: w.chain, thinker: standInThinker, env: ACT, now: NEXT, usdPerEth: USD })).toMatchObject({ written: 1 });
    expect(reportsOf(t.token)[0].text).toMatch(/^My report for 5 October\. Market cap 2 ETH at the start of the day, 2\.3 ETH at the end \(\+15%\)\. Holders 30 at the start, 30 at the end \(0\)\. I carried out no moves\. I thought 1 time/);
  });
});

describe("who is told", () => {
  it("puts the report in the inbox of the creator and of the holders who use Mylo, and of nobody else", async () => {
    const w = world(), t = await lived(w, "TELL", { feesEnd: 0.08 });
    const user = addr(), stranger = addr();
    for (const a of [user, stranger, t.creator]) getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(t.token, a, "1000000000000000000000");
    getDb().prepare("INSERT INTO mylo_conversations (id, owner, title, created_at, updated_at) VALUES (?,?,?,?,?)").run(`c-${user}`, user, "hello", new Date(T0).toISOString(), new Date(T0).toISOString());
    const now = Date.now();
    await reportDue({ chain: w.chain, thinker: thinker({ thought: "Fees came in and I held. Watching holders next.", action: null }).fn, env: ACT, now: NEXT, usdPerEth: USD });
    getDb().prepare("UPDATE mind_reports SET at = ? WHERE token = ?").run(new Date(now - 60_000).toISOString(), t.token);
    const old = process.env.AGENT_MINDS; process.env.AGENT_MINDS = "on";
    try { runMyloPass(now); runMyloPass(now + 60_000); } finally { if (old === undefined) delete process.env.AGENT_MINDS; else process.env.AGENT_MINDS = old; }
    expect(inbox(t.creator).filter((n) => n.kind === "report")).toEqual([{ kind: "report", title: "TELL Token's mind reported on 5 October", body: "Fees came in and I held. Watching holders next.", link: `/launch?token=${t.token}` }]);
    expect(inbox(user).filter((n) => n.kind === "report")).toEqual([{ kind: "report", title: "Daily report from TELL Token's mind, 5 October", body: "Fees came in and I held. Watching holders next.", link: `/launch?token=${t.token}` }]);
    expect(inbox(stranger)).toEqual([]);
  });
});
