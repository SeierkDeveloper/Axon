// Agents that sell what they make: an owner puts up for sale a page their agent built for them, sets its price, changes
// it and takes it down. Only their own pages, only within the price limits, and only what passes the build rules.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { addVersion, createSite, hideSite, type SiteFileIn } from "@/lib/agentSites";
import { availability, changeProduct, getProduct, listablePages, listProduct, markIsWallet, productView, productsOfAgent, readPrice, sellable, takeDown } from "@/lib/agentShop";
import { formatEth } from "@/lib/money";
import { POST as listRoute } from "@/app/api/shop/products/route";
import { PATCH as changeRoute, DELETE as downRoute, GET as oneRoute } from "@/app/api/shop/products/[productId]/route";
import { GET as ownerRoute } from "@/app/api/shop/agents/[agentId]/route";

const saved = { shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES };
beforeEach(() => {
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM shop_products; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const wallet = () => `0x${(++n + 7_100_000).toString(16).padStart(40, "0")}`;
const HTML = "<!doctype html><html><head><title>Tips</title></head><body><h1>Tip calculator</h1><script>const tip = (b, p) => b * p / 100;</script></body></html>";

function agentOf(owner: string): string {
  const id = `shop-agent-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Page Maker", capabilities: ["build"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, createdAt: new Date().toISOString() });
  return id;
}
function pageFor(agentId: string, mark: string | null, files: SiteFileIn[] = [{ path: "index.html", content: HTML }], title = "Tip Calculator"): string {
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId, ownerMark: mark, title });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, files, { taskId: `t-${randomUUID()}` });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}
const body = (o: Record<string, unknown>) => ({ description: "Works out the tip and splits the bill.", price: "0.01", ...o });

describe("a price", () => {
  it("is read into wei from its words, inside the floor and the ceiling", () => {
    expect(readPrice("0.01")).toEqual({ ok: true, wei: 10_000_000_000_000_000n });
    expect(readPrice("0.01 ETH")).toEqual({ ok: true, wei: 10_000_000_000_000_000n });
    expect(readPrice(0.1)).toEqual({ ok: true, wei: 100_000_000_000_000_000n });
    for (const bad of ["", "abc", "-1", "0", "1e-3", "0x10", null, undefined, {}]) expect(readPrice(bad).ok).toBe(false);
    expect(readPrice("0.00001")).toEqual({ ok: false, why: "The lowest price is 0.0001 ETH." });
    expect(readPrice("2")).toEqual({ ok: false, why: "The highest price is 1 ETH." });
    // more precision than the chain has is refused, never rounded
    expect(readPrice("0.0100000000000000001").ok).toBe(false);
  });
});

describe("what may be sold", () => {
  it("is a page the agent built for its owner, never one it built for somebody else", () => {
    const me = wallet(), a = agentOf(me);
    expect(markIsWallet(`w:${me}`, me.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(markIsWallet(me, me)).toBe(true);
    expect(markIsWallet("v:abc", me)).toBe(false);
    const mine = pageFor(a, `w:${me}`);
    const theirs = pageFor(a, `w:${wallet()}`);
    const browserKey = pageFor(a, "v:0123");
    expect(sellable({ siteId: mine, agentId: a, wallet: me })).toMatchObject({ ok: true, version: 1, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(sellable({ siteId: theirs, agentId: a, wallet: me })).toEqual({ ok: false, why: "Only a page the agent built for you can be sold. A page it built for somebody else is theirs." });
    expect(sellable({ siteId: browserKey, agentId: a, wallet: me }).ok).toBe(false);
    // and a page another agent built is not this agent's to sell
    expect(sellable({ siteId: pageFor(agentOf(me), `w:${me}`), agentId: a, wallet: me })).toEqual({ ok: false, why: "This agent did not build that page." });
    expect(listablePages(a, me).map((p) => p.siteId)).toEqual([mine]);
  });

  it("must pass the build rules on the day it is listed, and must still be up", () => {
    const me = wallet(), a = agentOf(me);
    const id = pageFor(a, `w:${me}`);
    // a page that slipped past the rules of its day (written straight into the store) is caught here
    getDb().prepare("UPDATE built_site_files SET content = ? WHERE site_id = ?").run(Buffer.from('<form><input type="password"></form>'), id);
    const r = sellable({ siteId: id, agentId: a, wallet: me });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/^That page breaks a rule for built pages: index\.html: it asks for a password/);
    const other = pageFor(a, `w:${me}`);
    hideSite(other, "reported");
    expect(sellable({ siteId: other, agentId: a, wallet: me })).toEqual({ ok: false, why: "That page was taken down, so it cannot be sold." });
  });
});

describe("listing, changing and taking down", () => {
  it("puts the version shown now on sale, by its fingerprint, for the owner only", () => {
    const me = wallet(), a = agentOf(me), id = pageFor(a, `w:${me}`);
    expect(listProduct({ agentId: a, wallet: wallet(), siteId: id, ...body({}) })).toEqual({ ok: false, why: "Only the agent's owner can sell what it made." });
    const r = listProduct({ agentId: a, wallet: me, siteId: id, ...body({}) });
    expect(r.ok).toBe(true);
    const p = r.ok ? r.product : null!;
    expect(p).toMatchObject({ agentId: a, siteId: id, version: 1, title: "Tip Calculator", priceWei: 10_000_000_000_000_000n, status: "listed", madeBy: "owner", sold: 0 });
    expect(p.sellerWallet).toBe(me.toLowerCase());
    // a later change to the page does not change what is sold
    addVersion(id, [{ path: "index.html", content: HTML.replace("Tip", "Bill") }], { taskId: "later" });
    expect(getProduct(p.productId)!.version).toBe(1);
    expect(productView(getProduct(p.productId)!, "https://axon-agents.com")).toMatchObject({ price: "0.01 ETH", priceWei: "10000000000000000", preview: `https://axon-agents.com/s/${id}?v=1`, available: true, madeByAgent: false, fingerprint: p.sha256 });
    // once on sale, it is not offered again, and cannot be listed twice
    expect(listablePages(a, me)).toEqual([]);
    expect(listProduct({ agentId: a, wallet: me, siteId: id, ...body({}) })).toEqual({ ok: false, why: "That page is on sale already." });
  });

  it("asks for a title and a sentence, checked like an agent's own words, and holds the price limits", () => {
    const me = wallet(), a = agentOf(me), id = pageFor(a, `w:${me}`);
    expect(listProduct({ agentId: a, wallet: me, siteId: id, ...body({ description: "" }) })).toEqual({ ok: false, why: "Say in a sentence what it is." });
    expect(listProduct({ agentId: a, wallet: me, siteId: id, ...body({ description: "This is the official Axon calculator for tips." }) }).ok).toBe(false);
    expect(listProduct({ agentId: a, wallet: me, siteId: id, ...body({ price: "5" }) })).toEqual({ ok: false, why: "The highest price is 1 ETH." });
  });

  it("keeps to the number of products an agent may have on sale", () => {
    const me = wallet(), a = agentOf(me);
    const limits = { minWei: 1n, maxWei: 10n ** 18n, perAgent: 1, makePerDayMax: 3, makeDaily: 50, materialMaxWei: 0n, priceGraceMinutes: 30 };
    expect(listProduct({ agentId: a, wallet: me, siteId: pageFor(a, `w:${me}`), ...body({}) }, limits).ok).toBe(true);
    expect(listProduct({ agentId: a, wallet: me, siteId: pageFor(a, `w:${me}`), ...body({}) }, limits)).toEqual({ ok: false, why: "An agent can have 1 products on sale at once. Take one down first." });
  });

  it("changes the price, remembering the one before for a short while, and takes it down", () => {
    const me = wallet(), a = agentOf(me), id = pageFor(a, `w:${me}`);
    const p = (listProduct({ agentId: a, wallet: me, siteId: id, ...body({}) }) as { product: { productId: string } }).product;
    expect(changeProduct(p.productId, wallet(), { price: "0.02" })).toEqual({ ok: false, why: "There is no such product of yours." });
    expect(changeProduct(p.productId, me, { price: "9" })).toEqual({ ok: false, why: "The highest price is 1 ETH." });
    const c = changeProduct(p.productId, me, { price: "0.02", title: "Tip and split" });
    expect(c.ok && c.product).toMatchObject({ title: "Tip and split", priceWei: 20_000_000_000_000_000n, prevPriceWei: 10_000_000_000_000_000n, priceChangedAt: expect.any(String) });
    // words only: the price stays, and so does the one before it
    expect(changeProduct(p.productId, me, { description: "Tips, split three ways or more." }).ok).toBe(true);
    expect(getProduct(p.productId)!.prevPriceWei).toBe(10_000_000_000_000_000n);
    expect(takeDown(p.productId, wallet()).ok).toBe(false);
    expect(takeDown(p.productId, me).ok).toBe(true);
    expect(availability(getProduct(p.productId)!)).toEqual({ ok: false, why: "This product was taken off sale." });
    expect(changeProduct(p.productId, me, { price: "0.03" }).ok).toBe(false);
    expect(productsOfAgent(a)).toEqual([]);
    expect(productsOfAgent(a, { all: true })).toHaveLength(1);
    // and the page can go up for sale again
    expect(listablePages(a, me).map((s) => s.siteId)).toEqual([id]);
  });

  it("goes off sale with its page when the page is taken down", () => {
    const me = wallet(), a = agentOf(me), id = pageFor(a, `w:${me}`);
    const p = (listProduct({ agentId: a, wallet: me, siteId: id, ...body({}) }) as { product: { productId: string } }).product;
    hideSite(id, "reported by 3 people");
    expect(availability(getProduct(p.productId)!)).toEqual({ ok: false, why: "This product's page was taken down, so it is not for sale." });
    expect(productsOfAgent(a)).toEqual([]);
  });
});

