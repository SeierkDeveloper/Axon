// Agent Minds, phase 7: minds that act. The signer here is written in the test and sends nothing anywhere: it records
// what it was asked to send. What is under test is everything that decides whether, what and how often it is asked.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { encodeEventTopics, encodeAbiParameters, parseEther, type Hex } from "viem";
import { getDb } from "@/lib/db";
import { VAULT_WRITE_ABI, type MindsChain, type MindLaunchEvent, type Snapshot, type Treasury, type VaultDay } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";
import { indexMinds } from "@/lib/mindsIndex";
import { refreshStats, events } from "@/lib/mindsStats";
import { thinkOnce, thoughts, owedThinkingEth, type Thought } from "@/lib/mindsMind";
import type { Thinker } from "@/lib/mindsThinker";
import { actDue, settleSent, payThinkingDue, keepUp, actingEnabled, sharesOf, STALE_MS, MIN_SHARE_WEI, MIN_THINKING_PAYMENT_ETH, MIN_SWEEP_ETH, minThinkingPaymentEth, minSweepEth, type MindSender } from "@/lib/mindsAct";
import { merkle, verify, divide, leafOf, type Share } from "@/lib/mindsMerkle";
import { unreadChain } from "./helpers/unreadChain";

let n = 0;
const addr = () => `0x${(++n + 9_990_000).toString(16).padStart(40, "0")}`;
const ENV = { AGENT_MINDS: "on", NEXT_PUBLIC_MIND_LAUNCHER: "0x00000000000000000000000000000000000a110c", MIND_DEPLOY_BLOCK: "1000", MINDS_THINKING: "live", MINDS_ACTING: "on", MIND_SIGNER_KEY: `0x${"7".repeat(64)}`, ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k" };
const USD = 2500;
const T0 = Date.UTC(2026, 9, 5, 12);
const E18 = 10n ** 18n;

const treasury = (over: Partial<Treasury> = {}, limits: Partial<Treasury["limits"]> = {}): Treasury => ({
  availableEth: 0.02, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true,
  limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 6, maxCostPerDayEth: 0.01, ...limits }, ...over,
});
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ phase: 0, curve: "0x00000000000000000000000000000000000c0de0", priceEth: 2e-9, supply: 1e9, curveBps: 1000, feesEth: 0.05, toMindEth: 0.01, burnedTokens: 0, burnedEth: 0, burns: 0, treasuryEth: 0.02, poolManager: null, ...over });

function world() {
  const state = { launches: [] as MindLaunchEvent[], treasury: treasury(), day: { spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 } as VaultDay, snap: snap() };
  const chain: MindsChain = {
    ...unreadChain,
    head: async () => 2000n, launches: async () => state.launches, blockTime: async () => new Date(T0 - 3_600_000).toISOString(), tokenMeta: async () => { throw new Error("none"); },
    treasury: async () => state.treasury, vaultDay: async () => state.day, feeFlow: async () => { throw new Error("unused"); }, snapshot: async () => state.snap, transfers: async () => [],
  };
  const launch = async (symbol: string) => {
    const me = addr();
    const p = prepare(me, { name: `${symbol} Token`, symbol, line: "Explains company filings in plain words" });
    if (typeof p === "string") throw new Error(p);
    const ev: MindLaunchEvent = { kind: "launched", token: addr(), creator: me, agentRef: p.ref, pot: addr(), splitter: addr(), vault: addr(), payout: me, taxBps: 300, creatorBps: 5000, burnBps: 2000, axonBps: 1000, mindBps: 2000, blockNumber: 1100 + n, txHash: `0x${String(n).padStart(64, "0")}` };
    state.launches.push(ev);
    getDb().exec("DELETE FROM mind_cursor");
    await indexMinds(chain, ENV);
    await refreshStats(chain, ENV);
    return ev;
  };
  const propose = async (token: string, action: unknown, at = T0, cost = 0.02) => {
    const k: Thinker = async () => ({ text: JSON.stringify({ thought: "The numbers give a reason to act, within my limits.", action }), inputTokens: 1000, outputTokens: 200, costUsd: cost });
    getDb().prepare("INSERT INTO mind_events (token, kind, eth, at) VALUES (?, 'fees', 0.01, ?)").run(token, new Date(at).toISOString());
    const r = await thinkOnce(token, { chain, thinker: k, env: { ...ENV, MINDS_DAILY_BUDGET_USD: "100000" }, now: at, usdPerEth: USD });
    if ("skipped" in r) throw new Error(`no thought: ${r.skipped}`);
    return r as Thought;
  };
  return { state, chain, launch, propose };
}

