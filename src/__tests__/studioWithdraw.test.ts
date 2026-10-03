import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const wallet = { held: 10n ** 20n }; // what the paying wallet holds, in wei
vi.mock("@/lib/evm", async (orig) => ({
  ...(await orig<typeof import("@/lib/evm")>()),
  payoutWalletBalance: async () => wallet.held,
}));
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { getAvailableBalance, getAgentBalance } from "@/lib/payments";
import { withdraw, withdrawableWei, earningsOf, withdrawalsOf } from "@/lib/studioWithdraw";
import { WITHDRAW } from "@/lib/studioPolicy";

let n = 0;
const newWallet = () => `0x${(++n + 5_500_000).toString(16).padStart(40, "0")}`;

/** A Studio agent owned by `owner`, having earned `eth` from real hires. */
function studioAgent(owner: string, eth: number, studio = true): string {
  const id = `wd-agent-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Earner", capabilities: ["x"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, createdAt: new Date().toISOString() });
  if (studio) getDb().prepare("UPDATE agents SET studio_build = ?, studio_score = 9 WHERE agent_id = ?").run(`build-${id}`, id);
  if (eth > 0) getDb().prepare(`INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'buyer', ?, ?, 'completed', ?, 0, 'ETH', ?, ?)`)
    .run(randomUUID(), randomUUID(), id, eth, `0x${randomUUID().replace(/-/g, "")}`, new Date().toISOString(), new Date().toISOString());
  return id;
}
const sentTo: { to: string; amount: string }[] = [];
const okSend = async (to: string, amount: string | number, onSent?: (h: string) => void) => { sentTo.push({ to, amount: String(amount) }); const h = `0x${randomUUID().replace(/-/g, "")}`; onSent?.(h); return h; };

beforeEach(() => { sentTo.length = 0; wallet.held = 10n ** 20n; });
afterEach(() => { delete process.env.WITHDRAWALS; });

describe("taking earnings out", () => {
  it("sends what the agent earned to its owner, records it, and it can no longer be spent", async () => {
    const me = newWallet();
    const a = studioAgent(me, 0.01);
    const w = await withdraw(a, me, 0.004, okSend);
    expect(typeof w).toBe("object");
    expect((w as { status: string }).status).toBe("sent");
    expect((w as { txHash: string }).txHash).toMatch(/^0x/);
    expect(sentTo).toEqual([{ to: expect.stringMatching(new RegExp(me.slice(2), "i")), amount: "0.004" }]);
    expect(Number(withdrawableWei(a))).toBe(6e15);
    expect(getAvailableBalance(a)).toBeCloseTo(0.006, 9);
    expect(getAgentBalance(a)).toMatchObject({ totalWithdrawn: 0.004 });
    expect(earningsOf(me)[0]).toMatchObject({ earnedEth: 0.01, withdrawnEth: 0.004, availableEth: 0.006 });
    expect(withdrawalsOf(me)).toHaveLength(1);
  });

  it("only pays the owner, and only for agents built in Studio", async () => {
    const me = newWallet();
    const a = studioAgent(me, 0.01);
    expect(await withdraw(a, newWallet(), 0.004, okSend)).toMatch(/No such agent/);
    const old = studioAgent(me, 0.01, false);
    expect(await withdraw(old, me, 0.004, okSend)).toMatch(/built in Agent Studio/);
    expect(sentTo).toHaveLength(0);
  });

  it("keeps to the floor, to what was earned, and to the daily ceiling across a wallet's agents", async () => {
    const me = newWallet();
    const a = studioAgent(me, 5), b = studioAgent(me, 5);
    expect(await withdraw(a, me, WITHDRAW.minEth / 2, okSend)).toMatch(/least/);
    expect(await withdraw(a, me, 6, okSend)).toMatch(/more than/);
    expect(typeof (await withdraw(a, me, 1.5, okSend))).toBe("object");
    expect(await withdraw(b, me, 1, okSend)).toMatch(/a day/); // 1.5 + 1 is over the 2 ETH ceiling
    expect(typeof (await withdraw(b, me, 0.5, okSend))).toBe("object");
  });

  it("never pays the same ETH twice, even asked twice at once", async () => {
    const me = newWallet();
    const a = studioAgent(me, 0.01);
    const slow = async (to: string, amount: string | number, onSent?: (h: string) => void) => { await new Promise((r) => setTimeout(r, 30)); return okSend(to, amount, onSent); };
    const [x, y] = await Promise.all([withdraw(a, me, 0.008, slow), withdraw(a, me, 0.008, slow)]);
    expect([x, y].filter((r) => typeof r === "object")).toHaveLength(1);
    expect(sentTo).toHaveLength(1);
  });

  it("sends nothing when the paying wallet cannot cover it, and the earnings stay", async () => {
    const me = newWallet();
    const a = studioAgent(me, 0.01);
    wallet.held = 10n ** 15n; // 0.001 ETH
    expect(await withdraw(a, me, 0.005, okSend)).toMatch(/topped up/);
    expect(sentTo).toHaveLength(0);
    expect(Number(withdrawableWei(a))).toBe(1e16);
  });

  it("a send that fails before it leaves is undone; one that left but did not confirm stays taken out", async () => {
    const me = newWallet();
    const a = studioAgent(me, 0.01);
    expect(await withdraw(a, me, 0.004, async () => { throw new Error("nonce too low"); })).toMatch(/could not be sent/);
    expect(Number(withdrawableWei(a))).toBe(1e16);
    expect(await withdraw(a, me, 0.004, async (_t, _a, onSent) => { onSent?.("0xabc"); throw new Error("timeout"); })).toMatch(/confirming/);
    expect(Number(withdrawableWei(a))).toBe(6e15); // the pending one still counts
    expect(withdrawalsOf(me).map((w) => w.status)).toEqual(["pending", "failed"]);
  });

  it("stops entirely with WITHDRAWALS=off", async () => {
    const me = newWallet();
    const a = studioAgent(me, 0.01);
    process.env.WITHDRAWALS = "off";
    expect(await withdraw(a, me, 0.004, okSend)).toMatch(/paused/);
  });
});