describe("the routes", () => {
  const req = (url: string, o: { method?: string; key?: string; body?: unknown } = {}) =>
    new NextRequest(`http://localhost${url}`, { method: o.method ?? "GET", headers: { ...(o.key ? { authorization: `Bearer ${o.key}` } : {}), "content-type": "application/json" }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });

  it("list, change and take down for the owner's key only", async () => {
    const me = wallet(), a = agentOf(me), id = pageFor(a, `w:${me}`);
    const { apiKey } = createApiKey(me, {});
    const { apiKey: stranger } = createApiKey(wallet(), {});
    expect((await listRoute(req("/api/shop/products", { method: "POST", body: { agentId: a, siteId: id, ...body({}) } }))).status).toBe(401);
    expect((await listRoute(req("/api/shop/products", { method: "POST", key: stranger, body: { agentId: a, siteId: id, ...body({}) } }))).status).toBe(403);
    const made = await listRoute(req("/api/shop/products", { method: "POST", key: apiKey, body: { agentId: a, siteId: id, ...body({}) } }));
    expect(made.status).toBe(201);
    const { product } = (await made.json()) as { product: { productId: string; price: string; preview: string } };
    expect(product.price).toBe("0.01 ETH");
    expect(product.preview).toMatch(new RegExp(`/s/${id}\\?v=1$`));
    const ctx = { params: Promise.resolve({ productId: product.productId }) };
    expect((await oneRoute(req(`/api/shop/products/${product.productId}`), ctx)).status).toBe(200);
    expect((await changeRoute(req(`/api/shop/products/${product.productId}`, { method: "PATCH", key: stranger, body: { price: "0.02" } }), ctx)).status).toBe(404);
    const changed = await changeRoute(req(`/api/shop/products/${product.productId}`, { method: "PATCH", key: apiKey, body: { price: "0.02" } }), ctx);
    expect(((await changed.json()) as { product: { price: string } }).product.price).toBe("0.02 ETH");
    const owner = await ownerRoute(req(`/api/shop/agents/${a}`, { key: apiKey }), { params: Promise.resolve({ agentId: a }) });
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { products: { onSale: boolean }[] }).products).toEqual([expect.objectContaining({ onSale: true })]);
    expect((await ownerRoute(req(`/api/shop/agents/${a}`, { key: stranger }), { params: Promise.resolve({ agentId: a }) })).status).toBe(403);
    expect((await downRoute(req(`/api/shop/products/${product.productId}`, { method: "DELETE", key: apiKey }), ctx)).status).toBe(200);
    expect(getProduct(product.productId)!.status).toBe("down");
  });

  it("are not there while the shop is off", async () => {
    process.env.AGENT_SHOP = "off";
    const me = wallet(), a = agentOf(me), id = pageFor(a, `w:${me}`);
    const { apiKey } = createApiKey(me, {});
    expect((await listRoute(req("/api/shop/products", { method: "POST", key: apiKey, body: { agentId: a, siteId: id, ...body({}) } }))).status).toBe(404);
    expect((await ownerRoute(req(`/api/shop/agents/${a}`, { key: apiKey }), { params: Promise.resolve({ agentId: a }) })).status).toBe(404);
    expect(formatEth(0n)).toBe("0 ETH");
  });
});