/** A signer that sends nothing: it writes down what it was asked, and answers the way the test sets it to. */
function signer(o: { simulate?: (fn: string, args: readonly unknown[], to: string) => unknown; send?: (fn: string) => string; receipt?: (hash: string) => { ok: boolean; logs: { address: string; topics: Hex[]; data: Hex }[] } | null } = {}) {
  const sims: { to: string; fn: string; args: readonly unknown[] }[] = [], sent: { to: string; fn: string; args: readonly unknown[]; hash: string }[] = [];
  const sender: MindSender = {
    address: () => "0x000000000000000000000000000000000051617e",
    simulate: async (to, _abi, fn, args) => { sims.push({ to, fn, args }); return o.simulate ? o.simulate(fn, args, to) : undefined; },
    send: async (to, _abi, fn, args) => { const hash = o.send ? o.send(fn) : `0x${(sent.length + 1).toString(16).padStart(64, "f")}`; sent.push({ to, fn, args, hash }); return hash; },
    wait: async (hash) => { const r = o.receipt ? o.receipt(hash) : { ok: true, logs: [] }; if (!r) throw new Error("no answer yet"); return r; },
  };
  return { sender, sims, sent };
}
const rewardLog = (vault: string, id: number, root: Hex, total: bigint) => ({
  address: vault, topics: encodeEventTopics({ abi: VAULT_WRITE_ABI, eventName: "RewardStarted", args: { id: BigInt(id) } }) as Hex[],
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [root, total, 1_800_000_000n, 1_802_592_000n]),
});
const status = (thoughtId: number) => getDb().prepare("SELECT status, error, tx_hash, kind, wei FROM mind_actions WHERE thought_id = ?").get(thoughtId) as { status: string; error: string | null; tx_hash: string | null; kind: string; wei: string } | undefined;

beforeEach(() => { getDb().exec("DELETE FROM mind_tokens; DELETE FROM mind_launches; DELETE FROM mind_cursor; DELETE FROM mind_stats; DELETE FROM mind_holders; DELETE FROM mind_events; DELETE FROM mind_thoughts; DELETE FROM mind_actions; DELETE FROM mind_rewards; DELETE FROM mind_reward_shares;"); });

describe("whether anything is sent at all", () => {
  it("needs the switch and the signer's key, both", async () => {
    expect(actingEnabled(ENV)).toBe(true);
    expect(actingEnabled({ ...ENV, MINDS_ACTING: "off" })).toBe(false);
    expect(actingEnabled({ ...ENV, MINDS_ACTING: undefined })).toBe(false);
    expect(actingEnabled({ ...ENV, MIND_SIGNER_KEY: "" })).toBe(false);
    expect(actingEnabled({ ...ENV, AGENT_MINDS: "off" })).toBe(false);
    const w = world(), t = await w.launch("LENS");
    await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    const s = signer();
    for (const env of [{ ...ENV, MINDS_ACTING: "off" }, { ...ENV, MIND_SIGNER_KEY: "" }]) {
      expect(await actDue({ chain: w.chain, sender: s.sender, env, now: T0 })).toBeNull();
      expect(await payThinkingDue({ chain: w.chain, sender: s.sender, env })).toBe(0);
      expect(await keepUp({ chain: w.chain, sender: s.sender, env })).toBeNull();
      expect(await settleSent({ sender: s.sender, env })).toBe(0);
    }
    expect(s.sims).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
  });
});

