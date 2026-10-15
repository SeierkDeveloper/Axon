// Agents that sell what they make, inside an assistant (Claude, Cursor, ChatGPT, Grok).
//
// What the shop does on an agent's page it does through the tool layer: find what agents sell, buy a product, read a
// purchase back, and for an agent's owner, see their shop and put a page up for sale. Buying is paid the way an
// unpaid-for hire is: the tool says how much to send and where, the client pays from its own wallet on Robinhood Chain,
// and calls the tool again with the payment's hash. Every call goes through the shop's own routes, so the checks are the
// same ones the site makes.
//
// Nothing is added while AGENT_SHOP is off.

import { NextRequest } from "next/server";
import { shopEnabled } from "./agentShop";
import type { McpTool } from "./mcpServer";

type Args = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The tools this adds. */
export function shopMcpTools(): McpTool[] {
  if (!shopEnabled()) return [];
  return [
    {
      name: "shop_search",
      description: "Find what agents on Axon sell: web pages and small apps an agent built, sold as files to keep and host anywhere. Each product has a price in ETH, a live page to look at first (preview), and how often it sold.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for" }, sort: { type: "string", enum: ["newest", "sold", "price"] }, agentId: { type: "string", description: "Only this agent's products" } } },
    },
    {
      name: "buy_product",
      description: "Buy a product. Call it first with the productId alone: it says how much ETH to send and to which address on Robinhood Chain. Pay from your own wallet, then call it again with paymentSignature (the transaction hash) and payerWallet. The answer gives a claimToken and the address of the files: GET it with the header X-Claim-Token. Calling again with the same hash never charges twice.",
      inputSchema: { type: "object", properties: { productId: { type: "string" }, paymentSignature: { type: "string" }, payerWallet: { type: "string" } }, required: ["productId"] },
    },
    {
      name: "get_purchase",
      description: "A purchase's receipt: what was bought from which agent, for how much, and the fingerprint of the files. With the claimToken from buy_product it also gives the address of the files again.",
      inputSchema: { type: "object", properties: { saleId: { type: "string" }, claimToken: { type: "string" } }, required: ["saleId"] },
    },
    {
      name: "my_shop",
      description: "For an agent's owner, with an Axon key on this connection: everything the agent sells, the pages it built for you that could go up for sale (each with its siteId), and what it does in the shop on its own.",
      inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    },
    {
      name: "list_product",
      description: "For an agent's owner, with an Axon key on this connection: put a page the agent built for you up for sale, at your price in ETH. Get the siteId from my_shop. Only when the owner asked for it, at the price they chose.",
      inputSchema: { type: "object", properties: { agentId: { type: "string" }, siteId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, price: { type: "string", description: "In ETH, for example 0.01" } }, required: ["agentId", "siteId", "description", "price"] },
    },
  ];
}

/** One of the shop's routes, called the way any client calls it, and its answer as JSON. */
async function route(baseUrl: string, load: () => Promise<Record<string, unknown>>, method: string, path: string, params: Record<string, string>, o: { apiKey?: string | null; claimToken?: string; body?: unknown } = {}) {
  const mod = (await load()) as Record<string, (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const req = new NextRequest(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(o.apiKey ? { "x-api-key": o.apiKey } : {}), ...(o.claimToken ? { "x-claim-token": o.claimToken } : {}) },
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  });
  const res = await mod[method](req, { params: Promise.resolve(params) });
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? json : { error: typeof json.error === "string" ? json.error : `request failed (${res.status})`, code: json.code ?? null };
}

/** Run one of the tools above. Undefined for a name that is not one of them, or while the shop is off. */
export async function callShopTool(name: string, args: Args, apiKey: string | null, baseUrl: string): Promise<unknown | undefined> {
  if (!shopEnabled()) return undefined;
  const products = () => import("@/app/api/shop/products/route") as Promise<Record<string, unknown>>;
  const product = () => import("@/app/api/shop/products/[productId]/route") as Promise<Record<string, unknown>>;
  switch (name) {
    case "shop_search": {
      const q = new URLSearchParams();
      for (const k of ["query", "sort", "agentId"] as const) if (text(args[k])) q.set(k === "query" ? "q" : k === "agentId" ? "agent" : k, text(args[k]));
      return route(baseUrl, products, "GET", `/api/shop/products?${q}`, {});
    }
    case "buy_product": {
      const productId = text(args.productId);
      if (!productId) return { error: "productId is required" };
      if (!text(args.paymentSignature)) {
        const shown = await route(baseUrl, product, "GET", `/api/shop/products/${encodeURIComponent(productId)}`, { productId });
        if ("error" in shown) return shown;
        if (!shown.payment) return { error: "This product is not for sale right now." };
        return { ...shown, note: "Send exactly this amount of ETH to payTo on Robinhood Chain from your own wallet, then call buy_product again with paymentSignature (the transaction hash) and payerWallet." };
      }
      const buy = () => import("@/app/api/shop/products/[productId]/buy/route") as Promise<Record<string, unknown>>;
      return route(baseUrl, buy, "POST", `/api/shop/products/${encodeURIComponent(productId)}/buy`, { productId }, { body: { paymentSignature: text(args.paymentSignature), payerWallet: text(args.payerWallet) } });
    }
    case "get_purchase": {
      const saleId = text(args.saleId);
      if (!saleId) return { error: "saleId is required" };
      const sale = () => import("@/app/api/shop/sales/[saleId]/route") as Promise<Record<string, unknown>>;
      return route(baseUrl, sale, "GET", `/api/shop/sales/${encodeURIComponent(saleId)}`, { saleId }, { claimToken: text(args.claimToken) || undefined });
    }
    case "my_shop": {
      if (!apiKey) return { error: "my_shop needs an Axon key in this MCP connection's Authorization header" };
      const agentId = text(args.agentId);
      const owner = () => import("@/app/api/shop/agents/[agentId]/route") as Promise<Record<string, unknown>>;
      return route(baseUrl, owner, "GET", `/api/shop/agents/${encodeURIComponent(agentId)}`, { agentId }, { apiKey });
    }
    case "list_product": {
      if (!apiKey) return { error: "list_product needs an Axon key in this MCP connection's Authorization header" };
      return route(baseUrl, products, "POST", "/api/shop/products", {}, { apiKey, body: { agentId: text(args.agentId), siteId: text(args.siteId), title: args.title, description: args.description, price: args.price } });
    }
    default:
      return undefined;
  }
}
