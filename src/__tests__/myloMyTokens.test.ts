// Mylo meets the minds, phase 3: the person's own tokens: what they launched, what they hold, what waits to be claimed.
import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({ claimed: new Set<string>(), paidToCreator: new Map<string, number>() }));
vi.mock("@/lib/ethPrice", () => ({ ethUsd: async () => 2000 }));
vi.mock("@/lib/evm", async (orig) => ({
  ...(await orig<typeof import("@/lib/evm")>()),
  publicClient: () => ({ readContract: async (q: { address: string; args: [bigint, bigint] }) => world.claimed.has(`${q.address.toLowerCase()}:${q.args[0]}:${q.args[1]}`) }),
}));
vi.mock("@/lib/mindsChain", async (orig) => {
  const real = await orig<typeof import("@/lib/mindsChain")>();
  return {
    ...real,
    mindsChain: {
      ...real.mindsChain,
      treasury: async () => ({ availableEth: 0.02, reservedEth: 0, boughtBackEth: 0, axonBurnedEth: 0, rewardedEth: 0, claimedEth: 0, thinkingEth: 0, rewards: 0, paused: false, frozen: false, active: true, limits: { allowed: 7, maxPerDayEth: 0.05, maxPerActionEth: 0.01, maxActionsPerDay: 24, maxCostPerDayEth: 0.01 } }),
      vaultDay: async () => ({ spentTodayEth: 0, actionsToday: 0, costTodayEth: 0 }),
      feeFlow: async (splitter: string | null) => { const v = splitter ? world.paidToCreator.get(splitter) : undefined; if (v === undefined) throw new Error("unreadable"); return { totalEth: v * 2, toCreatorEth: v, toBurnEth: 0, toAxonEth: 0, toMindEth: 0 }; },
    },
  };
});

import { getDb } from "@/lib/db";
import { runTool, myloToolDefs, MINDS_TOOL_DEFS, type Card } from "@/lib/myloTools";
import { TOOLS, toolGate } from "@/lib/myloPolicy";
import { upsertToken } from "@/lib/mindsStore";
import { holdingsOf } from "@/lib/mindsStats";
import { openSharesOf, sharesOf } from "@/lib/mindsAct";
import { startConversation } from "@/lib/myloStore";

let n = 0;
const addr = () => `0x${(++n + 6_600_000).toString(16).padStart(40, "0")}`;
const ctx = (w: string | null) => { const owner = w ?? "guest:mine"; return { wallet: w, owner, conversationId: startConversation(owner, "t").id }; };
const E18 = 10n ** 18n;

function token(creator: string, name: string, symbol: string, mcapEth = 4): { token: string; vault: string; splitter: string } {
  const t = addr(), vault = addr(), splitter = addr();
  upsertToken({
    token: t, creator, agentId: null, agentRef: `0x${"0".repeat(64)}`, pot: addr(), splitter, vault, payout: creator,
    taxBps: 300, creatorBps: 4000, burnBps: 3000, axonBps: 1000, mindBps: 2000, attached: false, name, symbol, logo: null, description: null,
    model: "claude-opus-5-5", mindUrl: null, blockNumber: 3000 + n, txHash: `0x${n.toString(16).padStart(64, "0")}`, launchedAt: new Date(Date.now() - 3_600_000 + n).toISOString(),
  });
  // a supply of a billion at this market cap
  getDb().prepare("INSERT INTO mind_stats (token, phase, price_eth, mcap_eth, curve_bps, holders, fees_eth, to_mind_eth, burned_tokens, burned_eth, burns, treasury_eth, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(t, 0, mcapEth / 1e9, mcapEth, 2000, 9, 0.05, 0.01, 0, 0, 0, 0.02, new Date().toISOString());
  return { token: t, vault, splitter };
}
const hold = (tok: string, wallet: string, tokens: bigint) => getDb().prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?) ON CONFLICT(token, address) DO UPDATE SET balance = excluded.balance").run(tok, wallet.toLowerCase(), (tokens * E18).toString());
function reward(tok: string, id: number, shares: [string, number][], endsInHours = 48) {
  const now = Math.floor(Date.now() / 1000), db = getDb();
  db.prepare("INSERT INTO mind_rewards (token, reward_id, root, total_wei, start_at, end_at, at_block, created_at) VALUES (?,?,?,?,?,?,?,?)").run(tok, id, `0x${"1".repeat(64)}`, "0", now - 60, now + endsInHours * 3600, 1, new Date().toISOString());
  shares.forEach(([account, eth], idx) => db.prepare("INSERT INTO mind_reward_shares (token, reward_id, idx, account, amount_wei, proof, claimed) VALUES (?,?,?,?,?,?,0)").run(tok, id, idx, account.toLowerCase(), BigInt(Math.round(eth * 1e18)).toString(), "[]"));
}
type MineCard = Extract<Card, { kind: "my_tokens" }>;

beforeEach(() => { vi.stubEnv("AGENT_MINDS", "on"); vi.stubEnv("MINDS_THINKING", "standin"); });