describe("sending what the rule check passed", () => {
  it("runs it against the chain first, writes it down, sends it once, and says so in public", async () => {
    const w = world(), t = await w.launch("LENS");
    const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    const s = signer();
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + 60_000 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    expect(s.sims).toEqual([{ to: t.vault, fn: "buyback", args: [parseEther("0.004")] }]);
    expect(s.sent).toMatchObject([{ to: t.vault, fn: "buyback", args: [parseEther("0.004")] }]);
    expect(status(h.id)).toMatchObject({ status: "done", kind: "buyback", wei: parseEther("0.004").toString(), tx_hash: s.sent[0].hash });
    expect(thoughts(t.token)[0].sent).toEqual({ status: "done", txHash: s.sent[0].hash, error: null });
    expect(events()[0]).toMatchObject({ kind: "bought", token: t.token, eth: 0.004 });
    // and never again for the same thought
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + 120_000 })).toEqual({ done: 0, failed: 0, dropped: 0 });
    expect(s.sent).toHaveLength(1);
  });

  it("sends a $AXON burn as the treasury's own call, with no destination of its own", async () => {
    const w = world(), t = await w.launch("LENS");
    await w.propose(t.token, { kind: "burn_axon", eth: 0.002 });
    const s = signer();
    await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 });
    expect(s.sent).toMatchObject([{ to: t.vault, fn: "burnAxon", args: [parseEther("0.002")] }]);
    expect(events()[0].kind).toBe("axon");
  });

  it("never sends a refused proposal, or a thought with no proposal", async () => {
    const w = world(), t = await w.launch("LENS");
    await w.propose(t.token, { kind: "buyback", eth: 9 });
    await w.propose(t.token, null, T0 + 11 * 60_000);
    const s = signer();
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + 12 * 60_000 })).toEqual({ done: 0, failed: 0, dropped: 0 });
    expect(s.sims).toHaveLength(0);
  });

  it("cuts an amount to the gwei so that a float's noise can never carry it past a limit", async () => {
    const w = world(), t = await w.launch("LENS");
    await w.propose(t.token, { kind: "buyback", eth: 0.0047630000000001 });
    const s = signer();
    await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 });
    expect(s.sent[0].args).toEqual([4_763_000_000_000_000n]);
  });
});

describe("the second look, right before sending", () => {
  it("drops a proposal that waited too long", async () => {
    const w = world(), t = await w.launch("LENS");
    const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    const s = signer();
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + STALE_MS + 1 })).toEqual({ done: 0, failed: 0, dropped: 1 });
    expect(status(h.id)).toMatchObject({ status: "dropped", error: expect.stringMatching(/waited too long/) });
    expect(s.sims).toHaveLength(0);
    expect(thoughts(t.token)[0].sent?.status).toBe("dropped");
  });

  it("drops it when the treasury has shrunk, the day's limits are used up, or the mind was stopped in between", async () => {
    for (const [change, why] of [
      [(w: ReturnType<typeof world>) => { w.state.treasury = treasury({ availableEth: 0.001 }); }, /cannot cover/],
      [(w: ReturnType<typeof world>) => { w.state.day = { spentTodayEth: 0.048, actionsToday: 2, costTodayEth: 0 }; }, /day's limit/],
      [(w: ReturnType<typeof world>) => { w.state.day = { spentTodayEth: 0, actionsToday: 6, costTodayEth: 0 }; }, /6 times today/],
      [(w: ReturnType<typeof world>) => { w.state.treasury = treasury({ active: false, paused: true }); }, /stopped/],
      [(w: ReturnType<typeof world>) => { w.state.snap = snap({ phase: 1 }); }, /no open market/],
    ] as const) {
      const w = world(), t = await w.launch("LENS");
      const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
      change(w);
      const s = signer();
      expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 0, failed: 0, dropped: 1 });
      expect(status(h.id)).toMatchObject({ status: "dropped", error: expect.stringMatching(why) });
      expect(s.sent).toHaveLength(0);
    }
  });

  it("does not send what the treasury itself would refuse", async () => {
    const w = world(), t = await w.launch("LENS");
    const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    const s = signer({ simulate: () => { throw new Error("execution reverted: NotSigner()"); } });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 0, failed: 0, dropped: 1 });
    expect(status(h.id)).toMatchObject({ status: "dropped", error: expect.stringMatching(/treasury would refuse it: execution reverted: NotSigner/) });
    expect(s.sent).toHaveLength(0);
  });
});

