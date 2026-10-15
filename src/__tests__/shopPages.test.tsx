// Agents that sell what they make, as the pages show it: the products on an agent's page for a visitor and for its
// owner, the marketplace's For sale view, and a sale's receipt. Rendered to static markup, with the wallet stubbed.

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

const wallet = { address: null as string | null, apiKey: null as string | null, signIn: vi.fn(), busy: false };
vi.mock("@/components/WalletProvider", () => ({ useWallet: () => wallet }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { default: AgentShop } = await import("@/app/agents/[agentId]/AgentShop");
const { ForSale } = await import("@/app/agents/ForSale");
const { SaleReceiptBody, MaterialsBought } = await import("@/app/r/[taskId]/SaleReceipt");

const OWNER = "0x00000000000000000000000000000000000000aa";
const product = { productId: "prod_1", title: "Tip calculator", description: "Splits a bill fairly.", price: "0.002 ETH", priceWei: "2000000000000000", sold: 3, madeByAgent: true, preview: "/s/abc?v=1", fingerprint: "f".repeat(64) };
const shop = (o: Partial<{ products: typeof product[]; receiver: string }> = {}) =>
  renderToStaticMarkup(<AgentShop agentId="maker" agentName="Maker" ownerWallet={OWNER} products={o.products ?? [product]} receiver={o.receiver ?? "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"} rpcUrl="" />);

describe("the shop on an agent's page", () => {
  it("shows a visitor each product, its live page, a way to buy and a way to report", () => {
    wallet.address = null; wallet.apiKey = null;
    const html = shop();
    expect(html).toContain("For sale");
    expect(html).toContain("Tip calculator");
    expect(html).toContain("0.002 ETH");
    expect(html).toContain("3 sold · made by Maker on its own");
    expect(html).toContain('href="/s/abc?v=1"');
    expect(html).toContain("Buy for 0.002 ETH");
    expect(html).toContain("Report");
    expect(html).toContain("You get the page&#x27;s files to keep and host anywhere");
    expect(html).not.toContain("Sign in to manage your shop");
    expect(html).not.toMatch(/[—–]/);
  });

  it("shows nothing at all to a visitor when nothing is for sale, and offers no Buy without a receiving wallet", () => {
    wallet.address = null;
    expect(shop({ products: [] })).toBe("");
    expect(shop({ receiver: "" })).not.toContain("Buy for");
  });

  it("gives the owner the way in to manage it, and never a Buy or Report of their own product", () => {
    wallet.address = OWNER.toUpperCase().replace("0X", "0x"); wallet.apiKey = null;
    const html = shop({ products: [product] });
    expect(html).toContain("Sign in to manage your shop");
    expect(html).not.toContain("Buy for");
    expect(html).not.toContain(">Report<");
    // with nothing for sale yet, the owner still sees the shop
    expect(shop({ products: [] })).toContain("Nothing for sale yet.");
  });
});

describe("the marketplace's For sale view", () => {
  it("lists products with their agent, the order to sort by and a search", () => {
    const html = renderToStaticMarkup(<ForSale products={[{ ...product, agentId: "maker", agentName: "Maker", madeByAgent: false, version: 1, available: true, listedAt: "2026-10-15T00:00:00Z" }]} sort="price" q="tip" />);
    expect(html).toContain('href="/agents/maker#product-prod_1"');
    expect(html).toContain("Lowest price");
    expect(html).toContain('href="/agents?view=sale&amp;sort=sold&amp;q=tip"');
    expect(html).toContain('value="tip"');
    expect(renderToStaticMarkup(<ForSale products={[]} sort="newest" q="" />)).toContain("Nothing is for sale yet.");
    expect(renderToStaticMarkup(<ForSale products={[]} sort="newest" q="zz" />)).toContain("Nothing for sale matches that.");
  });
});

describe("a sale's receipt", () => {
  it("says who bought what from whom, the fingerprint, the payment, and the job it was material for", () => {
    const html = renderToStaticMarkup(<SaleReceiptBody r={{
      saleId: "sale_1", status: "delivered", product: { productId: "prod_1", title: "Tip calculator", version: 2, fingerprint: "a".repeat(64) },
      seller: { agentId: "maker", name: "Maker" }, buyer: { id: "builder", kind: "agent", name: "Builder" }, forTaskId: "task-9", price: "0.002 ETH", priceWei: "2000000000000000",
      settlement: { amount: 0.002, currency: "ETH", status: "completed", signature: null, settledAt: "2026-10-15T00:00:00Z" }, notes: [], createdAt: "2026-10-15T00:00:00Z", deliveredAt: "2026-10-15T00:00:01Z",
    }} />);
    expect(html).toContain("Bought by");
    expect(html).toContain("Builder");
    expect(html).toContain("What was sold: version 2");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain('href="/r/task-9"');
    expect(html).toContain("paid from the agent&#x27;s balance");
    const job = renderToStaticMarkup(<MaterialsBought materials={[{ saleId: "sale_1", title: "Tip calculator", seller: { agentId: "maker", name: "Maker" }, price: "0.002 ETH", fingerprint: "b".repeat(64), status: "delivered" }]} />);
    expect(job).toContain("Material bought");
    expect(job).toContain('href="/r/sale_1"');
    expect(job).toContain("from Maker · 0.002 ETH");
  });
});
