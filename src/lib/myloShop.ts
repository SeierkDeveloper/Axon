// Agents that sell what they make, through Mylo.
//
// What a person can do in the shop on an agent's page they can ask Mylo about: what their agents sell and what could
// go up for sale, putting a page their agent built for them up for sale, finding a product to buy, and what they
// bought. Mylo never pays: buying is done by the person, on the product's agent page, from their own wallet. Listing
// spends nothing and is the person's own to take down, so Mylo does it when they say so, with their price.
//
// Nothing here is offered while AGENT_SHOP is off.

import { getDb } from "./db";
import { getAgentById } from "./agents";
import { availability, getProduct, listablePages, listProduct, productView, productsForSale, productsOfAgent, shopAgentOf, shopEnabled, shopLimits } from "./agentShop";
import { purchasesOf, saleReceipt, salesOfOwner } from "./shopSales";
import { formatEth } from "./money";

type Input = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The tools this adds, as the model sees them. */
export function myloShopTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  if (!shopEnabled()) return [];
  const limits = shopLimits();
  return [
    { name: "my_products", description: "What the person's own agents sell: every product with its price and how often it sold, the pages each agent built for them that could go up for sale (with their site_id), what each agent sold lately, and whether an agent makes products on its own.", input_schema: { type: "object", properties: { agent_id: { type: "string", description: "Only this agent of theirs" } } } },
    { name: "list_product", description: `Put a page one of the person's agents built for them up for sale, when they ask for that. Needs the agent, the page's site_id from my_products, a sentence about what it is, and the price they chose in ETH (${formatEth(limits.minWei)} to ${formatEth(limits.maxWei)}). Never pick a price for them: ask. They can change it or take it down on the agent's page.`, input_schema: { type: "object", properties: { agent_id: { type: "string" }, site_id: { type: "string" }, title: { type: "string", description: "Optional: a title of a few words; the page's own title otherwise" }, description: { type: "string" }, price_eth: { type: "string", description: "The price in ETH, as they said it, for example 0.01" } }, required: ["agent_id", "site_id", "description", "price_eth"] } },
    { name: "buy_product", description: "Find products agents sell, or one product by its product_id, with its price and the page where the person buys it. You never buy: the person pays from their own wallet on that page, and gets the files right away.", input_schema: { type: "object", properties: { product_id: { type: "string" }, query: { type: "string", description: "What they are looking for, in a few words" } } } },
    { name: "my_purchases", description: "What the person bought in the shop: each product, from which agent, for how much, its receipt, and where to take the files again.", input_schema: { type: "object", properties: {} } },
  ];
}

export const MYLO_SHOP_LABELS: Record<string, string> = { my_products: "Looking at your shop", list_product: "Putting it up for sale", buy_product: "Looking at what is for sale", my_purchases: "Looking at what you bought" };

/** Added to Mylo's instructions while the shop is on. */
export function myloShopNote(): string {
  if (!shopEnabled()) return "";
  return `\n\nAgents that sell what they make:
- An agent's owner can sell a page or small app the agent built for them: a buyer pays the price in ETH on the agent's
  page and gets the files at once, with a receipt that carries their fingerprint. A sale is the agent's earnings, like
  a paid job, and is withdrawn the same way. my_products shows what their agents sell and what could go up for sale;
  list_product puts one up when they ask, at the price they chose. Only a page the agent built for them can be sold.
- buy_product finds what is for sale and gives the page where they buy it. You never pay and never say something was
  bought: they buy it themselves on that page. my_purchases lists what they bought.
- On an agent's page its owner can also let it make and list products on its own, on a schedule, and let it buy other
  agents' products as material for its paid jobs. You cannot switch these on from here; point them to the agent's page.`;
}

/** Their agents: the ones their wallet owns. */
const agentsOf = (wallet: string): string[] =>
  (getDb().prepare("SELECT agent_id FROM agents WHERE LOWER(wallet_address) = ? ORDER BY created_at DESC LIMIT 30").all(wallet.toLowerCase()) as { agent_id: string }[]).map((r) => r.agent_id);

/** Run one of the tools above. Undefined for a name that is not one of them, or while the shop is off. */
export function runMyloShopTool(name: string, input: Input, ctx: { wallet: string | null }): unknown | undefined {
  if (!shopEnabled() || !(name in MYLO_SHOP_LABELS)) return undefined;
  if (name === "buy_product") {
    const id = text(input.product_id);
    const one = id ? getProduct(id) : null;
    const found = id ? (one && availability(one).ok ? [one] : []) : productsForSale({ q: text(input.query), limit: 8 });
    if (!found.length) return { error: id ? "That product is not for sale." : "Nothing for sale matches that." };
    return { products: found.map((p) => { const v = productView(p); return { product_id: v.productId, title: v.title, what: v.description, price: v.price, sold: v.sold, agent: v.agentName, made_by_the_agent_on_its_own: v.madeByAgent, look_at_it: v.preview, buy_it_here: `/agents/${encodeURIComponent(v.agentId)}#product-${v.productId}` }; }), note: "They buy it on that page, from their own wallet. Never say it is bought." };
  }
  if (!ctx.wallet) return { error: "Sign in with your wallet first." };
  const me = ctx.wallet.toLowerCase();
  if (name === "my_purchases") {
    const list = purchasesOf(me, 20).map((s) => saleReceipt(s.saleId)!);
    return { purchases: list.map((r) => ({ title: r.product.title, from: r.seller.name ?? r.seller.agentId, price: r.price, status: r.status, at: r.createdAt, receipt: `/r/${r.saleId}`, files: r.status === "delivered" ? `/agents/${encodeURIComponent(r.seller.agentId)}#product-${r.product.productId}` : null })), note: list.length ? "The files can be taken again on the product's page, signed in with this wallet." : "They have bought nothing yet." };
  }
  if (name === "list_product") {
    const r = listProduct({ agentId: text(input.agent_id), wallet: me, siteId: text(input.site_id), title: input.title, description: input.description, price: text(input.price_eth) });
    if (!r.ok) return { error: r.why };
    const v = productView(r.product);
    return { listed: { product_id: v.productId, title: v.title, price: v.price, page: `/agents/${encodeURIComponent(v.agentId)}#product-${v.productId}` }, note: "It is on sale now. They can change the price or take it down on the agent's page." };
  }
  // my_products
  const only = text(input.agent_id);
  const mine = agentsOf(me).filter((a) => !only || a === only);
  const sold = salesOfOwner(me, 5);
  return {
    agents: mine.map((agentId) => {
      const s = shopAgentOf(agentId);
      return {
        agent_id: agentId, name: getAgentById(agentId)?.name ?? agentId,
        products: productsOfAgent(agentId, { all: true, limit: 20 }).map((p) => ({ product_id: p.productId, title: p.title, price: formatEth(p.priceWei), sold: p.sold, on_sale: p.status === "listed", made_by_the_agent_on_its_own: p.madeBy === "agent" })),
        could_go_up_for_sale: listablePages(agentId, me, 10).map((pg) => ({ site_id: pg.siteId, title: pg.title })),
        sold_so_far: sold.agents.find((x) => x.agentId === agentId) ?? null,
        makes_products_on_its_own: s?.make.on ? { what: s.make.kind, every_hours: s.make.everyHours, price: s.make.priceWei !== null ? formatEth(s.make.priceWei) : null } : false,
      };
    }),
    latest_sales: sold.recent.map((x) => ({ title: x.title, price: x.price, at: x.at, receipt: `/r/${x.saleId}` })),
    note: mine.length ? undefined : "They have no agents of their own yet.",
  };
}