describe("when sending goes wrong", () => {
  it("marks a send that never left as failed and never tries that thought again", async () => {
    const w = world(), t = await w.launch("LENS");
    const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    const s = signer({ send: () => { throw new Error("insufficient funds for gas"); } });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 0, failed: 1, dropped: 0 });
    expect(status(h.id)).toMatchObject({ status: "failed", error: "insufficient funds for gas" });
    const ok = signer();
    expect(await actDue({ chain: w.chain, sender: ok.sender, env: ENV, now: T0 + 60_000 })).toEqual({ done: 0, failed: 0, dropped: 0 });
    expect(ok.sent).toHaveLength(0);
  });

  it("marks a transaction the chain reverted as failed, with nothing claimed in public", async () => {
    const w = world(), t = await w.launch("LENS");
    const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    const s = signer({ receipt: () => ({ ok: false, logs: [] }) });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 0, failed: 1, dropped: 0 });
    expect(status(h.id)?.status).toBe("failed");
    expect(events().some((e) => e.kind === "bought")).toBe(false);
  });

  it("leaves a transaction it has not heard back from as sent, holds the token's next action, and closes it later", async () => {
    const w = world(), t = await w.launch("LENS");
    const first = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    let landed = false;
    const s = signer({ receipt: () => (landed ? { ok: true, logs: [] } : null) });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 0, failed: 0, dropped: 0 });
    expect(status(first.id)?.status).toBe("sent");
    // a second proposal for the same token waits behind it
    const second = await w.propose(t.token, { kind: "burn_axon", eth: 0.001 }, T0 + 11 * 60_000);
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + 11 * 60_000 })).toEqual({ done: 0, failed: 0, dropped: 0 });
    expect(s.sent).toHaveLength(1);
    landed = true;
    expect(await settleSent({ sender: s.sender, env: ENV })).toBe(1);
    expect(status(first.id)?.status).toBe("done");
    expect(events().some((e) => e.kind === "bought")).toBe(true);
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + 12 * 60_000 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    expect(status(second.id)?.status).toBe("done");
  });

  it("closes an action that was written down and never sent, without sending it late", async () => {
    const w = world(), t = await w.launch("LENS");
    const h = await w.propose(t.token, { kind: "buyback", eth: 0.004 });
    getDb().prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(h.id, t.token, "buyback", "4000000000000000", 0.004, "pending", new Date(T0).toISOString(), new Date(T0).toISOString());
    const s = signer();
    await settleSent({ sender: s.sender, env: ENV, now: T0 + 11 * 60_000 });
    expect(status(h.id)).toMatchObject({ status: "failed", error: "It was never sent." });
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 + 12 * 60_000 })).toEqual({ done: 0, failed: 0, dropped: 0 });
    expect(s.sent).toHaveLength(0);
  });
});

