// Agents that sell what they make: what keeps the shop safe. Only what was built through Axon is sold, within price
// limits a deployment sets; a product can be reported through the reports that exist already; a seller cannot buy
// their own product to make it look sold.
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { addVersion, createSite, getSite, siteLimits } from "@/lib/agentSites";
import { availability, getProduct, listProduct, reportProduct } from "@/lib/agentShop";
import { buyProduct } from "@/lib/shopSales";
import { BUY_TOOL, setBuying, shopTools } from "@/lib/shopTool";
import { listReports } from "@/lib/abuse";
import { createTask } from "@/lib/tasks";
import { toWei } from "@/lib/money";
import { POST as reportRoute } from "@/app/api/shop/products/[productId]/report/route";

const RECEIVER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const saved = { shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES, max: process.env.AGENT_SHOP_MAX_ETH, min: process.env.AGENT_SHOP_MIN_ETH };
beforeEach(() => {
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM shop_sales; DELETE FROM shop_agents; DELETE FROM shop_products; DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM abuse_reports; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites], ["AGENT_SHOP_MAX_ETH", saved.max], ["AGENT_SHOP_MIN_ETH", saved.min]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const wallet = () => `0x${(++n + 7_800_000).toString(16).padStart(40, "0")}`;
function agentOf(owner: string, earnedEth = 0): string {
  const id = `safe-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Page Maker", capabilities: ["build"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, createdAt: new Date().toISOString() });
  if (earnedEth) getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'someone', ?, ?, 'completed', 0, 'ETH', ?, ?)").run(randomUUID(), randomUUID(), id, earnedEth, new Date().toISOString(), new Date().toISOString());
  return id;
}
function onSale(owner: string, agentId: string, price = "0.002"): { productId: string; siteId: string } {
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId, ownerMark: `w:${owner}`, title: "Tip Calculator" });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: "<h1>Tips</h1>" }], { taskId: "t" });
  const r = listProduct({ agentId, wallet: owner, siteId: m.site.siteId, description: "Splits a bill fairly.", price });
  if (!r.ok) throw new Error(r.why);
  return { productId: r.product.productId, siteId: m.site.siteId };
}
const pay = (eth: string, signer: string) => `mockpay:ETH:${toWei(eth)}:${signer}:${RECEIVER}:${randomUUID().slice(0, 8)}`;

describe("what can be sold", () => {
  it("is only what an agent built through Axon", () => {
    const me = wallet(), a = agentOf(me);
    expect(listProduct({ agentId: a, wallet: me, siteId: "not-a-page-on-axon", description: "Splits a bill fairly.", price: "0.002" })).toEqual({ ok: false, why: "This agent did not build that page." });
  });

  it("keeps to the price limits the deployment sets", () => {
    process.env.AGENT_SHOP_MAX_ETH = "0.01";
    process.env.AGENT_SHOP_MIN_ETH = "0.001";
    const me = wallet(), a = agentOf(me);
    const m = createSite({ taskId: "t", agentId: a, ownerMark: `w:${me}`, title: "Quiz" });
    if (!m.ok) throw new Error(m.why);
    addVersion(m.site.siteId, [{ path: "index.html", content: "<h1>Quiz</h1>" }], { taskId: "t" });
    const at = (price: string) => listProduct({ agentId: a, wallet: me, siteId: m.site.siteId, description: "A short quiz about birds.", price });
    expect(at("0.02")).toEqual({ ok: false, why: "The highest price is 0.01 ETH." });
    expect(at("0.0005")).toEqual({ ok: false, why: "The lowest price is 0.001 ETH." });
    expect(at("0.005").ok).toBe(true);
  });
});

describe("a seller buying their own product", () => {
  it("is refunded, and nothing counts as sold", async () => {
    const me = wallet(), a = agentOf(me), s = onSale(me, a);
    const r = await buyProduct({ productId: s.productId, paymentSignature: pay("0.002", me), payerWallet: me });
    expect(r).toMatchObject({ ok: false, status: 410, why: "A seller cannot buy their own product. The payment was refunded." });
    expect(getProduct(s.productId)!.sold).toBe(0);
  });

  it("through another of their agents, as material, is refused", async () => {
    const me = wallet(), seller = agentOf(me), buyer = agentOf(me, 0.05), s = onSale(me, seller);
    setBuying(buyer, me, { on: true, maxEth: "0.003" });
    const task = createTask({ fromAgent: wallet(), toAgent: buyer, task: "x", payment: "0.01 ETH" });
    expect(await shopTools({ agentId: buyer, taskId: task.taskId, payment: task.payment }).find((t) => t.name === BUY_TOOL)!.run({ product_id: s.productId })).toBe("Error: that is your own product.");
  });
});

describe("reporting a product", () => {
  it("counts against its page through the reports that exist, and enough people take it down", () => {
    const me = wallet(), a = agentOf(me), s = onSale(me, a);
    const hideAt = siteLimits().reportsToHide;
    for (let i = 0; i < hideAt; i++) {
      const r = reportProduct(s.productId, { reason: "scam", reporter: `ip:10.0.0.${i}` });
      expect(r.ok).toBe(true);
      expect(r.hidden).toBe(i === hideAt - 1);
    }
    expect(getSite(s.siteId)!.status).toBe("hidden");
    expect(availability(getProduct(s.productId)!).ok).toBe(false);
    // one person counts once
    const t = onSale(me, agentOf(me));
    for (let i = 0; i < hideAt + 2; i++) reportProduct(t.productId, { reason: "scam", reporter: "ip:10.0.0.9" });
    expect(getSite(t.siteId)!.status).toBe("live");
  });

  it("signed in, also reaches the moderators' queue against the agent, naming the product", () => {
    const me = wallet(), a = agentOf(me), s = onSale(me, a), reporter = wallet();
    expect(reportProduct(s.productId, { reason: "not_delivered", reporter: "ip:1.1.1.1" })).toMatchObject({ ok: false, why: expect.stringMatching(/^Sign in/) });
    expect(reportProduct(s.productId, { reason: "not_delivered", details: "paid, no files", reporter: `wallet:${reporter}`, wallet: reporter })).toMatchObject({ ok: true, filed: true, hidden: false });
    expect(listReports({ targetAgent: a })).toEqual([expect.objectContaining({ reason: "non_delivery", reporter, details: `Product ${s.productId} (Tip Calculator): paid, no files` })]);
    // a purchase that did not arrive says nothing about the page itself
    expect(getDb().prepare("SELECT COUNT(*) n FROM built_site_reports WHERE site_id = ?").get(s.siteId)).toEqual({ n: 0 });
  });

  it("at its route, anybody may, a few times an hour, for a reason from the list", async () => {
    const me = wallet(), a = agentOf(me), s = onSale(me, a);
    const post = (body: unknown, key?: string) => reportRoute(new NextRequest(`http://localhost/api/shop/products/${s.productId}/report`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ productId: s.productId }) });
    expect((await post({ reason: "boring" })).status).toBe(400);
    expect((await post({ reason: "harmful" })).status).toBe(200);
    expect((await post({ reason: "not_delivered" })).status).toBe(401);
    const { apiKey } = createApiKey(wallet(), {});
    expect(await (await post({ reason: "not_delivered" }, apiKey)).json()).toMatchObject({ ok: true, filed: true });
    for (let i = 0; i < 3; i++) await post({ reason: "harmful" });
    expect((await post({ reason: "harmful" })).status).toBe(429);
  });
});
