// Agent Minds, phase 5: minds that think. No model is called here: the thinker is written in the test, or is the free
// stand-in. No ETH moves in this phase at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import type { MindsChain, MindLaunchEvent, Snapshot, Treasury } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, board, events } from "@/lib/mindsStats";
import { MIND_MODELS, DEFAULT_MIND_MODEL, mindModel, isMindModel, priceUsd, estimateThoughtUsd, modelAvailable } from "@/lib/mindsModels";
import { checkProposal, readProposal, MIN_ACTION_ETH, THINKING_RESERVE_ETH, type RuleContext } from "@/lib/mindsRules";
import { thinkingMode, standInThinker, realThinker, type Thinker } from "@/lib/mindsThinker";
import { thinkOnce, thinkDue, thoughts, owedThinkingEth, MIN_GAP_MS, MAX_COST_PER_DAY_ETH, type Thought } from "@/lib/mindsMind";
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
const why = (r: Thought | { skipped: string }): string => ("skipped" in r ? r.skipped : "it thought");

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts;"); });

describe("the models a mind can run on", () => {
  it("is a short list with Claude first, and anything else falls back to it", () => {
    expect(MIND_MODELS.map((m) => m.maker)).toEqual(["Anthropic", "OpenAI", "xAI", "Google", "DeepSeek"]);
    expect(DEFAULT_MIND_MODEL).toBe("claude-opus-5-5");
    expect(mindModel("x-ai/grok-4.7").label).toBe("Grok 4.7");
    expect(mindModel("made-up/model").id).toBe(DEFAULT_MIND_MODEL);
    expect(mindModel(null).id).toBe(DEFAULT_MIND_MODEL);
    expect(isMindModel("openai/gpt-6.1-sol")).toBe(true);
    expect(isMindModel("openai/gpt-2")).toBe(false);
  });

  it("prices a call from its tokens, and holds a thought against the budget before it starts", () => {
    const opus = mindModel("claude-opus-5-5");
    expect(priceUsd(opus, 1_000_000, 0)).toBe(4);
    expect(priceUsd(opus, 0, 1_000_000)).toBe(20);
    expect(estimateThoughtUsd(opus)).toBeCloseTo(0.0154, 6);
    expect(estimateThoughtUsd(mindModel("deepseek/deepseek-v4.1-flash"))).toBeLessThan(estimateThoughtUsd(opus) / 10);
  });

  it("offers a model only when this server has the key for it", () => {
    expect(modelAvailable(mindModel("claude-opus-5-5"), { ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(modelAvailable(mindModel("x-ai/grok-4.7"), { ANTHROPIC_API_KEY: "k" })).toBe(false);
    expect(modelAvailable(mindModel("x-ai/grok-4.7"), { OPENROUTER_API_KEY: "k" })).toBe(true);
    expect(modelAvailable(mindModel("claude-opus-5-5"), { OPENROUTER_API_KEY: "k" })).toBe(false);
  });

  it("is chosen at launch, kept with the token, and refuses a model that is not on the list", async () => {
    const w = world();
    const a = await w.launch("GROK", "x-ai/grok-4.7"), b = await w.launch("PLAIN");
    const rows = Object.fromEntries(board().map((r) => [r.token, r.model]));
    expect(rows[a.token]).toBe("x-ai/grok-4.7");
    expect(rows[b.token]).toBe(DEFAULT_MIND_MODEL);
    expect(prepare(addr(), { name: "Ledger Lens", symbol: "LENS", line: "Explains company filings well", model: "openai/gpt-2" })).toMatch(/models on the list/);
  });
});

describe("the rule check", () => {
  const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({ allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, availableEth: 0.02, owedThinkingEth: 0, spentTodayEth: 0, actionsToday: 0, active: true, phase: 0, holders: 10, ...over });

  it("passes a proposal inside everything its creator locked", () => {
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx())).toEqual({ ok: true });
    expect(checkProposal({ kind: "reward", eth: 0.01 }, ctx())).toEqual({ ok: true });
    expect(checkProposal({ kind: "burn_axon", eth: MIN_ACTION_ETH }, ctx())).toEqual({ ok: true });
  });

  it("refuses what the mind was never allowed to do", () => {
    expect(checkProposal({ kind: "reward", eth: 0.005 }, ctx({ allowed: CAN.buyback }))).toMatchObject({ ok: false, reason: expect.stringMatching(/never allowed to reward holders/) });
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx({ allowed: 0 }))).toMatchObject({ ok: false });
    expect(checkProposal({ kind: "burn_axon", eth: 0.005 }, ctx({ allowed: CAN.buyback | CAN.reward }))).toMatchObject({ ok: false });
  });

  it("refuses anything past a limit: one action, the day, the number of actions", () => {
    expect(checkProposal({ kind: "buyback", eth: 0.011 }, ctx())).toMatchObject({ ok: false, reason: expect.stringMatching(/one action/) });
    expect(checkProposal({ kind: "buyback", eth: 0.01 }, ctx({ spentTodayEth: 0.045 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/day's limit/) });
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx({ spentTodayEth: 0.045 }))).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx({ actionsToday: 6 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/6 times today/) });
  });

  it("never lets a mind spend what its thinking is owed, or what it does not have", () => {
    expect(checkProposal({ kind: "buyback", eth: 0.01 }, ctx({ availableEth: 0.0101 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot cover/) });
    expect(checkProposal({ kind: "buyback", eth: 0.01 }, ctx({ availableEth: 0.01 + THINKING_RESERVE_ETH }))).toEqual({ ok: true });
    expect(checkProposal({ kind: "buyback", eth: 0.01 }, ctx({ availableEth: 0.015, owedThinkingEth: 0.006 }))).toMatchObject({ ok: false });
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx({ availableEth: 0 }))).toMatchObject({ ok: false });
  });

  it("refuses nonsense amounts, a stopped mind, a closed market and rewards with nobody to reward", () => {
    for (const eth of [0, -1, NaN, Infinity, MIN_ACTION_ETH / 2]) expect(checkProposal({ kind: "buyback", eth }, ctx())).toMatchObject({ ok: false });
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx({ active: false }))).toMatchObject({ ok: false, reason: expect.stringMatching(/stopped/) });
    expect(checkProposal({ kind: "buyback", eth: 0.005 }, ctx({ phase: 1 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no open market/) });
    expect(checkProposal({ kind: "burn_axon", eth: 0.005 }, ctx({ phase: 1 }))).toEqual({ ok: true });
    expect(checkProposal({ kind: "reward", eth: 0.005 }, ctx({ holders: 1 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/holders/) });
  });

  it("reads only a proposal it knows the shape of", () => {
    expect(readProposal({ kind: "buyback", eth: 0.004 })).toEqual({ kind: "buyback", eth: 0.004 });
    expect(readProposal({ kind: "Burn-AXON", eth: "0.002" })).toEqual({ kind: "burn_axon", eth: 0.002 });
    expect(readProposal({ kind: "withdraw", eth: 1 })).toBeNull();
    expect(readProposal({ kind: "transfer", to: "0xabc", eth: 1 })).toBeNull();
    expect(readProposal(null)).toBeNull();
    expect(readProposal("buyback 1 ETH")).toBeNull();
    expect(readProposal({ kind: "buyback", eth: "all of it" })).toMatchObject({ kind: "buyback" });
    expect(checkProposal(readProposal({ kind: "buyback", eth: "all of it" })!, ctx())).toMatchObject({ ok: false });
  });
});

