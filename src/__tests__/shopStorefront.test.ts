// Agents that sell what they make: the shop as anybody sees it. Each agent's products, and what is for sale across
// every agent, newest, best selling or cheapest first, and found by its words.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { addVersion, createSite, hideSite } from "@/lib/agentSites";
import { listProduct, productsForSale, productsOfAgent, takeDown } from "@/lib/agentShop";
import { GET as forSaleRoute } from "@/app/api/shop/products/route";

const saved = { shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES };
beforeEach(() => {
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM shop_products; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const wallet = () => `0x${(++n + 7_200_000).toString(16).padStart(40, "0")}`;
function seller(): { me: string; agentId: string } {
  const me = wallet(), agentId = `front-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId, name: `Maker ${n}`, capabilities: ["build"], publicKey: `pk-${agentId}`, provider: "anthropic", reputation: 0, walletAddress: me, createdAt: new Date().toISOString() });
  return { me, agentId };
}
function sell(s: { me: string; agentId: string }, title: string, price: string, description = "A small tool that does one job well."): { productId: string; siteId: string } {
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId: s.agentId, ownerMark: `w:${s.me}`, title });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: `<h1>${title}</h1>` }], { taskId: "t" });
  const r = listProduct({ agentId: s.agentId, wallet: s.me, siteId: m.site.siteId, description, price });
  if (!r.ok) throw new Error(r.why);
  return { productId: r.product.productId, siteId: m.site.siteId };
}

describe("what is for sale", () => {
  it("lists every agent's products on sale, and leaves out what was taken down", () => {
    const a = seller(), b = seller();
    const one = sell(a, "Tip calculator", "0.01");
    const two = sell(b, "Habit tracker", "0.002");
    const three = sell(b, "Quiz maker", "0.1");
    expect(productsForSale().map((p) => p.productId).sort()).toEqual([one.productId, two.productId, three.productId].sort());
    takeDown(two.productId, b.me);
    hideSite(three.siteId, "reported");
    expect(productsForSale().map((p) => p.productId)).toEqual([one.productId]);
    expect(productsOfAgent(b.agentId)).toEqual([]);
    expect(productsForSale({ agentId: a.agentId }).map((p) => p.productId)).toEqual([one.productId]);
  });

  it("puts the cheapest first by the amount, not by how the number is written", () => {
    const a = seller();
    sell(a, "Ten", "0.1");
    sell(a, "Two", "0.02");
    sell(a, "Nine", "0.009");
    sell(a, "One", "1");
    expect(productsForSale({ sort: "price" }).map((p) => p.title)).toEqual(["Nine", "Two", "Ten", "One"]);
  });

  it("puts the best selling first, and finds a product by its words", () => {
    const a = seller();
    const tips = sell(a, "Tip calculator", "0.01", "Splits a bill between friends.");
    sell(a, "Habit tracker", "0.01", "Keeps a streak of days going.");
    getDb().prepare("UPDATE shop_products SET sold = 5 WHERE product_id = ?").run(tips.productId);
    expect(productsForSale({ sort: "sold" })[0].productId).toBe(tips.productId);
    expect(productsForSale({ q: "STREAK" }).map((p) => p.title)).toEqual(["Habit tracker"]);
    expect(productsForSale({ q: "100%_" })).toEqual([]);
  });

  it("is public at its route, and not there while the shop is off", async () => {
    const a = seller();
    sell(a, "Tip calculator", "0.01");
    const res = await forSaleRoute(new NextRequest("http://localhost/api/shop/products?sort=price&q=tip"));
    const got = (await res.json()) as { products: { title: string; price: string; agentName: string; available: boolean }[] };
    expect(got.products).toEqual([expect.objectContaining({ title: "Tip calculator", price: "0.01 ETH", agentName: expect.stringMatching(/^Maker /), available: true })]);
    process.env.AGENT_SHOP = "off";
    expect((await forSaleRoute(new NextRequest("http://localhost/api/shop/products"))).status).toBe(404);
  });
});
