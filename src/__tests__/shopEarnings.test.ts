// Agents that sell what they make: the owner earns. A sale lands in the agent's earnings exactly as a paid job does,
// is taken out by the same withdrawal, and shows on the owner's earnings with what it was.
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const wallet = { held: 10n ** 20n };
vi.mock("@/lib/evm", async (orig) => ({ ...(await orig<typeof import("@/lib/evm")>()), payoutWalletBalance: async () => wallet.held }));
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { addVersion, createSite } from "@/lib/agentSites";
import { listProduct } from "@/lib/agentShop";
import { buyProduct, salesOfOwner } from "@/lib/shopSales";
import { earningsOf, withdraw, withdrawableWei } from "@/lib/studioWithdraw";
import { toWei } from "@/lib/money";
import { GET as earningsRoute } from "@/app/api/studio/earnings/route";

const RECEIVER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const saved = { shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES };
beforeEach(() => {
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM shop_sales; DELETE FROM shop_products; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const newWallet = () => `0x${(++n + 7_400_000).toString(16).padStart(40, "0")}`;
const pay = (eth: string, signer: string) => `mockpay:ETH:${toWei(eth)}:${signer}:${RECEIVER}:${randomUUID().slice(0, 8)}`;

/** A Studio agent owned by `owner`, with one page on sale at `price`. */
function studioSeller(owner: string, price: string): { agentId: string; productId: string } {
  const agentId = `earn-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId, name: "Shopkeeper", capabilities: ["build"], publicKey: `pk-${agentId}`, provider: "anthropic", reputation: 0, walletAddress: owner, createdAt: new Date().toISOString() });
  getDb().prepare("UPDATE agents SET studio_build = ?, studio_score = 9 WHERE agent_id = ?").run(`build-${agentId}`, agentId);
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId, ownerMark: `w:${owner}`, title: "Habit Tracker" });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: "<h1>Habits</h1>" }], { taskId: "t" });
  const r = listProduct({ agentId, wallet: owner, siteId: m.site.siteId, description: "Keeps a streak of days going.", price });
  if (!r.ok) throw new Error(r.why);
  return { agentId, productId: r.product.productId };
}

describe("what a sale earns", () => {
  it("is the agent's to take out, by the same withdrawal as a paid job", async () => {
    const me = newWallet(), s = studioSeller(me, "0.004");
    for (let i = 0; i < 2; i++) {
      const buyer = newWallet();
      expect((await buyProduct({ productId: s.productId, paymentSignature: pay("0.004", buyer), payerWallet: buyer })).ok).toBe(true);
    }
    expect(withdrawableWei(s.agentId)).toBe(8_000_000_000_000_000n);
    expect(earningsOf(me)).toEqual([expect.objectContaining({ agentId: s.agentId, earnedEth: 0.008, availableEth: 0.008 })]);
    const sent: string[] = [];
    const w = await withdraw(s.agentId, me, 0.005, async (to, amount, onSent) => { sent.push(String(amount)); onSent?.("0xfeed"); return "0xfeed"; });
    expect(w).toMatchObject({ status: "sent" });
    expect(sent).toEqual(["0.005"]);
    expect(withdrawableWei(s.agentId)).toBe(3_000_000_000_000_000n);
  });

  it("shows on the owner's earnings: per agent, and the latest sales", async () => {
    const me = newWallet(), s = studioSeller(me, "0.002"), buyer = newWallet();
    await buyProduct({ productId: s.productId, paymentSignature: pay("0.002", buyer), payerWallet: buyer });
    // a refunded sale earns nothing and is not counted
    await buyProduct({ productId: s.productId, paymentSignature: pay("0.002", buyer), payerWallet: buyer });
    expect(salesOfOwner(me)).toEqual({
      agents: [{ agentId: s.agentId, sold: 1, earnedEth: 0.002 }],
      recent: [expect.objectContaining({ agentId: s.agentId, title: "Habit Tracker", price: "0.002 ETH", buyer, buyerKind: "wallet" })],
    });
    expect(salesOfOwner(newWallet())).toEqual({ agents: [], recent: [] });

    const { apiKey } = createApiKey(me, {});
    const got = (await (await earningsRoute(new NextRequest("http://localhost/api/studio/earnings", { headers: { authorization: `Bearer ${apiKey}` } }))).json()) as { sales?: unknown; agents: unknown[] };
    expect(got.sales).toEqual(salesOfOwner(me));
    // with the shop off, the earnings read exactly as before
    process.env.AGENT_SHOP = "off";
    const before = (await (await earningsRoute(new NextRequest("http://localhost/api/studio/earnings", { headers: { authorization: `Bearer ${apiKey}` } }))).json()) as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual(["agents", "open", "proposals", "rules", "withdrawals"]);
  });
});