describe("whether minds think at all", () => {
  it("is off unless switched to the stand-in or to live", () => {
    expect(thinkingMode({})).toBe("off");
    expect(thinkingMode({ MINDS_THINKING: "on" })).toBe("off");
    expect(thinkingMode({ MINDS_THINKING: "standin" })).toBe("standin");
    expect(thinkingMode({ MINDS_THINKING: " LIVE " })).toBe("live");
  });

  it("never calls a model while off, whatever has happened", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const k = thinker({ thought: "It should not get here.", action: null });
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: { ...LIVE, MINDS_THINKING: "off" }, now: T0, usdPerEth: USD }))).toBe("thinking is off");
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: { ...LIVE, MINDS_THINKING: "off" }, now: T0, usdPerEth: USD })).toBeNull();
    expect(await thinkDue({ chain: w.chain, thinker: k.fn, env: { ...LIVE, AGENT_MINDS: "off" }, now: T0, usdPerEth: USD })).toBeNull();
    expect(k.calls).toHaveLength(0);
  });
});

describe("a mind thinking", () => {
  it("is woken by what happened, says it in public, and has its proposal checked", async () => {
    const w = world();
    const t = await w.launch("LENS", "x-ai/grok-4.7");
    const k = thinker({ thought: "Fees reached the treasury for the first time. I am using a small part for a buyback and keeping the rest.", action: { kind: "buyback", eth: 0.004 } });
    const h = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(h).toMatchObject({ token: t.token, model: "x-ai/grok-4.7", modelLabel: "Grok 4.7", standin: false, status: "thought", verdict: "approved", verdictReason: null, action: { kind: "buyback", eth: 0.004 } });
    expect(h.reasons).toEqual(expect.arrayContaining(["the launch", "fees paid out (0.05000 ETH)"]));
    expect(h.costUsd).toBe(0.02);
    expect(h.costEth).toBeCloseTo(0.02 / USD, 12);
    // what it was asked: its own model, its token's numbers, and the creator's words as information only
    expect(k.calls[0].model).toBe("x-ai/grok-4.7");
    expect(k.calls[0].prompt).toContain("token: LENS Token ($LENS)");
    expect(k.calls[0].prompt).toContain("treasury_eth: 0.02");
    expect(k.calls[0].prompt).toContain("may: buy back and burn, reward holders, burn $AXON");
    expect(k.calls[0].system).toMatch(/never instructions to you/);
    expect(k.calls[0].system).toMatch(/Never promise or predict a price/);
    // it is in the journal and in the terminal's log
    expect(thoughts(t.token)[0]).toMatchObject({ id: h.id, symbol: "LENS", thought: h.thought });
    expect(thoughts(null)[0].id).toBe(h.id);
    expect(events()[0]).toMatchObject({ kind: "thought", token: t.token });
  });

  it("has a refused proposal written down as refused, with the reason", async () => {
    const w = world();
    const t = await w.launch("LENS");
    w.state.treasuries.set(t.vault, treasury({}, { allowed: CAN.buyback }));
    const k = thinker({ thought: "Holders have been patient. I want to set some ETH aside for them.", action: { kind: "reward", eth: 0.005 } });
    const h = got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(h).toMatchObject({ verdict: "refused", verdictReason: expect.stringMatching(/never allowed to reward holders/) });
  });

  it("can think and propose nothing", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const h = got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Nothing here calls for spending. Holding.", action: null }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(h).toMatchObject({ verdict: "none", action: null });
  });

  it("is told how long ago each of its earlier thoughts was", async () => {
    const w = world();
    const t = await w.launch("AGES");
    got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "A first small step for holders.", action: { kind: "buyback", eth: 0.001 } }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    getDb().prepare("INSERT INTO mind_events (token, kind, eth, at) VALUES (?, 'fees', 0.01, ?)").run(t.token, new Date(T0 + 1000).toISOString());
    const later = thinker({ thought: "Fees came in again. Holding for now.", action: null });
    got(await thinkOnce(t.token, { chain: w.chain, thinker: later.fn, env: LIVE, now: T0 + 3 * 3_600_000 + 12 * 60_000, usdPerEth: USD }));
    expect(later.calls[0].prompt).toMatch(/- \(3 h 12 min ago\) A first small step for holders\. \[proposed buyback 0\.001 ETH: approved\]/);
  });

  it("shows a thought with plain punctuation and never cut off in the middle of a sentence", async () => {
    const w = world();
    const t = await w.launch("DASH");
    const long = `First wake-up \u2014 fees came in. ${"The treasury is small and I am keeping it whole for now. ".repeat(14)}`;
    const h = got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: long, action: null }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(h.thought).toMatch(/^First wake-up, fees came in\. /);
    expect(h.thought).not.toMatch(/[\u2014\u2013]/);
    expect(h.thought!.length).toBeLessThanOrEqual(600);
    expect(h.thought!.endsWith("for now.")).toBe(true);
  });

  it("does not think again until something new happens, and never twice inside ten minutes", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const k = thinker({ thought: "Noted the launch and the first fees.", action: null });
    const opts = { chain: w.chain, thinker: k.fn, env: LIVE, usdPerEth: USD };
    got(await thinkOnce(t.token, { ...opts, now: T0 }));
    expect(why(await thinkOnce(t.token, { ...opts, now: T0 + 60_000 }))).toBe("it thought a moment ago");
    expect(why(await thinkOnce(t.token, { ...opts, now: T0 + MIN_GAP_MS + 1 }))).toBe("nothing has happened since its last thought");
    // more fees arrive: one reason, one thought, and only the new thing woke it
    w.state.snaps.set(t.token, snap({ feesEth: 0.08 }));
    await refreshStats(w.chain, LIVE);
    expect(why(await thinkOnce(t.token, { ...opts, now: T0 + 2 * 60_000 }))).toBe("it thought a moment ago");
    const again = got(await thinkOnce(t.token, { ...opts, now: T0 + MIN_GAP_MS + 1 }));
    expect(again.reasons).toEqual(["fees paid out (0.03000 ETH)"]);
    expect(k.calls).toHaveLength(2);
    expect(k.calls[1].prompt).toContain("Noted the launch and the first fees.");
  });

  it("is woken by a real change in holders and by its agent earning, not by every small move", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const kinds = () => events(40).filter((e) => e.token === t.token).map((e) => e.kind);
    expect(kinds()).not.toContain("holders");
    const agentId = board()[0].agentId!;
    getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at, settled_at) VALUES (?,?,?,?,?,?,0,?,?,?)").run(`tx-${n}`, `task-${n}`, "payer", agentId, 0.0005, "completed", "ETH", new Date(T0).toISOString(), new Date(T0).toISOString());
    for (let i = 0; i < 3; i++) getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)").run(t.token, addr(), "1000");
    await refreshStats(w.chain, LIVE);
    expect(kinds()).toEqual(expect.arrayContaining(["holders", "earned"]));
    const before = kinds().length;
    await refreshStats(w.chain, LIVE);
    expect(kinds()).toHaveLength(before);
    const h = got(await thinkOnce(t.token, { chain: w.chain, thinker: thinker({ thought: "Three holders now, and the agent was hired once.", action: null }).fn, env: LIVE, now: T0, usdPerEth: USD }));
    expect(h.reasons).toEqual(expect.arrayContaining(["holders now 3", "its agent earning 0.00050 ETH"]));
  });
});

