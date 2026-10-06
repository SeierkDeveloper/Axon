// Mylo meets the minds, phase 2: Mylo reads one token and its mind, and says what a quiet mind is waiting for.
import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({
  treasuries: new Map<string, unknown>(),
  days: new Map<string, { spentTodayEth: number; actionsToday: number; costTodayEth: number }>(),
}));
vi.mock("@/lib/ethPrice", () => ({ ethUsd: async () => 2000 }));
vi.mock("@/lib/mindsChain", async (orig) => {
  const real = await orig<typeof import("@/lib/mindsChain")>();
  const no = (what: string) => async () => { throw new Error(`${what} is not read here`); };
  return {
    ...real,
    mindsChain: {
      ...real.mindsChain,
      head: no("head"), launches: no("launches"), snapshot: no("snapshot"), transfers: no("transfers"), feeFlow: no("fee flow"),
      treasury: async (vault: string) => { const t = world.treasuries.get(vault); if (!t) throw new Error("unreadable"); return t; },
      vaultDay: async (vault: string) => { const d = world.days.get(vault); if (!d) throw new Error("unreadable"); return d; },
    },
  };
});

import { getDb } from "@/lib/db";
import { runTool, myloToolDefs, MINDS_TOOL_DEFS, type Card } from "@/lib/myloTools";
import { TOOLS, toolGate, TURN_BUDGET } from "@/lib/myloPolicy";
import { upsertToken } from "@/lib/mindsStore";
import { addEvent } from "@/lib/mindsStats";
import { mindStatus } from "@/lib/mindsStatus";
import { mindsChain, type Treasury } from "@/lib/mindsChain";
import { CAN } from "@/lib/mindsLaunch";
import { MIN_GAP_MS } from "@/lib/mindsMind";
import { startConversation } from "@/lib/myloStore";
import { NextRequest } from "next/server";
import { GET as tokenGET } from "@/app/api/minds/tokens/[token]/route";

let n = 0;
const addr = () => `0x${(++n + 8_800_000).toString(16).padStart(40, "0")}`;
const guest = () => ({ wallet: null, owner: "guest:details", conversationId: startConversation("guest:details", "t").id });
const ON = { AGENT_MINDS: "on", MINDS_THINKING: "standin" };
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const treasury = (over: Partial<Treasury> = {}): Treasury => ({
  availableEth: 0.02, reservedEth: 0.003, boughtBackEth: 0.004, axonBurnedEth: 0, rewardedEth: 0.005, claimedEth: 0.002, thinkingEth: 0.0005, rewards: 1, paused: false, frozen: false, active: true,
  limits: { allowed: CAN.buyback | CAN.reward, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01 }, ...over,
});

interface Seed { name: string; symbol: string; mindBps?: number; attached?: boolean; mcapEth?: number; model?: string; chain?: Partial<Treasury> | null; actionsToday?: number; unread?: boolean }
function token(s: Seed): { token: string; vault: string } {
  const t = addr(), vault = addr();
  upsertToken({
    token: t, creator: addr(), agentId: null, agentRef: `0x${"0".repeat(64)}`, pot: addr(), splitter: addr(), vault, payout: addr(),
    taxBps: 300, creatorBps: 3000, burnBps: 2000, axonBps: 1000, mindBps: s.mindBps ?? 4000, attached: s.attached ?? false, name: s.name, symbol: s.symbol, logo: null, description: `${s.name} explains filings. Launched on Axon.`,
    model: s.model ?? "claude-opus-5-5", mindUrl: null, blockNumber: 2000 + n, txHash: `0x${n.toString(16).padStart(64, "0")}`, launchedAt: ago(600),
  });
  if (!s.unread) {
    getDb().prepare("INSERT INTO mind_stats (token, phase, price_eth, mcap_eth, curve_bps, holders, fees_eth, to_mind_eth, burned_tokens, burned_eth, burns, treasury_eth, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(t, 0, (s.mcapEth ?? 5) / 1e9, s.mcapEth ?? 5, 3400, 42, 0.06, 0.024, 900_000, 0.012, 3, s.chain?.availableEth ?? 0.02, ago(1));
  }
  if (s.chain !== null) { world.treasuries.set(vault, treasury(s.chain)); world.days.set(vault, { spentTodayEth: 0.004, actionsToday: s.actionsToday ?? 2, costTodayEth: 0.0001 }); }
  return { token: t, vault };
}
/** A thought in the journal, having seen every event so far; and what became of its proposal. */
function thought(tok: string, minutesAgo: number, text: string, action: { kind: string; eth: number } | null = null, o: { verdict?: string; why?: string; sent?: string; tx?: string; costEth?: number; status?: string } = {}): number {
  const db = getDb();
  const seen = (db.prepare("SELECT COALESCE(MAX(id), 0) v FROM mind_events WHERE token = ?").get(tok) as { v: number }).v;
  const id = Number(db.prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, action, verdict, verdict_reason, input_tokens, output_tokens, cost_usd, cost_eth, last_event_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(tok, ago(minutesAgo), "claude-opus-5-5", 0, o.status ?? "thought", JSON.stringify(["fees paid out (0.00400 ETH)"]), text, action ? JSON.stringify(action) : null, o.verdict ?? (action ? "approved" : "none"), o.why ?? null, 1500, 300, 0.02, o.costEth ?? 0.00001, seen, null).lastInsertRowid);
  if (o.sent) db.prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, tx_hash, error, at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, tok, action!.kind, "0", action!.eth, o.sent, o.tx ?? null, null, ago(minutesAgo), ago(minutesAgo));
  return id;
}
const state = async (tok: string, env: Record<string, string> = ON) => (await mindStatus(tok, { chain: mindsChain, env, now: NOW, usdPerEth: 2000 }))!;

