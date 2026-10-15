// Agents that sell what they make, everywhere: Mylo's tools and the MCP server's. Mylo never pays, and lists a page
// only for its owner; an assistant over MCP is told how much to send and where, then buys with the payment's hash.
// No model is asked anything, and payments are the test lane's stand-ins.
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { addVersion, createSite } from "@/lib/agentSites";
import { getProduct, listProduct } from "@/lib/agentShop";
import { buyProduct } from "@/lib/shopSales";
import { myloToolDefs, runTool } from "@/lib/myloTools";
import { TOOLS } from "@/lib/myloPolicy";
import { myloShopNote } from "@/lib/myloShop";
import { startConversation } from "@/lib/myloStore";
import { mcpTools } from "@/lib/mcpServer";
import { POST as mcpPOST } from "@/app/mcp/route";
import { toWei } from "@/lib/money";

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
const wallet = () => `0x${(++n + 7_700_000).toString(16).padStart(40, "0")}`;
const ctx = (w: string | null) => { const owner = w ?? "guest:x"; return { wallet: w, owner, conversationId: startConversation(owner, "t").id }; };
const SHOP_TOOLS = ["my_products", "list_product", "buy_product", "my_purchases"];

function seller(): { me: string; agentId: string; siteId: string } {
  const me = wallet(), agentId = `every-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId, name: "Page Maker", capabilities: ["build"], publicKey: `pk-${agentId}`, provider: "anthropic", reputation: 0, walletAddress: me, createdAt: new Date().toISOString() });
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId, ownerMark: `w:${me}`, title: "Tip Calculator" });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: "<h1>Tips</h1>" }], { taskId: "t" });
  return { me, agentId, siteId: m.site.siteId };
}

describe("Mylo", () => {
  it("has the shop's tools only while the shop is on, each known to its policy", () => {
    expect(myloToolDefs().map((t) => t.name)).toEqual(expect.arrayContaining(SHOP_TOOLS));
    for (const name of SHOP_TOOLS) expect(TOOLS[name]).toBeTruthy();
    expect(TOOLS.buy_product).toMatchObject({ spends: false });
    expect(myloShopNote()).toMatch(/You never pay and never say something was\s+bought/);
    expect(myloShopNote()).not.toMatch(/[—–]/);
    process.env.AGENT_SHOP = "off";
    expect(myloToolDefs().map((t) => t.name)).not.toEqual(expect.arrayContaining(["my_products"]));
    expect(myloShopNote()).toBe("");
  });

  it("lists the person's own page at their price, and reads their shop back", async () => {
    const s = seller();
    const shop = await runTool("my_products", {}, ctx(s.me));
    expect(shop.result).toMatchObject({ agents: [expect.objectContaining({ agent_id: s.agentId, could_go_up_for_sale: [{ site_id: s.siteId, title: "Tip Calculator" }] })] });
    // somebody else cannot list it
    expect((await runTool("list_product", { agent_id: s.agentId, site_id: s.siteId, description: "Splits a bill fairly.", price_eth: "0.002" }, ctx(wallet()))).result).toEqual({ error: "Only the agent's owner can sell what it made." });
    const listed = await runTool("list_product", { agent_id: s.agentId, site_id: s.siteId, description: "Splits a bill fairly.", price_eth: "0.002" }, ctx(s.me));
    expect(listed.result).toMatchObject({ listed: { title: "Tip Calculator", price: "0.002 ETH", page: expect.stringMatching(new RegExp(`^/agents/${s.agentId}#product-prod_`)) } });
    // a person without a wallet is asked to sign in
    expect((await runTool("my_products", {}, ctx(null))).result).toMatchObject({ error: expect.stringMatching(/Sign in/) });
  });

  it("finds a product to buy and points to where the person buys it, and lists what they bought", async () => {
    const s = seller();
    const p = listProduct({ agentId: s.agentId, wallet: s.me, siteId: s.siteId, description: "Splits a bill fairly.", price: "0.002" });
    if (!p.ok) throw new Error(p.why);
    const found = await runTool("buy_product", { query: "bill" }, ctx(null));
    expect(found.result).toMatchObject({ products: [expect.objectContaining({ product_id: p.product.productId, price: "0.002 ETH", buy_it_here: `/agents/${s.agentId}#product-${p.product.productId}` })] });
    // Mylo never buys: nothing was sold
    expect(getProduct(p.product.productId)!.sold).toBe(0);
    const buyer = wallet();
    await buyProduct({ productId: p.product.productId, paymentSignature: `mockpay:ETH:${toWei("0.002")}:${buyer}:${RECEIVER}:x1`, payerWallet: buyer });
    const mine = await runTool("my_purchases", {}, ctx(buyer));
    expect(mine.result).toMatchObject({ purchases: [expect.objectContaining({ title: "Tip Calculator", price: "0.002 ETH", status: "delivered", receipt: expect.stringMatching(/^\/r\/sale_/) })] });
  });
});

describe("MCP", () => {
  async function call(name: string, args: Record<string, unknown>, key?: string) {
    const req = new NextRequest("https://axon-agents.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const json = (await (await mcpPOST(req)).json()) as { result: { content: { text: string }[] } };
    return JSON.parse(json.result.content[0].text) as Record<string, unknown>;
  }

  it("lists the shop's tools only while the shop is on", () => {
    expect(mcpTools().map((t) => t.name)).toEqual(expect.arrayContaining(["shop_search", "buy_product", "get_purchase", "my_shop", "list_product"]));
    process.env.AGENT_SHOP = "off";
    expect(mcpTools().map((t) => t.name)).not.toContain("shop_search");
  });

  it("lists for the owner's key, says how to pay, then buys with the payment's hash", async () => {
    const s = seller();
    const { apiKey } = createApiKey(s.me, {});
    const mine = await call("my_shop", { agentId: s.agentId }, apiKey);
    expect((mine.pages as { siteId: string }[]).map((p) => p.siteId)).toEqual([s.siteId]);
    expect(await call("list_product", { agentId: s.agentId, siteId: s.siteId, description: "Splits a bill fairly.", price: "0.002" })).toMatchObject({ error: expect.stringMatching(/needs an Axon key/) });
    const listed = await call("list_product", { agentId: s.agentId, siteId: s.siteId, description: "Splits a bill fairly.", price: "0.002" }, apiKey);
    const productId = (listed.product as { productId: string }).productId;
    expect(await call("shop_search", { query: "tip" })).toMatchObject({ products: [expect.objectContaining({ productId })] });

    const terms = await call("buy_product", { productId });
    expect(terms).toMatchObject({ payment: { payTo: RECEIVER, amountWei: "2000000000000000", chainId: 4663 }, note: expect.stringMatching(/^Send exactly this amount/) });
    const buyer = wallet();
    const bought = await call("buy_product", { productId, paymentSignature: `mockpay:ETH:${toWei("0.002")}:${buyer}:${RECEIVER}:m1`, payerWallet: buyer });
    expect(bought).toMatchObject({ saleId: expect.stringMatching(/^sale_/), claimToken: expect.any(String), files: expect.stringMatching(/\/zip$/) });
    const again = await call("get_purchase", { saleId: bought.saleId, claimToken: bought.claimToken });
    expect(again).toMatchObject({ receipt: { status: "delivered" }, files: expect.any(String) });
    expect(await call("get_purchase", { saleId: bought.saleId })).not.toHaveProperty("files");
  });
});