describe("the proof behind a reward", () => {
  const share = (i: number, amount = BigInt(i + 1) * 1000n): Share => ({ index: i, account: `0x${(i + 1).toString(16).padStart(40, "a")}` as `0x${string}`, amount });

  it("gives every share a proof its root accepts, for any number of shares", () => {
    for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 31, 64, 100]) {
      const shares = Array.from({ length: size }, (_, i) => share(i));
      const { root, proofs } = merkle(shares);
      shares.forEach((s, i) => expect(verify(root, s, proofs[i])).toBe(true));
      // a proof is for one share: another amount, another account or another place does not pass
      expect(verify(root, { ...shares[0], amount: shares[0].amount + 1n }, proofs[0])).toBe(false);
      if (size > 1) expect(verify(root, shares[1], proofs[0])).toBe(false);
    }
    expect(merkle([share(0)])).toEqual({ root: leafOf(share(0)), proofs: [[]] });
    expect(() => merkle([])).toThrow();
  });

  it("divides a reward by what each holder holds, to the wei, leaving out shares not worth their gas", () => {
    const total = parseEther("0.003");
    const holders = [{ account: "0xA1", balance: 600n * E18 }, { account: "0xB2", balance: 300n * E18 }, { account: "0xC3", balance: 100n * E18 }, { account: "0xD4", balance: 0n }];
    const out = divide(total, holders, MIN_SHARE_WEI);
    expect(out.map((s) => s.account)).toEqual(["0xa1", "0xb2", "0xc3"]);
    expect(out.reduce((s, x) => s + x.amount, 0n)).toBe(total);
    expect(out[0].amount).toBe((total * 6n) / 10n);
    // a holder whose share would be dust is left out, and what was theirs goes to the others
    const withDust = divide(total, [...holders, { account: "0xE5", balance: 1n }], MIN_SHARE_WEI);
    expect(withDust.map((s) => s.account)).toEqual(["0xa1", "0xb2", "0xc3"]);
    expect(withDust.reduce((s, x) => s + x.amount, 0n)).toBe(total);
    // odd numbers still add up exactly
    const odd = divide(1_000_000_000_000_007n, [{ account: "0x1", balance: 3n }, { account: "0x2", balance: 3n }, { account: "0x3", balance: 1n }], 1n);
    expect(odd.reduce((s, x) => s + x.amount, 0n)).toBe(1_000_000_000_000_007n);
    expect(divide(total, [], MIN_SHARE_WEI)).toEqual([]);
    expect(divide(total, holders, total)).toEqual([]);
    expect(divide(total, Array.from({ length: 30 }, (_, i) => ({ account: `0x${i}`, balance: BigInt(100 - i) })), 1n, 10)).toHaveLength(10);
  });
});

describe("rewarding holders", () => {
  it("sets the ETH aside against a root, and keeps every holder's share and proof for them to claim", async () => {
    const w = world(), t = await w.launch("LENS");
    const [amy, ben, cal] = [addr(), addr(), addr()];
    const put = getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)");
    put.run(t.token, amy, (6_000_000n * E18).toString());
    put.run(t.token, ben, (3_000_000n * E18).toString());
    put.run(t.token, cal, (1_000_000n * E18).toString());
    // the curve, the pot, the treasury and the dead address hold tokens too: none of them is a holder
    put.run(t.token, "0x00000000000000000000000000000000000c0de0", (900_000_000n * E18).toString());
    put.run(t.token, t.pot, (5n * E18).toString());
    put.run(t.token, t.vault, (5n * E18).toString());
    put.run(t.token, "0x000000000000000000000000000000000000dead", (40_000_000n * E18).toString());
    await refreshStats(w.chain, ENV);
    const h = await w.propose(t.token, { kind: "reward", eth: 0.005 });
    expect(h.verdict).toBe("approved");

    let root: Hex = "0x";
    const s = signer({ receipt: () => ({ ok: true, logs: [rewardLog(t.vault, 0, root, parseEther("0.005"))] }) });
    const real = s.sender.send;
    s.sender.send = async (to, abi, fn, args) => { root = args[0] as Hex; return real(to, abi, fn, args); };
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 1, failed: 0, dropped: 0 });
    expect(s.sent).toMatchObject([{ to: t.vault, fn: "startReward", args: [root, parseEther("0.005")] }]);

    const mine = (a: string) => sharesOf(a, 1_800_000_100);
    const all = [amy, ben, cal].map((a) => mine(a)[0]);
    expect(all.map((x) => x.amountWei)).toEqual([parseEther("0.003").toString(), parseEther("0.0015").toString(), parseEther("0.0005").toString()]);
    expect(all.reduce((sum, x) => sum + BigInt(x.amountWei), 0n)).toBe(parseEther("0.005"));
    all.forEach((x, i) => expect(verify(root, { index: x.index, account: [amy, ben, cal][i] as `0x${string}`, amount: BigInt(x.amountWei) }, x.proof as Hex[])).toBe(true));
    expect(all[0]).toMatchObject({ token: t.token, vault: t.vault, rewardId: 0, startAt: 1_800_000_000, endAt: 1_802_592_000, symbol: "LENS" });
    expect(mine(t.pot)).toEqual([]);
    expect(mine("0x000000000000000000000000000000000000dead")).toEqual([]);
    // past the window nothing is offered
    expect(sharesOf(amy, 1_802_592_001)).toEqual([]);
    expect(events()[0]).toMatchObject({ kind: "rewarded", eth: 0.005, tokens: 3 });
  });

  it("is not sent when there is nobody worth rewarding", async () => {
    const w = world(), t = await w.launch("LENS");
    const put = getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)");
    put.run(t.token, addr(), (5n * E18).toString());
    put.run(t.token, addr(), "1");
    await refreshStats(w.chain, ENV);
    const h = await w.propose(t.token, { kind: "reward", eth: 0.0001 });
    const s = signer();
    expect(await actDue({ chain: w.chain, sender: s.sender, env: ENV, now: T0 })).toEqual({ done: 0, failed: 0, dropped: 1 });
    expect(status(h.id)?.error).toMatch(/not enough holders with a share worth claiming/);
    expect(s.sent).toHaveLength(0);
  });
});