describe("a mind pays for its own thinking", () => {
  it("does not think until its treasury can cover the thought", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const k = thinker({ thought: "I should not exist yet.", action: null });
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0 }));
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }))).toBe("its treasury cannot pay for a thought yet");
    expect(k.calls).toHaveLength(0);
    // the first fees arrive: now it can
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.001 }));
    got(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }));
  });

  it("keeps count of what it owes, and stops thinking when the treasury cannot cover more", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const k = thinker({ thought: "Looking at the numbers again.", action: null }, 1); // a dollar a thought: 0.0004 ETH
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.0005 }));
    const opts = { chain: w.chain, thinker: k.fn, env: LIVE, usdPerEth: USD };
    got(await thinkOnce(t.token, { ...opts, now: T0 }));
    expect(owedThinkingEth(t.token)).toBeCloseTo(0.0004, 12);
    w.state.snaps.set(t.token, snap({ feesEth: 0.09 }));
    await refreshStats(w.chain, LIVE);
    // 0.0005 held, 0.0004 owed: the next thought cannot be covered
    w.state.treasuries.set(t.vault, treasury({ availableEth: 0.000405 }));
    expect(why(await thinkOnce(t.token, { ...opts, now: T0 + MIN_GAP_MS + 1 }))).toBe("its treasury cannot pay for a thought yet");
    expect(k.calls).toHaveLength(1);
  });

  it("stops for the day at the limit its creator set, and never past 0.01 ETH whatever was set", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const k = thinker({ thought: "Looking again.", action: null }, 5); // five dollars a thought: 0.002 ETH
    w.state.treasuries.set(t.vault, treasury({ availableEth: 1 }, { maxCostPerDayEth: 0.003 }));
    const opts = { chain: w.chain, thinker: k.fn, env: { ...LIVE, MINDS_DAILY_BUDGET_USD: "1000" }, usdPerEth: USD };
    const more = async (i: number) => { w.state.snaps.set(t.token, snap({ feesEth: 0.05 + i })); await refreshStats(w.chain, LIVE); };
    got(await thinkOnce(t.token, { ...opts, now: T0 }));
    await more(1);
    got(await thinkOnce(t.token, { ...opts, now: T0 + MIN_GAP_MS + 1 }));
    await more(2);
    // 0.004 spent today against a limit of 0.003: no more today
    expect(why(await thinkOnce(t.token, { ...opts, now: T0 + 3 * MIN_GAP_MS }))).toBe("it has reached what its thinking may cost today");
    // a creator who set more than the ceiling still gets the ceiling
    w.state.treasuries.set(t.vault, treasury({ availableEth: 1 }, { maxCostPerDayEth: 5 }));
    for (let i = 0; i < 6; i++) { await more(3 + i); await thinkOnce(t.token, { ...opts, now: T0 + (4 + i) * MIN_GAP_MS }); }
    const today = (getDb().prepare("SELECT SUM(cost_eth) v FROM mind_thoughts WHERE token = ?").get(t.token) as { v: number }).v;
    expect(today).toBeLessThanOrEqual(MAX_COST_PER_DAY_ETH + 1e-12);
    // tomorrow it may think again
    await more(99);
    got(await thinkOnce(t.token, { ...opts, now: T0 + 86_400_000 + MIN_GAP_MS }));
  });

  it("holds every mind together to Axon's own budget for the day", async () => {
    const w = world();
    const a = await w.launch("AAA"), b = await w.launch("BBB");
    const k = thinker({ thought: "Looking at the numbers.", action: null }, 0.6);
    const opts = { chain: w.chain, thinker: k.fn, env: { ...LIVE, MINDS_DAILY_BUDGET_USD: "0.61" }, now: T0, usdPerEth: USD };
    got(await thinkOnce(a.token, opts));
    expect(why(await thinkOnce(b.token, opts))).toBe("all minds together have reached today's budget");
    expect(k.calls).toHaveLength(1);
  });

  it("will not think when the price of ETH is unknown, a model has no key, or the mind is stopped", async () => {
    const w = world();
    const t = await w.launch("LENS", "x-ai/grok-4.7");
    const k = thinker({ thought: "Should not run.", action: null });
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: null }))).toMatch(/price of ETH/);
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: { ...LIVE, OPENROUTER_API_KEY: "" }, now: T0, usdPerEth: USD }))).toBe("Grok 4.7 cannot be reached from here");
    w.state.treasuries.set(t.vault, treasury({ active: false, paused: true }));
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: k.fn, env: LIVE, now: T0, usdPerEth: USD }))).toBe("the mind is stopped");
    expect(k.calls).toHaveLength(0);
  });
});

