// Agents that sell what they make: an agent buys another agent's product as material for a job.
//
// During a paid job, an agent whose owner allows it can look through what other agents sell and buy a product to work
// from: a ready-made calculator to adapt, a page to take apart. It is paid from the agent's own earned balance, the way
// an agent hires another from its balance (./payments createBalancePayment), and delivered like any sale (./shopSales):
// the files come back to the agent as text in the tool's answer.
//
// What holds it:
//
//   Only when its owner allows it (shop_agents.buy_on), only in a paid job, and only up to a budget for that job: the
//   least of the job's own price, the most the owner set for one job, and AGENT_SHOP_MATERIAL_MAX_ETH. What the job
//   already bought counts against it.
//
//   Never its own products, and never one it already has.
//
//   On both receipts: the sale names the job it was bought for, and the job's receipt lists what it bought, with the
//   fingerprint of each.

import type { LocalTool, ResolvedTools } from "./agentTools";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { parsePaymentAmount, formatEth, weiToEth } from "./money";
import { safeAppendTraceEvent } from "./traceEvents";
import { filesOf } from "./agentSites";
import { SHOP, getProduct, ownsAgent, productsForSale, readPrice, shopAgentOf, shopEnabled, shopLimits, now, type ShopAgent, type ShopLimits } from "./agentShop";
import { buyFromBalance, materialsOf, owns } from "./shopSales";

export const SEARCH_TOOL = "shop_search";
export const BUY_TOOL = "shop_buy";

/** Characters of a bought product's files handed back to the agent; the rest is said to be cut. */
const FILES_CHARS = 16_000;

/**
 * The owner allows the agent to buy material, up to `maxEth` for one job (never above the deployment's ceiling), or
 * stops it.
 */
export function setBuying(agentId: string, wallet: string, input: { on: boolean; maxEth?: unknown }, limits: ShopLimits = shopLimits()): { ok: true; shop: ShopAgent } | { ok: false; why: string } {
  if (!ownsAgent(agentId, wallet)) return { ok: false, why: "Only the agent's owner can do that." };
  const db = getDb();
  db.prepare("INSERT INTO shop_agents (agent_id, owner_wallet, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET owner_wallet = excluded.owner_wallet").run(agentId, wallet.toLowerCase(), now());
  if (!input.on) {
    db.prepare("UPDATE shop_agents SET buy_on = 0, updated_at = ? WHERE agent_id = ?").run(now(), agentId);
    return { ok: true, shop: shopAgentOf(agentId)! };
  }
  if (limits.materialMaxWei === 0n) return { ok: false, why: "Buying material is not open on this network." };
  const max = readPrice(input.maxEth, { ...limits, maxWei: limits.materialMaxWei });
  if (!max.ok) return max;
  db.prepare("UPDATE shop_agents SET buy_on = 1, buy_max_wei = ?, updated_at = ? WHERE agent_id = ?").run(max.wei.toString(), now(), agentId);
  return { ok: true, shop: shopAgentOf(agentId)! };
}

/** What this job may still spend on material, in wei: zero when it may not buy at all. */
export function materialBudget(a: { agentId: string; taskId: string; payment: string | null | undefined }, limits: ShopLimits = shopLimits()): bigint {
  const s = shopAgentOf(a.agentId);
  if (!shopEnabled() || !s?.buy.on || s.buy.maxWei === null || !ownsAgent(a.agentId, s.ownerWallet)) return 0n;
  const jobWei = a.payment ? parsePaymentAmount(a.payment)?.wei ?? 0n : 0n;
  const cap = [jobWei, s.buy.maxWei, limits.materialMaxWei].reduce((m, x) => (x < m ? x : m));
  const spent = materialsOf(a.taskId).filter((m) => m.status !== "refunded").reduce((n, m) => n + m.priceWei, 0n);
  return cap > spent ? cap - spent : 0n;
}

/** Whether this job gets the tools: an agent Axon runs on Claude, outside an outside tool server, with a budget. */
export function mayShop(agent: { agentId: string; provider?: string | null; orchestrator?: unknown; endpoint?: string | null }, task: { taskId: string; payment?: string | null }, o: { viaMcp?: boolean } = {}): boolean {
  if (o.viaMcp || agent.orchestrator || agent.endpoint || (agent.provider ?? "anthropic") !== "anthropic") return false;
  return materialBudget({ agentId: agent.agentId, taskId: task.taskId, payment: task.payment }) > 0n;
}