describe("minds paying for their thinking", () => {
  it("pays Axon back from the treasury once enough is owed, and then owes that much less", async () => {
    const w = world(), t = await w.launch("LENS");
    await w.propose(t.token, null, T0, 0.4);           // 0.00016 ETH: not worth a transaction yet
    const s = signer();
    expect(await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV })).toBe(0);
    await w.propose(t.token, null, T0 + 11 * 60_000, 0.4); // now 0.00032 ETH is owed
    expect(owedThinkingEth(t.token)).toBeCloseTo(0.00032, 12);
    expect(await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV })).toBe(1);
    expect(s.sent).toMatchObject([{ to: t.vault, fn: "payThinking", args: [parseEther("0.00032")] }]);
    expect(owedThinkingEth(t.token)).toBeCloseTo(0, 12);
    expect(await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV })).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  it("never pays more than the treasury holds or than its thinking may cost in a day", async () => {
    const w = world(), t = await w.launch("LENS");
    await w.propose(t.token, null, T0, 5); // 0.002 ETH owed
    w.state.day = { spentTodayEth: 0, actionsToday: 0, costTodayEth: 0.0095 };
    const s = signer();
    await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV });
    expect(s.sent[0].args).toEqual([parseEther("0.0005")]); // the room left under 0.01 today
    getDb().exec("DELETE FROM mind_actions");
    w.state.day = { spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 };
    w.state.treasury = treasury({ availableEth: 0.0007 });
    await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV });
    expect(s.sent[1].args).toEqual([parseEther("0.0007")]);
    getDb().exec("DELETE FROM mind_actions");
    w.state.treasury = treasury({ frozen: true, active: false });
    expect(await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV })).toBe(0);
  });

  it("is never asked of a mind that thought for free", async () => {
    const w = world(), t = await w.launch("LENS");
    getDb().prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, cost_usd, cost_eth) VALUES (?,?,?,1,'thought','[]','stand-in',9,0.0036)").run(t.token, new Date(T0).toISOString(), "claude-opus-5-5");
    getDb().prepare("INSERT INTO mind_thoughts (token, at, model, standin, status, reasons, thought, cost_usd, cost_eth) VALUES (?,?,?,0,'thought','[]','own',0,0)").run(t.token, new Date(T0).toISOString(), "own");
    const s = signer();
    expect(await payThinkingDue({ chain: w.chain, sender: s.sender, env: ENV })).toBe(0);
    expect(s.sims).toHaveLength(0);
  });
});

