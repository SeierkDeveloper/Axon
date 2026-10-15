// Agents that sell what they make: buying. A payment in ETH checked the way a paid hire's is, the files at once with a
// receipt that carries their fingerprint, and a refund on the record whenever a paid sale cannot be handed over. No
// chain is touched: payments are the test lane's stand-ins (AXON_PAYMENT_VERIFIER=mock).
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { addVersion, createSite, hideSite } from "@/lib/agentSites";
import { changeProduct, getProduct, getSale, listProduct, takeDown } from "@/lib/agentShop";
import { buyProduct, mayOpen, priceToPay, purchasesOf, saleFiles, saleReceipt } from "@/lib/shopSales";
import { claimTokenFor } from "@/lib/claimToken";
import { toWei } from "@/lib/money";
import { zipEntries, zipRead } from "@/lib/zip";
import { getAgentBalance } from "@/lib/payments";
import { POST as buyRoute } from "@/app/api/shop/products/[productId]/buy/route";
import { GET as productRoute } from "@/app/api/shop/products/[productId]/route";
import { GET as saleRoute } from "@/app/api/shop/sales/[saleId]/route";
import { GET as zipRoute } from "@/app/api/shop/sales/[saleId]/zip/route";
import { GET as purchasesRoute } from "@/app/api/shop/purchases/route";

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
const wallet = () => `0x${(++n + 7_300_000).toString(16).padStart(40, "0")}`;
const HTML = "<!doctype html><html><head><title>Tips</title></head><body><h1>Tip calculator</h1></body></html>";
const pay = (eth: string, signer: string) => `mockpay:ETH:${toWei(eth)}:${signer}:${RECEIVER}:${randomUUID().slice(0, 8)}`;

