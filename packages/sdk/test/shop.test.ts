// Agents that sell what they make, from the SDK (1.5.0): finding products, buying one with a payer or with a payment
// already sent, taking the files, and an owner's shop. Driven against a mocked fetch: what is checked is the request
// each call makes. No network, no chain.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxonClient } from "../src/client";
import type { X402PaymentOption, X402Requirements } from "../src/types";

function resp(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body, arrayBuffer: async () => new Uint8Array([80, 75, 3, 4]).buffer } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: AxonClient;
type Sent = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
const sent = (i = fetchMock.mock.calls.length - 1): Sent => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, method: String(init.method ?? "GET"), headers: init.headers as Record<string, string>, body: typeof init.body === "string" ? JSON.parse(init.body) : null };
};

const PRODUCT = { productId: "prod_1", agentId: "maker", agentName: "Maker", title: "Tip calculator", description: "Splits the bill.", price: "0.002 ETH", priceWei: "2000000000000000", sold: 3, madeByAgent: false, version: 1, fingerprint: "f".repeat(64), preview: "https://x/s/abc?v=1", available: true, listedAt: "2026-10-15T00:00:00.000Z" };
const PAYMENT = { payTo: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", amount: "0.002 ETH", amountWei: "2000000000000000", currency: "ETH", chainId: 4663, then: "POST /api/shop/products/prod_1/buy" };

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  client = new AxonClient();
  client.init({ endpoint: "https://x", retryBaseMs: 0, maxRetries: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("finding products", () => {
  it("asks for what is for sale, with the search, the order and the agent", async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { products: [PRODUCT] }));
    expect(await client.listProducts({ query: "tip", sort: "price", agentId: "maker", limit: 5 })).toEqual([PRODUCT]);
    expect(sent()).toMatchObject({ url: "https://x/api/shop/products?q=tip&sort=price&agent=maker&limit=5", method: "GET" });
    fetchMock.mockResolvedValueOnce(resp(200, { products: [] }));
    await client.listProducts();
    expect(sent().url).toBe("https://x/api/shop/products");
  });
});

describe("buying", () => {
  it("with a payer: pays exactly the amount the product asks, to its address, then hands over the hash", async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { product: PRODUCT, payment: PAYMENT })).mockResolvedValueOnce(resp(201, { saleId: "sale_1", claimToken: "tok", receipt: {}, receiptUrl: "https://x/r/sale_1" }));
    const pay = vi.fn(async (req: X402Requirements, option: X402PaymentOption) => {
      expect(req.accepts).toEqual([option]);
      return { signature: "0xhash", from: "0xbuyer" };
    });
    const bought = await client.buyProduct("prod_1", { pay });
    expect(bought).toMatchObject({ saleId: "sale_1", claimToken: "tok" });
    const option = pay.mock.calls[0][1];
    // the exact unit, never a decimal read as money
    expect(option).toMatchObject({ maxAmountRequired: "2000000000000000", payToAddress: PAYMENT.payTo, asset: "ETH", network: "eip155:4663" });
    expect(sent(1)).toMatchObject({ url: "https://x/api/shop/products/prod_1/buy", method: "POST", body: { paymentSignature: "0xhash", payerWallet: "0xbuyer", quotedWei: "2000000000000000" } });
  });

  it("with a payer, pays nothing for a product that is not for sale", async () => {
    fetchMock.mockResolvedValueOnce(resp(200, { product: { ...PRODUCT, available: false } }));
    const pay = vi.fn();
    await expect(client.buyProduct("prod_1", { pay })).rejects.toThrow("Tip calculator is not for sale right now");
    expect(pay).not.toHaveBeenCalled();
  });

  it("with a payment already sent, and a refused one surfaces as the server said it", async () => {
    fetchMock.mockResolvedValueOnce(resp(402, { error: "The payment was not enough or not found.", code: "PAYMENT_FAILED" }));
    await expect(client.buyProduct("prod_1", { paymentSignature: "0xhash", payerWallet: "0xbuyer" })).rejects.toMatchObject({ status: 402 });
    expect(sent().body).toEqual({ paymentSignature: "0xhash", payerWallet: "0xbuyer" });
  });

  it("opens the files and the receipt again with the purchase's key", async () => {
    fetchMock.mockResolvedValueOnce(resp(200));
    const zip = await client.downloadPurchase("sale_1", { claimToken: "tok" });
    expect(zip[0]).toBe(80);
    expect(sent()).toMatchObject({ url: "https://x/api/shop/sales/sale_1/zip", headers: { "X-Claim-Token": "tok" } });
    fetchMock.mockResolvedValueOnce(resp(200, { receipt: { saleId: "sale_1" }, files: "https://x/api/shop/sales/sale_1/zip" }));
    expect((await client.getPurchase("sale_1", { claimToken: "tok" })).files).toMatch(/zip$/);
  });
});

describe("an owner's shop", () => {
  it("lists, changes, takes down and sets what the agent does by itself, with the client's key", async () => {
    client.init({ endpoint: "https://x", apiKey: "axon_k", retryBaseMs: 0, maxRetries: 0 });
    fetchMock.mockResolvedValue(resp(200, { product: PRODUCT, settings: { make: {}, buy: {} }, purchases: [] }));
    await client.listProduct({ agentId: "maker", siteId: "site1", description: "Splits the bill.", price: "0.002" });
    expect(sent()).toMatchObject({ url: "https://x/api/shop/products", method: "POST", headers: { Authorization: "Bearer axon_k" }, body: { agentId: "maker", siteId: "site1", price: "0.002" } });
    await client.updateProduct("prod_1", { price: "0.003" });
    expect(sent()).toMatchObject({ url: "https://x/api/shop/products/prod_1", method: "PATCH", body: { price: "0.003" } });
    await client.takeDownProduct("prod_1");
    expect(sent()).toMatchObject({ url: "https://x/api/shop/products/prod_1", method: "DELETE" });
    await client.setShopSettings("maker", { buy: { on: true, maxEth: "0.001" } });
    expect(sent()).toMatchObject({ url: "https://x/api/shop/agents/maker", method: "PUT", body: { buy: { on: true, maxEth: "0.001" } } });
    await client.getShop("maker");
    expect(sent()).toMatchObject({ url: "https://x/api/shop/agents/maker", method: "GET" });
    await client.listPurchases();
    expect(sent()).toMatchObject({ url: "https://x/api/shop/purchases", method: "GET" });
  });
});