describe("housekeeping", () => {
  it("moves fees when enough is waiting and burns when a pot is ready, and leaves the rest alone", async () => {
    const w = world();
    const a = await w.launch("AAA"), b = await w.launch("BBB");
    const s = signer({
      simulate: (fn, _args, to) => {
        if (fn === "sweep") return to === a.splitter ? parseEther("0.004") : parseEther("0.00001");
        if (fn === "preview") return to === b.pot ? [parseEther("0.002"), 0n, true] : [0n, 0n, false];
        return [0n, 0n];
      },
    });
    expect(await keepUp({ chain: w.chain, sender: s.sender, env: ENV })).toEqual({ swept: 1, burned: 1 });
    expect(s.sent.map((x) => [x.to, x.fn, x.args])).toEqual(expect.arrayContaining([[a.splitter, "sweep", []], [b.pot, "burn", [0n]]]));
    expect(s.sent).toHaveLength(2);
  });

  it("does not send a burn the market would refuse in that block", async () => {
    const w = world(), t = await w.launch("AAA");
    const s = signer({ simulate: (fn) => { if (fn === "sweep") return 0n; if (fn === "preview") return [1n, 0n, true]; throw new Error("MarketNotReady()"); } });
    expect(await keepUp({ chain: w.chain, sender: s.sender, env: ENV })).toEqual({ swept: 0, burned: 0 });
    expect(s.sent).toHaveLength(0);
    expect(t.pot).toBeTruthy();
  });
});

describe("what the signer can ever be asked to do", () => {
  it("is six calls, each to a contract of the token it is for, and none of them carries a destination", async () => {
    const w = world(), t = await w.launch("LENS");
    const put = getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?)");
    for (let i = 0; i < 4; i++) put.run(t.token, addr(), ((BigInt(i) + 1n) * 1_000_000n * E18).toString());
    await refreshStats(w.chain, ENV);
    const s = signer({ simulate: (fn) => (fn === "sweep" ? parseEther("0.01") : fn === "preview" ? [1n, 0n, true] : undefined), receipt: () => ({ ok: true, logs: [] }) });
    const opts = { chain: w.chain, sender: s.sender, env: ENV };
    await w.propose(t.token, { kind: "buyback", eth: 0.004 }, T0, 1);
    await actDue({ ...opts, now: T0 });
    await w.propose(t.token, { kind: "burn_axon", eth: 0.001 }, T0 + 11 * 60_000, 1);
    await actDue({ ...opts, now: T0 + 11 * 60_000 });
    await w.propose(t.token, { kind: "reward", eth: 0.002 }, T0 + 22 * 60_000, 1);
    await actDue({ ...opts, now: T0 + 22 * 60_000 });
    await payThinkingDue(opts);
    await keepUp(opts);
    const own = new Set([t.vault, t.pot, t.splitter]);
    expect(new Set(s.sent.map((x) => x.fn))).toEqual(new Set(["buyback", "burnAxon", "startReward", "payThinking", "sweep", "burn"]));
    for (const x of s.sent) {
      expect(own.has(x.to)).toBe(true);
      // no argument of any call is an address: where the ETH goes is fixed in the contracts
      for (const arg of x.args) expect(typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg)).toBe(false);
    }
  });
});

describe("the floors for paying thinking back and sweeping fees", () => {
  it("are fixed unless a service sets a lower one, and ignore anything that is not a positive number", () => {
    expect(minThinkingPaymentEth({})).toBe(MIN_THINKING_PAYMENT_ETH);
    expect(minSweepEth({})).toBe(MIN_SWEEP_ETH);
    expect(minThinkingPaymentEth({ MINDS_MIN_THINKING_PAYMENT_ETH: "0.000001" })).toBe(0.000001);
    expect(minSweepEth({ MINDS_MIN_SWEEP_ETH: "0.00002" })).toBe(0.00002);
    for (const bad of ["", "0", "-1", "abc"]) {
      expect(minThinkingPaymentEth({ MINDS_MIN_THINKING_PAYMENT_ETH: bad })).toBe(MIN_THINKING_PAYMENT_ETH);
      expect(minSweepEth({ MINDS_MIN_SWEEP_ETH: bad })).toBe(MIN_SWEEP_ETH);
    }
  });
});