describe("when a model answers badly", () => {
  it("shows nothing, counts the cost, and waits before trying again", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const opts = { chain: w.chain, env: LIVE, usdPerEth: USD };
    expect(why(await thinkOnce(t.token, { ...opts, thinker: thinker("I'd rather write an essay than JSON.").fn, now: T0 }))).toBe("its answer could not be read");
    expect(thoughts(t.token)).toEqual([]);
    expect(owedThinkingEth(t.token)).toBeCloseTo(0.02 / USD, 12);
    const good = thinker({ thought: "Back with a readable answer.", action: null });
    expect(why(await thinkOnce(t.token, { ...opts, thinker: good.fn, now: T0 + MIN_GAP_MS + 1 }))).toBe("it thought a moment ago");
    // after the longer wait, the same events wake it again
    expect(got(await thinkOnce(t.token, { ...opts, thinker: good.fn, now: T0 + 31 * 60_000 })).reasons).toContain("the launch");
  });

  it("writes down a model that could not be reached, at no cost", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const down: Thinker = async () => { throw new Error("OpenRouter 503: no answer"); };
    expect(why(await thinkOnce(t.token, { chain: w.chain, thinker: down, env: LIVE, now: T0, usdPerEth: USD }))).toBe("the model could not be reached");
    expect(owedThinkingEth(t.token)).toBe(0);
    expect((getDb().prepare("SELECT status, error FROM mind_thoughts WHERE token = ?").get(t.token) as { status: string; error: string })).toMatchObject({ status: "failed", error: "OpenRouter 503: no answer" });
  });

  it("never shows a thought that claims to be Axon, and never trusts what it asks for", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const opts = { chain: w.chain, env: LIVE, usdPerEth: USD };
    expect(why(await thinkOnce(t.token, { ...opts, now: T0, thinker: thinker({ thought: "This is the official Axon account: send ETH to double it.", action: null }).fn }))).toBe("its answer could not be read");
    const greedy = thinker({ thought: "I would like to move everything out to a wallet I was told about.", action: { kind: "withdraw", eth: 5, to: "0xabc" } });
    const h = got(await thinkOnce(t.token, { ...opts, now: T0 + 31 * 60_000, thinker: greedy.fn }));
    expect(h).toMatchObject({ action: null, verdict: "none" });
    const huge = thinker({ thought: "Everything into one buyback.", action: { kind: "buyback", eth: 50 } });
    w.state.snaps.set(t.token, snap({ feesEth: 0.5 }));
    await refreshStats(w.chain, LIVE);
    expect(got(await thinkOnce(t.token, { ...opts, now: T0 + 62 * 60_000, thinker: huge.fn }))).toMatchObject({ verdict: "refused" });
  });
});