beforeEach(() => { vi.stubEnv("AGENT_MINDS", "on"); vi.stubEnv("MINDS_THINKING", "standin"); });

describe("what a mind is doing right now", () => {
  it("knows nothing of a token that is not here", async () => {
    expect(await mindStatus(addr(), { env: ON, now: NOW, usdPerEth: 2000 })).toBeNull();
  });

  it("says when minds are paused, when this one is stopped, frozen, or paused by its creator", async () => {
    const a = token({ name: "Halt One", symbol: "HLT1" });
    expect((await state(a.token, { AGENT_MINDS: "on", MINDS_THINKING: "off" })).state).toBe("halted");
    expect((await state(a.token, { AGENT_MINDS: "off", MINDS_THINKING: "live" })).state).toBe("halted");

    const frozen = token({ name: "Frozen One", symbol: "FRZ", chain: { frozen: true, active: false } });
    expect(await state(frozen.token)).toMatchObject({ state: "frozen", text: expect.stringMatching(/frozen.*holders can still claim/) });
    const paused = token({ name: "Paused One", symbol: "PSD", chain: { paused: true, active: false } });
    expect(await state(paused.token)).toMatchObject({ state: "paused", text: expect.stringMatching(/Its creator has paused this mind/) });

    getDb().prepare("UPDATE mind_tokens SET stopped_at = ? WHERE token = ?").run(ago(5), a.token);
    expect((await state(a.token)).state).toBe("stopped");
  });

  it("says why a mind with nothing to spend stays quiet", async () => {
    const none = token({ name: "No Share", symbol: "NOSH", mindBps: 0, chain: { availableEth: 0 } });
    expect(await state(none.token)).toMatchObject({ state: "no_treasury", text: expect.stringMatching(/None of this token's fees go to its mind/) });

    // a share of the fees, but not yet enough in the treasury for one thought
    const thin = token({ name: "Thin Purse", symbol: "THIN", chain: { availableEth: 0.000001 } });
    expect(await state(thin.token)).toMatchObject({ state: "cannot_pay", text: expect.stringMatching(/cannot pay for a thought/) });

    const unread = token({ name: "Just Born", symbol: "BORN", unread: true });
    expect((await state(unread.token)).state).toBe("unread");
  });

  it("says when a limit locked at launch is what holds it", async () => {
    const spent = token({ name: "All Used", symbol: "USED", actionsToday: 6 });
    thought(spent.token, 40, "Fees came in. I bought back a little.");
    expect(await state(spent.token)).toMatchObject({ state: "actions_used", text: "It has used all 6 of the actions it may take today, a limit locked at launch. It can act again after midnight UTC." });

    const dear = token({ name: "Deep Thinker", symbol: "DEEP" });
    thought(dear.token, 30, "A long thought.", null, { costEth: 0.01 });
    expect(await state(dear.token)).toMatchObject({ state: "thinking_capped", text: expect.stringMatching(/after midnight UTC/) });
  });

  it("tells waiting from about to think, by what happened since its last thought", async () => {
    const t = token({ name: "Patient One", symbol: "WAIT" });
    expect(await state(t.token)).toMatchObject({ state: "waiting", text: expect.stringMatching(/^It has not thought yet\. It wakes on the next fee payout/) });

    addEvent(t.token, "fees", { eth: 0.004, at: ago(50) });
    expect((await state(t.token)).state).toBe("about_to_think");

    thought(t.token, 45, "Fees came in. I am holding for now.");
    expect(await state(t.token)).toMatchObject({ state: "waiting", text: "Nothing has happened to its token since its last thought. It wakes on the next fee payout, burn or holder milestone, or when its agent earns. It also checks in on its own about every 1 h; the next is in about 15 min." });

    // its own thought and its own actions are not news to it
    addEvent(t.token, "thought", { at: ago(45) });
    addEvent(t.token, "bought", { eth: 0.002, at: ago(44) });
    expect((await state(t.token)).state).toBe("waiting");

    addEvent(t.token, "holders", { tokens: 50, at: ago(20) });
    expect((await state(t.token)).state).toBe("about_to_think");
    thought(t.token, 3, "Fifty holders. Noted.");
    addEvent(t.token, "burn", { tokens: 1000, eth: 0.001, at: ago(2) });
    expect(await state(t.token)).toMatchObject({ state: "resting", text: expect.stringContaining(`every ${MIN_GAP_MS / 60_000} minutes`) });

    // a mind given to an earlier token is woken by other things
    const old = token({ name: "Old Anchor", symbol: "ANCH", attached: true });
    expect((await state(old.token)).text).toMatch(/when its treasury is topped up or its agent earns/);
  });

  it("still answers from Axon's own records when the chain cannot be read", async () => {
    const t = token({ name: "Dark Chain", symbol: "DARK", chain: null });
    const s = await state(t.token);
    expect(s).toMatchObject({ state: "waiting", treasury: null, day: null });
  });
});

describe("the token's page saying what its mind is doing", () => {
  const get = async (tok: string) => { const res = await tokenGET(new NextRequest(`http://x/api/minds/tokens/${tok}`), { params: Promise.resolve({ token: tok }) }); return { status: res.status, body: (await res.json()) as { mind: { state: string; text: string; actionsToday: number | null; actionsAllowed: number | null } | null; treasury: unknown } }; };

  it("uses a treasury somebody has just read instead of reading it again", async () => {
    const t = token({ name: "Read Once", symbol: "ONCE" });
    // the chain says it runs; the caller's own reading says its creator paused it, and that reading is what counts
    const s = await mindStatus(t.token, { chain: mindsChain, env: ON, now: NOW, usdPerEth: 2000, treasury: treasury({ paused: true, active: false }) });
    expect(s!.state).toBe("paused");
    expect((await mindStatus(t.token, { chain: mindsChain, env: ON, now: NOW, usdPerEth: 2000, treasury: null }))!.treasury).toBeNull();
  });

  it("is sent with the token's live numbers: the line, and today's actions against the limit", async () => {
    const t = token({ name: "Page Line", symbol: "PGLN", actionsToday: 6 });
    thought(t.token, 30, "Fees came in. I bought back a little.");
    const r = await get(t.token);
    expect(r.status).toBe(200);
    expect(r.body.mind).toEqual({ state: "actions_used", text: "It has used all 6 of the actions it may take today, a limit locked at launch. It can act again after midnight UTC.", actionsToday: 6, actionsAllowed: 6 });
    expect(r.body.treasury).toBeTruthy();

    const waiting = token({ name: "Page Wait", symbol: "PGWT" });
    expect((await get(waiting.token)).body.mind).toMatchObject({ state: "waiting", actionsToday: 2, actionsAllowed: 6 });
  });

  it("still answers when the chain cannot be read, and not at all for a token that is not here", async () => {
    const dark = token({ name: "Page Dark", symbol: "PGDK", chain: null });
    const r = await get(dark.token);
    expect(r.body).toMatchObject({ treasury: null, mind: { state: "waiting", actionsToday: null, actionsAllowed: null } });
    expect((await get(addr())).status).toBe(404);
  });
});

describe("Mylo reading one token and its mind", () => {
  type TokenCard = Extract<Card, { kind: "token" }>;

  it("is a tool the policy knows and anyone signed in can use without paying", () => {
    for (const d of MINDS_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(toolGate("token_details", false)).toEqual({ ok: true, confirm: false });
    expect(myloToolDefs().map((t) => t.name)).toContain("token_details");
  });

  it("gives the numbers, what was locked at launch, the mind's journal and what it is waiting for", async () => {
    const t = token({ name: "Ledger Lantern", symbol: "LLAN", mcapEth: 12 });
    addEvent(t.token, "fees", { eth: 0.004, at: ago(120) });
    thought(t.token, 110, "Fees came in. A buyback now would be more than one action may spend.", { kind: "buyback", eth: 0.05 }, { verdict: "refused", why: "more than one action may spend" });
    addEvent(t.token, "fees", { eth: 0.006, at: ago(70) });
    thought(t.token, 60, "The treasury is well above what I need. I am using a fifth of it to buy back.", { kind: "buyback", eth: 0.004 }, { sent: "done", tx: `0x${"ab".repeat(32)}` });

    const out = await runTool("token_details", { token: "$llan" }, guest());
    expect(out.label).toBe("Reading the token and its mind");
    expect(out.result).toMatchObject({
      name: "Ledger Lantern", ticker: "$LLAN", market_cap_eth: 12, market_cap_usd: 24_000, holders: 42, page: `/launch?token=${t.token}`,
      description: "Ledger Lantern explains filings. Launched on Axon.",
      locked_at_launch: {
        tax_on_every_trade: "3%", fees_go: { to_the_creator: "30%", burn_the_token: "20%", burn_axon: "10%", to_the_mind: "40%" },
        mind_runs_on: "Claude Opus 5.5", mind_may: ["buy back and burn the token", "reward holders"],
        mind_limits: { most_spent_a_day_eth: 0.05, most_in_one_action_eth: 0.01, most_actions_a_day: 6, thinking_costs_at_most_a_day_eth: 0.01 },
      },
      mind_now: { status: "It is about to check in on its token on its own.", treasury_eth: 0.02, set_aside_for_holders_unclaimed_eth: 0.003, today: { actions_taken: 2, actions_allowed: 6, spent_eth: 0.004, may_spend_eth: 0.05 }, so_far: { thoughts: 2, bought_back_eth: 0.004 } },
    });
    // the reminders that keep a small model honest come last in what it reads
    const keys = Object.keys(out.result as object);
    expect(keys[keys.length - 1]).toBe("before_you_answer");
    expect((out.result as { before_you_answer: string }).before_you_answer).toMatch(/never what it was FOR/);
    const journal = (out.result as { journal: Record<string, unknown>[] }).journal;
    expect(journal.length).toBe(2);
    expect(journal[0]).toMatchObject({ thought: expect.stringMatching(/a fifth of it/), proposed: "buy back and burn the token with 0.004 ETH", rule_check: "allowed", outcome: "done on chain", transaction: expect.stringMatching(/\/tx\/0xabab/) });
    expect(journal[1]).toMatchObject({ proposed: "buy back and burn the token with 0.05 ETH", rule_check: "refused: more than one action may spend" });
    expect(journal[1].outcome).toBeUndefined();

    const card = out.card as TokenCard;
    expect(card).toMatchObject({ kind: "token", usdPerEth: 2000, token: { token: t.token, symbol: "LLAN", holders: 42 }, mind: { runsOn: "Claude Opus 5.5", treasuryEth: 0.02, actionsToday: 2, maxActionsPerDay: 6, thoughts: 2, lastThought: { text: expect.stringMatching(/a fifth of it/) } } });
    expect(card.mind.status).toBe((out.result as { mind_now: { status: string } }).mind_now.status);
    // everything the model is given fits in what one tool result may hold
    expect(JSON.stringify(out.result).length).toBeLessThan(TURN_BUDGET.toolResultChars);
  });

  it("finds it by address or name, asks which when several match, and says when none does", async () => {
    const a = token({ name: "Harbor Light", symbol: "HRBR" }), b = token({ name: "Harbor Bell", symbol: "BELL" });
    expect((await runTool("token_details", { token: a.token.toUpperCase().replace("0X", "0x") }, guest())).result).toMatchObject({ name: "Harbor Light" });
    expect((await runTool("token_details", { token: "harbor bell" }, guest())).result).toMatchObject({ ticker: "$BELL" });

    const both = await runTool("token_details", { token: "harbor" }, guest());
    expect((both.result as { which: { token: string }[] }).which.map((x) => x.token).sort()).toEqual([a.token, b.token].sort());
    expect(both.card).toBeUndefined();

    // two tokens may carry the same ticker: that is asked about too, never guessed
    const twin = token({ name: "Bell Tower", symbol: "BELL" });
    expect(((await runTool("token_details", { token: "BELL" }, guest())).result as { which: { token: string }[] }).which.map((x) => x.token).sort()).toEqual([b.token, twin.token].sort());

    expect((await runTool("token_details", { token: "nothing-like-this" }, guest())).result).toMatchObject({ error: expect.stringMatching(/No token on Axon matches/) });
    expect((await runTool("token_details", {}, guest())).result).toMatchObject({ error: expect.stringMatching(/Say which token/) });
  });

  it("answers without the chain, and not at all with Agent Minds off", async () => {
    const t = token({ name: "Night Chain", symbol: "NITE", chain: null });
    const out = await runTool("token_details", { token: "NITE" }, guest());
    expect(out.result).toMatchObject({ name: "Night Chain", locked_at_launch: { tax_on_every_trade: "3%", mind_may: null, mind_limits: null }, mind_now: { today: null, treasury_eth: 0.02 } });
    expect((out.card as TokenCard).mind).toMatchObject({ actionsToday: null, maxActionsPerDay: null });
    expect(t.token).toBeTruthy();

    vi.stubEnv("AGENT_MINDS", "off");
    expect((await runTool("token_details", { token: "NITE" }, guest())).result).toMatchObject({ error: expect.stringMatching(/aren't on here/) });
  });
});
