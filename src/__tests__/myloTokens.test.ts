// Mylo meets the minds, phase 1: Mylo reads the board of tokens launched here, as the launch page shows it to anyone.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ethPrice", () => ({ ethUsd: async () => 2000 }));

import { getDb } from "@/lib/db";
import { runTool, myloToolDefs, MYLO_TOOL_DEFS, MINDS_TOOL_DEFS, type Card } from "@/lib/myloTools";
import { TOOLS, toolGate } from "@/lib/myloPolicy";
import { upsertToken } from "@/lib/mindsStore";
import { findTokens } from "@/lib/mindsStats";
import { startConversation } from "@/lib/myloStore";

let n = 0;
const addr = () => `0x${(++n + 7_700_000).toString(16).padStart(40, "0")}`;
const guest = () => ({ wallet: null, owner: "guest:tokens", conversationId: startConversation("guest:tokens", "t").id });

interface Seed { name: string; symbol: string; mcapEth?: number; burnedEth?: number; phase?: number; curveBps?: number; holders?: number; launchedAt?: string; attached?: boolean }
function token(s: Seed): string {
  const t = addr();
  upsertToken({
    token: t, creator: addr(), agentId: null, agentRef: `0x${"0".repeat(64)}`, pot: addr(), splitter: addr(), vault: addr(), payout: addr(),
    taxBps: 300, creatorBps: 4000, burnBps: 3000, axonBps: 1000, mindBps: 2000, attached: s.attached ?? false, name: s.name, symbol: s.symbol, logo: null, description: null,
    model: "claude-opus-5-5", mindUrl: null, blockNumber: 1000 + n, txHash: `0x${n.toString(16).padStart(64, "0")}`, launchedAt: s.launchedAt ?? new Date(Date.UTC(2026, 9, 6, 8, 0, n)).toISOString(),
  });
  getDb().prepare("INSERT INTO mind_stats (token, phase, price_eth, mcap_eth, curve_bps, holders, fees_eth, to_mind_eth, burned_tokens, burned_eth, burns, treasury_eth, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(t, s.phase ?? 0, (s.mcapEth ?? 2) / 1e9, s.mcapEth ?? 2, s.curveBps ?? 1250, s.holders ?? 12, 0.04, 0.008, 1_500_000, s.burnedEth ?? 0.01, 2, 0.006, new Date().toISOString());
  return t;
}
type TokensCard = Extract<Card, { kind: "tokens" }>;
const rows = (r: unknown) => (r as { tokens: Record<string, unknown>[] }).tokens;

beforeEach(() => { vi.stubEnv("AGENT_MINDS", "on"); });

describe("Mylo reading the board", () => {
  it("is a tool the policy knows, open to anyone, and only there with Agent Minds on", async () => {
    for (const d of MINDS_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(toolGate("token_board", false)).toEqual({ ok: true, confirm: false });
    expect(myloToolDefs().map((t) => t.name)).toContain("token_board");

    vi.stubEnv("AGENT_MINDS", "off");
    expect(myloToolDefs()).toBe(MYLO_TOOL_DEFS);
    expect(MYLO_TOOL_DEFS.map((t) => t.name as string)).not.toContain("token_board");
    const out = await runTool("token_board", {}, guest());
    expect(out.result).toMatchObject({ error: expect.stringMatching(/aren't on here/) });
    expect(out.card).toBeUndefined();
  });

  it("says so plainly when nothing has been launched", async () => {
    const out = await runTool("token_board", {}, guest());
    expect(out.result).toMatchObject({ tokens: [], tokens_on_axon: 0, note: expect.stringMatching(/No tokens have been launched/) });
    expect(out.card).toBeUndefined();
    expect(out.label).toBe("Looking at the tokens");
  });

  it("lists the newest, the biggest and the most burned, with the numbers the launch page shows", async () => {
    const small = token({ name: "Paper Lantern", symbol: "PLNT", mcapEth: 3, burnedEth: 0.5 });
    const big = token({ name: "Ledger Lens", symbol: "LENS", mcapEth: 40, burnedEth: 0.02, phase: 2, curveBps: 10_000, holders: 310 });
    const newest = token({ name: "Quiet Harbor", symbol: "QUIET", mcapEth: 1, burnedEth: 0 });

    const fresh = await runTool("token_board", {}, guest());
    expect(rows(fresh.result).map((t) => t.token)).toEqual([newest, big, small]);
    expect(fresh.result).toMatchObject({ tokens_on_axon: 3, order: "newest tokens" });

    const biggest = await runTool("token_board", { sort: "biggest", limit: 2 }, guest());
    expect(rows(biggest.result).map((t) => t.token)).toEqual([big, small]);
    expect(rows(biggest.result)[0]).toMatchObject({
      name: "Ledger Lens", ticker: "$LENS", page: `/launch?token=${big}`, market_cap_eth: 40, market_cap_usd: 80_000, holders: 310,
      stage: expect.stringMatching(/^graduated/), burned: { times: 2, bought_with_eth: 0.02 }, mind: { runs_on: "Claude Opus 5.5", treasury_eth: 0.006 },
    });
    expect(rows(biggest.result)[1]).toMatchObject({ stage: "on its curve, 12% of the way to graduating" });

    const burned = await runTool("token_board", { sort: "most_burned" }, guest());
    expect(rows(burned.result)[0].token).toBe(small);

    const card = biggest.card as TokensCard;
    expect(card).toMatchObject({ kind: "tokens", title: "Biggest tokens", usdPerEth: 2000 });
    expect(card.tokens[0]).toMatchObject({ token: big, symbol: "LENS", graduated: true, curvePercent: 100, holders: 310, page: `/launch?token=${big}` });
    // an order nobody offers is the newest, and never more than eight come back
    expect(rows((await runTool("token_board", { sort: "cheapest", limit: 500 }, guest())).result).length).toBeLessThanOrEqual(8);
  });

  it("finds a token by ticker, by part of its name and by its address", async () => {
    const lens = findTokens("lens")[0].token;
    const twin = token({ name: "Lensmaker Guild", symbol: "GUILD", mcapEth: 900 });

    // the exact ticker comes before a bigger token that only has the word in its name
    const byTicker = await runTool("token_board", { search: "$LeNs" }, guest());
    expect(rows(byTicker.result).map((t) => t.token)).toEqual([lens, twin]);
    expect((byTicker.card as TokensCard).title).toBe('Tokens matching "$LeNs"');

    expect(rows((await runTool("token_board", { search: "lantern" }, guest())).result).map((t) => t.name)).toEqual(["Paper Lantern"]);
    expect(rows((await runTool("token_board", { search: twin.toUpperCase().replace("0X", "0x") }, guest())).result).map((t) => t.token)).toEqual([twin]);

    // a wildcard is a character like any other, and a miss says so without a card
    expect(findTokens("%")).toEqual([]);
    const miss = await runTool("token_board", { search: "zzzz-nothing" }, guest());
    expect(miss.result).toMatchObject({ tokens: [], note: expect.stringMatching(/No token on Axon matches "zzzz-nothing"/) });
    expect(miss.card).toBeUndefined();
  });

  it("gives no holder count for a mind given to an earlier token, and says when a mind is stopped", async () => {
    const old = token({ name: "Old Anchor", symbol: "ANCH", attached: true });
    getDb().prepare("UPDATE mind_tokens SET stopped_at = ? WHERE token = ?").run(new Date().toISOString(), old);
    const out = await runTool("token_board", { search: "ANCH" }, guest());
    expect(rows(out.result)[0]).toMatchObject({ holders: null, mind: { stopped: true } });
    expect((out.card as TokensCard).tokens[0].holders).toBeNull();
  });
});