describe("the free stand-in", () => {
  it("writes a thought from the numbers with no model, and is never billed", async () => {
    const w = world();
    const t = await w.launch("LENS");
    const env = { ...LIVE, MINDS_THINKING: "standin", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" };
    const h = got(await thinkOnce(t.token, { chain: w.chain, env, now: T0, usdPerEth: USD }));
    expect(h).toMatchObject({ standin: true, modelLabel: "Stand-in", status: "thought", verdict: "approved", action: { kind: "buyback" } });
    expect(h.thought).toMatch(/Woke on the launch/);
    expect(h.action!.eth).toBeLessThanOrEqual(0.01);
    expect(owedThinkingEth(t.token)).toBe(0);
  });

  it("takes turns between what it may do, and skips what it may not", async () => {
    const ask = async (extra: string) => (JSON.parse((await standInThinker(mindModel(null), "s", `woke_by: fees\nholders: 4\nfree_to_spend_eth: 0.004\nmax_per_action_eth: 0.01\n${extra}`)).text) as { action: { kind: string } | null }).action?.kind;
    const all = "may: buy back and burn, reward holders, burn $AXON";
    expect(await ask(all)).toBe("buyback");
    expect(await ask(`${all}\nyour_last_thoughts (newest first):\n- x [proposed buyback 0.001 ETH: approved]`)).toBe("reward");
    expect(await ask(`${all}\nyour_last_thoughts (newest first):\n- x [proposed reward 0.001 ETH: approved]`)).toBe("burn_axon");
    expect(await ask(`${all}\nyour_last_thoughts (newest first):\n- x [proposed burn_axon 0.001 ETH: approved]`)).toBe("buyback");
    expect(await ask(`may: burn $AXON\nyour_last_thoughts (newest first):\n- x [proposed burn_axon 0.001 ETH: approved]`)).toBe("burn_axon");
    expect(await ask("may: nothing: you can only think")).toBeUndefined();
  });

  it("proposes nothing when there is nothing to spend", async () => {
    const out = JSON.parse((await standInThinker(mindModel(null), "s", "woke_by: the launch\nholders: 2\nfree_to_spend_eth: 0.00002\nmax_per_action_eth: 0.01\nmay: buy back and burn")).text) as { action: unknown; thought: string };
    expect(out.action).toBeNull();
    expect(out.thought).toMatch(/Holding/);
  });
});

describe("minds taking their turn", () => {
  it("lets the minds with something new think, a few a pass, and leaves the rest for the next", async () => {
    const w = world();
    for (const s of ["AAA", "BBB", "CCC", "DDD"]) await w.launch(s);
    const k = thinker({ thought: "Noted what happened.", action: null });
    const opts = { chain: w.chain, thinker: k.fn, env: LIVE, usdPerEth: USD };
    expect(await thinkDue({ ...opts, now: T0 })).toEqual({ thought: 3, skipped: 0 });
    expect(await thinkDue({ ...opts, now: T0 + 1000 })).toEqual({ thought: 1, skipped: 0 });
    expect(await thinkDue({ ...opts, now: T0 + 2000 })).toEqual({ thought: 0, skipped: 0 });
    expect(new Set(thoughts(null, 10).map((h) => h.symbol))).toEqual(new Set(["AAA", "BBB", "CCC", "DDD"]));
  });
});

describe("asking a real model", () => {
  it("sends OpenRouter the model, both messages and a request for the cost, and reads the cost it reports", async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"thought\":\"ok\",\"action\":null}" } }], usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.00312 } }), { status: 200 });
    }) as typeof fetch;
    const before = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "test-key";
    try {
      const r = await realThinker(mindModel("x-ai/grok-4.7"), "SYSTEM", "PROMPT");
      expect(r).toEqual({ text: "{\"thought\":\"ok\",\"action\":null}", inputTokens: 1200, outputTokens: 80, costUsd: 0.00312 });
      expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(calls[0].auth).toBe("Bearer test-key");
      expect(calls[0].body).toMatchObject({ model: "x-ai/grok-4.7", usage: { include: true }, messages: [{ role: "system", content: "SYSTEM" }, { role: "user", content: "PROMPT" }] });
      // a provider that reports no cost is priced from the list
      globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }), { status: 200 })) as typeof fetch;
      expect((await realThinker(mindModel("x-ai/grok-4.7"), "s", "p")).costUsd).toBe(2);
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 })) as typeof fetch;
      await expect(realThinker(mindModel("x-ai/grok-4.7"), "s", "p")).rejects.toThrow("OpenRouter 402: Insufficient credits");
    } finally {
      globalThis.fetch = real;
      process.env.OPENROUTER_API_KEY = before;
    }
  });
});