function onSale(price = "0.01"): { me: string; agentId: string; productId: string; siteId: string } {
  const me = wallet(), agentId = `buy-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId, name: "Page Maker", capabilities: ["build"], publicKey: `pk-${agentId}`, provider: "anthropic", reputation: 0, walletAddress: me, createdAt: new Date().toISOString() });
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId, ownerMark: `w:${me}`, title: "Tip Calculator" });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: HTML }, { path: "style.css", content: "h1{color:#111}" }], { taskId: "t" });
  const r = listProduct({ agentId, wallet: me, siteId: m.site.siteId, description: "Works out the tip and splits the bill.", price });
  if (!r.ok) throw new Error(r.why);
  return { me, agentId, productId: r.product.productId, siteId: m.site.siteId };
}
const ledger = (saleId: string) => getDb().prepare("SELECT from_agent, to_agent, amount_eth, status, incoming_signature FROM transactions WHERE task_id = ?").all(saleId) as { from_agent: string; to_agent: string; amount_eth: number; status: string; incoming_signature: string | null }[];

describe("buying a product", () => {
  it("checks the payment, hands over the files of the version sold, and pays the agent like a paid job", async () => {
    const s = onSale("0.01"), buyer = wallet();
    // a change to the page after it was listed is not what is sold
    addVersion(s.siteId, [{ path: "index.html", content: HTML.replace("Tip", "Changed") }], { taskId: "later" });
    const sig = pay("0.01", buyer);
    const r = await buyProduct({ productId: s.productId, paymentSignature: sig, payerWallet: buyer });
    expect(r.ok).toBe(true);
    const sale = r.ok ? r.sale : null!;
    expect(sale).toMatchObject({ status: "delivered", buyer, buyerKind: "wallet", agentId: s.agentId, version: 1, priceWei: 10_000_000_000_000_000n, paymentSignature: sig });
    expect(r.ok && r.claimToken).toBe(claimTokenFor(sale.saleId));
    expect(getProduct(s.productId)!.sold).toBe(1);
    // one escrow, settled to the agent: its earnings, exactly as a paid job's
    expect(ledger(sale.saleId)).toEqual([{ from_agent: buyer, to_agent: s.agentId, amount_eth: 0.01, status: "completed", incoming_signature: sig }]);
    expect(getAgentBalance(s.agentId)).toMatchObject({ totalEarned: 0.01, tasksPaid: 1 });
    // the files are the version that was sold, with its fingerprint in the note
    const zip = saleFiles(sale)!;
    const entries = zipEntries(zip.bytes)!;
    expect(zipRead(zip.bytes, entries, "tip-calculator/index.html", 1_000_000)!.toString()).toBe(HTML);
    expect(zipRead(zip.bytes, entries, "tip-calculator/README.txt", 1_000_000)!.toString()).toContain(`Fingerprint of this version: ${sale.sha256}`);
    // and the receipt says who bought what from whom, with the fingerprint and the payment
    expect(saleReceipt(sale.saleId)).toMatchObject({ status: "delivered", price: "0.01 ETH", product: { productId: s.productId, version: 1, fingerprint: sale.sha256 }, seller: { agentId: s.agentId, name: "Page Maker" }, buyer: { id: buyer, kind: "wallet" }, settlement: { amount: 0.01, status: "completed", signature: sig } });
    expect(purchasesOf(buyer).map((p) => p.saleId)).toEqual([sale.saleId]);
  });

  it("makes one sale of one payment: the same hash again gives back that sale, without its key", async () => {
    const s = onSale(), buyer = wallet(), sig = pay("0.01", buyer);
    const first = await buyProduct({ productId: s.productId, paymentSignature: sig, payerWallet: buyer });
    const again = await buyProduct({ productId: s.productId, paymentSignature: sig, payerWallet: buyer });
    expect(again).toMatchObject({ ok: true, replay: true, claimToken: null });
    expect(again.ok && first.ok && again.sale.saleId).toBe(first.ok && first.sale.saleId);
    expect(getProduct(s.productId)!.sold).toBe(1);
    // nor can it pay for something else
    const other = onSale();
    expect(await buyProduct({ productId: other.productId, paymentSignature: sig, payerWallet: buyer })).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a payment short of the price, and keeps nothing of it", async () => {
    const s = onSale("0.01"), buyer = wallet();
    const r = await buyProduct({ productId: s.productId, paymentSignature: pay("0.009", buyer), payerWallet: buyer });
    expect(r).toMatchObject({ ok: false, status: 402, code: "PAYMENT_FAILED" });
    expect(getDb().prepare("SELECT COUNT(*) n FROM shop_sales").get()).toEqual({ n: 0 });
    // and a payment someone else sent is not this buyer's
    expect(await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", wallet()), payerWallet: buyer })).toMatchObject({ ok: false, status: 402 });
  });

  it("refunds a payment for a product taken down while it was on its way, with the reason", async () => {
    const s = onSale(), buyer = wallet();
    takeDown(s.productId, s.me);
    const r = await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer });
    expect(r).toMatchObject({ ok: false, status: 410, why: "This product was taken off sale. The payment was refunded." });
    const sale = (r as { sale: { saleId: string } }).sale;
    expect(ledger(sale.saleId)).toEqual([expect.objectContaining({ status: "refunded" })]);
    expect(saleReceipt(sale.saleId)!.notes.map((x) => x.note)).toEqual(["Payment refunded to sender", "Not delivered: This product was taken off sale."]);
    expect(getAgentBalance(s.agentId).totalEarned).toBe(0);
    // a refunded sale opens no files, whatever key comes with it
    expect(mayOpen(getSale(sale.saleId)!, { claimToken: claimTokenFor(sale.saleId), wallet: buyer })).toBe(false);
  });

  it("refunds when the page was taken down after reports, or its files no longer pass the rules", async () => {
    const s = onSale(), buyer = wallet();
    hideSite(s.siteId, "reported by 3 people");
    expect(await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer })).toMatchObject({ ok: false, status: 410 });
    const t = onSale();
    getDb().prepare("UPDATE built_site_files SET content = ? WHERE site_id = ? AND path = 'index.html'").run(Buffer.from("<script>fetch('https://elsewhere.example')</script>"), t.siteId);
    const r = await buyProduct({ productId: t.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer });
    expect(r).toMatchObject({ ok: false, status: 410 });
    expect(!r.ok && r.why).toMatch(/breaks a rule for built pages: index\.html: it calls out over the network/);
  });

  it("refunds a second payment from a buyer who already has it", async () => {
    const s = onSale(), buyer = wallet();
    expect((await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer })).ok).toBe(true);
    const twice = await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer });
    expect(twice).toMatchObject({ ok: false, status: 410, why: "This buyer already has this product. The payment was refunded." });
    expect(getProduct(s.productId)!.sold).toBe(1);
    expect(getAgentBalance(s.agentId).totalEarned).toBe(0.01);
  });

  it("refunds when the files cannot be made after the payment", async () => {
    const s = onSale(), buyer = wallet();
    const r = await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer }, { make: () => null });
    expect(r).toMatchObject({ ok: false, status: 410, why: "The files could not be made. The payment was refunded." });
    expect(getAgentBalance(s.agentId).totalEarned).toBe(0);
  });

  it("says to send the same hash again when the payment cannot be checked just now", async () => {
    const s = onSale(), buyer = wallet();
    const flaky = async () => { const e = new Error("rpc timeout") as Error & { transient: boolean }; e.transient = true; throw e; };
    expect(await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer }, { pay: flaky })).toMatchObject({ ok: false, status: 503, code: "PAYMENT_UNAVAILABLE" });
  });

  it("honours the price shown for a short while after it changed, and only that price", async () => {
    const s = onSale("0.01"), buyer = wallet();
    changeProduct(s.productId, s.me, { price: "0.02" });
    const p = getProduct(s.productId)!;
    expect(priceToPay(p, "10000000000000000")).toBe(10_000_000_000_000_000n);
    expect(priceToPay(p, "5000000000000000")).toBe(20_000_000_000_000_000n);
    expect(priceToPay(p, "10000000000000000", undefined, Date.now() + 31 * 60_000)).toBe(20_000_000_000_000_000n);
    const r = await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", buyer), payerWallet: buyer, quotedWei: "10000000000000000" });
    expect(r.ok && r.sale.priceWei).toBe(10_000_000_000_000_000n);
    // without the quote, the price is the one shown now
    expect(await buyProduct({ productId: s.productId, paymentSignature: pay("0.01", wallet()), payerWallet: wallet() })).toMatchObject({ ok: false, status: 402 });
  });
});

describe("the routes", () => {
  const req = (url: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new NextRequest(`http://localhost${url}`, { method: o.method ?? "GET", headers: { "content-type": "application/json", ...(o.headers ?? {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });

  it("say how to pay, sell, and give the files to the buyer only", async () => {
    const s = onSale(), buyer = wallet();
    const shown = (await (await productRoute(req(`/api/shop/products/${s.productId}`), { params: Promise.resolve({ productId: s.productId }) })).json()) as { payment: { payTo: string; amount: string; amountWei: string; chainId: number } };
    expect(shown.payment).toMatchObject({ payTo: RECEIVER, amount: "0.01 ETH", amountWei: "10000000000000000", chainId: 4663 });

    const res = await buyRoute(req(`/api/shop/products/${s.productId}/buy`, { method: "POST", body: { paymentSignature: pay("0.01", buyer), payerWallet: buyer, quotedWei: "10000000000000000" } }), { params: Promise.resolve({ productId: s.productId }) });
    expect(res.status).toBe(201);
    const bought = (await res.json()) as { saleId: string; claimToken: string; files: string; receiptUrl: string };
    expect(bought.files).toMatch(new RegExp(`/api/shop/sales/${bought.saleId}/zip$`));
    expect(bought.receiptUrl).toMatch(new RegExp(`/r/${bought.saleId}$`));
    const ctx = { params: Promise.resolve({ saleId: bought.saleId }) };

    const withKey = await zipRoute(req(`/api/shop/sales/${bought.saleId}/zip`, { headers: { "x-claim-token": bought.claimToken } }), ctx);
    expect(withKey.status).toBe(200);
    expect(withKey.headers.get("content-type")).toBe("application/zip");
    expect((await zipRoute(req(`/api/shop/sales/${bought.saleId}/zip`, { headers: { "x-claim-token": "0".repeat(32) } }), ctx)).status).toBe(403);
    expect((await zipRoute(req(`/api/shop/sales/${bought.saleId}/zip`), ctx)).status).toBe(403);
    // the buyer's own wallet, signed in, opens it too; the seller's does not
    const { apiKey: buyerKey } = createApiKey(buyer, {});
    const { apiKey: sellerKey } = createApiKey(s.me, {});
    expect((await zipRoute(req(`/api/shop/sales/${bought.saleId}/zip`, { headers: { authorization: `Bearer ${buyerKey}` } }), ctx)).status).toBe(200);
    expect((await zipRoute(req(`/api/shop/sales/${bought.saleId}/zip`, { headers: { authorization: `Bearer ${sellerKey}` } }), ctx)).status).toBe(403);

    // the receipt is public; where the files are is said to the buyer alone
    const open = (await (await saleRoute(req(`/api/shop/sales/${bought.saleId}`), ctx)).json()) as { receipt: { status: string }; files?: string };
    expect(open.receipt.status).toBe("delivered");
    expect(open.files).toBeUndefined();
    expect(((await (await saleRoute(req(`/api/shop/sales/${bought.saleId}`, { headers: { "x-claim-token": bought.claimToken } }), ctx)).json()) as { files?: string }).files).toBeTruthy();

    const mine = (await (await purchasesRoute(req("/api/shop/purchases", { headers: { authorization: `Bearer ${buyerKey}` } }))).json()) as { purchases: { saleId: string; files?: string }[] };
    expect(mine.purchases).toEqual([expect.objectContaining({ saleId: bought.saleId, files: expect.any(String) })]);
  });

  it("answer a refused payment in words, and are not there while the shop is off", async () => {
    const s = onSale(), buyer = wallet();
    const short = await buyRoute(req(`/api/shop/products/${s.productId}/buy`, { method: "POST", body: { paymentSignature: pay("0.001", buyer), payerWallet: buyer } }), { params: Promise.resolve({ productId: s.productId }) });
    expect(short.status).toBe(402);
    expect(((await short.json()) as { error: string }).error).toMatch(/^The payment was not enough or not found\. 0\.01 ETH must be sent from 0x/);
    process.env.AGENT_SHOP = "off";
    expect((await buyRoute(req(`/api/shop/products/${s.productId}/buy`, { method: "POST", body: {} }), { params: Promise.resolve({ productId: s.productId }) })).status).toBe(404);
  });
});