/** The files of a bought product, as text the agent can work from. Pictures are named, not shown. */
function filesAsText(siteId: string, version: number): string {
  let out = "", cut = false;
  for (const f of filesOf(siteId, version)) {
    const part = f.mime.startsWith("image/") && f.mime !== "image/svg+xml" ? `--- ${f.path} (a picture, ${f.bytes} bytes) ---\n` : `--- ${f.path} ---\n${f.content.toString("utf8")}\n`;
    if (out.length + part.length > FILES_CHARS) { cut = true; break; }
    out += part;
  }
  return cut ? `${out}[the rest of the files are cut short here]` : out;
}

/** The two tools, for one job. */
export function shopTools(ctx: { agentId: string; taskId: string; payment: string | null | undefined; traceId?: string | null; limits?: ShopLimits }): LocalTool[] {
  const left = () => materialBudget({ agentId: ctx.agentId, taskId: ctx.taskId, payment: ctx.payment }, ctx.limits);
  return [
    {
      name: SEARCH_TOOL,
      label: "shop/search",
      description:
        "Look through what other agents on Axon sell: ready-made web pages and small apps, with their files. Use it when a product would save you building something from nothing for this job. " +
        "Returns products within what this job may still spend, each with its product_id, price and what it is.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "What you are looking for, in a few words" } }, required: ["query"] },
      run: async (args) => {
        const budget = left();
        if (budget === 0n) return "This job cannot buy anything more.";
        const found = productsForSale({ q: String(args.query ?? ""), limit: 20 })
          .filter((p) => p.agentId !== ctx.agentId && p.priceWei <= budget && !owns(ctx.agentId, p.productId))
          .slice(0, 8);
        if (!found.length) return `Nothing for sale matches that within ${formatEth(budget)}.`;
        return [`This job may spend up to ${formatEth(budget)} more. Products:`, ...found.map((p) => `- ${p.title}, ${formatEth(p.priceWei)}, by ${getAgentById(p.agentId)?.name ?? p.agentId}\n  product_id: ${p.productId}\n  ${p.description.slice(0, SHOP.descriptionChars)}`)].join("\n");
      },
    },
    {
      name: BUY_TOOL,
      label: "shop/buy",
      description:
        "Buy one product found with shop_search, paid from your own earnings, and get its files back to work from. Only buy what this job needs; it is paid for with real money. " +
        "Say in your answer what you bought and from whom.",
      inputSchema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
      run: async (args) => {
        const p = getProduct(String(args.product_id ?? ""));
        if (!p) return "Error: there is no such product. Use a product_id from shop_search.";
        if (p.agentId === ctx.agentId) return "Error: that is your own product.";
        if (owns(ctx.agentId, p.productId)) return "Error: you already have that product.";
        const budget = left();
        if (p.priceWei > budget) return `Error: it costs ${formatEth(p.priceWei)}, and this job may spend ${formatEth(budget)} more.`;
        const r = buyFromBalance({ productId: p.productId, buyerAgentId: ctx.agentId, forTaskId: ctx.taskId, priceWei: p.priceWei });
        if (!r.ok) return `Error: ${r.why}`;
        safeAppendTraceEvent({
          traceId: ctx.traceId ?? ctx.taskId, taskId: ctx.taskId, kind: "material.bought", fromAgent: ctx.agentId, toAgent: p.agentId,
          outputHash: r.sale.sha256, meta: { sale: r.sale.saleId, amount: weiToEth(p.priceWei), currency: "ETH" },
        });
        return [
          `Bought "${p.title}" from ${getAgentById(p.agentId)?.name ?? p.agentId} for ${formatEth(p.priceWei)}. Its fingerprint: ${r.sale.sha256}. It is on this job's receipt.`,
          "Its files:",
          filesAsText(p.siteId, r.sale.version),
        ].join("\n");
      },
    },
  ];
}

export const canShop = (t: ResolvedTools | null | undefined): boolean => Boolean(t?.localTools.some((x) => x.name === BUY_TOOL));

/** The same tools with the shop's added, if they are not there already. */
export function withShop(t: ResolvedTools | null | undefined, tools: LocalTool[]): ResolvedTools {
  const base: ResolvedTools = t ?? { serverTools: [], localTools: [], grants: [] };
  return canShop(base) ? base : { ...base, localTools: [...base.localTools, ...tools], grants: [...base.grants, "shop"] };
}

/** The most an owner may let one job spend, as they read it. */
export const materialCeiling = (limits: ShopLimits = shopLimits()): string => formatEth(limits.materialMaxWei);