describe("Mylo and the person's own tokens", () => {
  it("is a tool the policy knows, and only for a wallet that is signed in", async () => {
    for (const d of MINDS_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(myloToolDefs().map((t) => t.name)).toContain("my_tokens");
    expect(toolGate("my_tokens", false)).toMatchObject({ ok: false });
    expect((await runTool("my_tokens", {}, ctx(null))).result).toMatchObject({ error: expect.stringMatching(/Sign in/) });
  });

  it("says so when the wallet has nothing here yet", async () => {
    const out = await runTool("my_tokens", {}, ctx(addr()));
    expect(out.result).toMatchObject({ launched_by_you: [], you_hold: [], rewards_to_claim: [], rewards_to_claim_total_eth: 0, note: expect.stringMatching(/launched no token here/) });
    expect(out.card).toBeUndefined();
    expect(out.label).toBe("Looking at your tokens");
  });

  it("gathers what they launched, what they hold and what waits to be claimed", async () => {
    const me = addr(), other = addr();
    const mine = token(me, "Ledger Lens", "LENS", 10), theirs = token(other, "Paper Lantern", "PLNT", 4), unrelated = token(other, "Far Shore", "FAR");
    world.paidToCreator.set(mine.splitter, 0.0123);
    hold(mine.token, me, 50_000_000n);       // 5% of a billion
    hold(theirs.token, me, 2_000_000n);      // 0.2%
    hold(unrelated.token, other, 9_000_000n);
    reward(theirs.token, 1, [[me, 0.0004], [other, 0.001]]);
    reward(mine.token, 1, [[me, 0.0006]]);
    reward(mine.token, 2, [[me, 0.002]]);
    world.claimed.add(`${mine.vault}:2:0`);  // already claimed on chain, not yet noted here

    const out = await runTool("my_tokens", {}, ctx(me.toUpperCase().replace("0X", "0x")));
    const r = out.result as { launched_by_you: Record<string, unknown>[]; you_hold: Record<string, unknown>[]; rewards_to_claim: Record<string, unknown>[]; rewards_to_claim_total_eth: number; note: string };
    expect(r.launched_by_you).toHaveLength(1);
    expect(r.launched_by_you[0]).toMatchObject({
      name: "Ledger Lens", ticker: "$LENS", market_cap_usd: 20_000, fees_paid_to_you_eth: 0.0123,
      mind_status: expect.stringMatching(/^It has not thought yet/), you_hold: { tokens: 50_000_000, of_the_supply: "5%" },
    });
    // their own token is not listed a second time under what they hold
    expect(r.you_hold).toEqual([expect.objectContaining({ token: theirs.token, ticker: "$PLNT", tokens: 2_000_000, of_the_supply: "0.2%", page: `/launch?token=${theirs.token}` })]);
    expect(r.rewards_to_claim.map((x) => [x.ticker, x.amount_eth, x.can_claim])).toEqual(expect.arrayContaining([["$PLNT", 0.0004, "now"], ["$LENS", 0.0006, "now"]]));
    expect(r.rewards_to_claim).toHaveLength(2);
    expect(r.rewards_to_claim_total_eth).toBe(0.001);
    expect(r.note).toMatch(/claimed by them, from their own wallet/);
    // the share the chain says is claimed is noted, so it is never offered again
    expect(sharesOf(me).map((s) => `${s.token}:${s.rewardId}`).sort()).toEqual([`${mine.token}:1`, `${theirs.token}:1`].sort());

    const card = out.card as MineCard;
    expect(card).toMatchObject({ kind: "my_tokens", usdPerEth: 2000, claimEth: 0.001 });
    expect(card.launched).toEqual([{ token: expect.objectContaining({ token: mine.token, symbol: "LENS" }), line: expect.stringMatching(/^It has not thought yet/) }]);
    expect(card.holding).toEqual([{ token: expect.objectContaining({ token: theirs.token }), line: "You hold 2,000,000 (0.2% of the supply)" }]);
    expect(card.rewards.map((x) => x.page)).toEqual(expect.arrayContaining([`/launch?token=${theirs.token}`, `/launch?token=${mine.token}`]));
  });

  it("still answers when a token's fees cannot be read from the chain", async () => {
    const me = addr();
    token(me, "Dark Fees", "DRKF");
    const out = await runTool("my_tokens", {}, ctx(me));
    expect((out.result as { launched_by_you: Record<string, unknown>[] }).launched_by_you[0]).toMatchObject({ ticker: "$DRKF", fees_paid_to_you_eth: null, you_hold: null });
  });

  it("counts a holding in whole tokens, leaves out empty ones, and puts the biggest share first", () => {
    const me = addr(), other = addr();
    const a = token(other, "Alpha Dock", "ADOCK"), b = token(other, "Beta Dock", "BDOCK"), c = token(other, "Gone Dock", "GDOCK");
    hold(a.token, me, 1_000_000n); hold(b.token, me, 30_000_000n); hold(c.token, me, 0n);
    const h = holdingsOf(me);
    expect(h.map((x) => [x.token.symbol, x.tokens, +x.percentOfSupply!.toFixed(2)])).toEqual([["BDOCK", 30_000_000, 3], ["ADOCK", 1_000_000, 0.1]]);
    expect(holdingsOf(addr())).toEqual([]);
  });

  it("leaves out a reward whose window has closed, and asks the chain only about what is left", async () => {
    const me = addr(), t = token(addr(), "Late Tide", "LATE");
    reward(t.token, 7, [[me, 0.01]], -1);
    expect(await openSharesOf(me)).toEqual([]);
    reward(t.token, 8, [[me, 0.02]]);
    const asked: string[] = [];
    const open = await openSharesOf(me, async (vault, id, index) => { asked.push(`${id}:${index}`); return false; });
    expect(open.map((s) => s.rewardId)).toEqual([8]);
    expect(asked).toEqual(["8:0"]);
    expect(t.vault).toBeTruthy();
  });
});
